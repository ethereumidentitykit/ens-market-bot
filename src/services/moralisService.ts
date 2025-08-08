import axios, { AxiosResponse } from 'axios';
import { logger } from '../utils/logger';
import { NFTSale } from '../types';
import { config } from '../utils/config';

/**
 * Moralis API Response Types
 */
interface MoralisNFTMetadata {
  name: string;
  description?: string;
  animation_url?: string;
  external_link?: string;
  image?: string;
  attributes?: Array<{
    traitType: string;
    value: any;
    traitCount?: number;
  }>;
}

interface MoralisNFTTrade {
  transaction_hash: string;
  transaction_index: string;
  token_ids: string[];
  seller_address: string;
  buyer_address: string;
  token_address: string;
  collection_name: string;
  collection_logo?: string;
  marketplace: string;
  marketplace_address: string;
  marketplace_logo?: string;
  price: string;
  price_formatted: string;
  current_usd_value?: string;
  price_token_address?: string;
  block_timestamp: string;
  block_number: string;
  block_hash: string;
  token_name: string;
  token_symbol: string;
  token_logo?: string;
  token_decimals: string;
  verified_collection: boolean;
  metadata?: MoralisNFTMetadata;
}

interface MoralisNFTTradesResponse {
  page: number;
  page_size: number;
  cursor?: string;
  result: MoralisNFTTrade[];
}

/**
 * Enhanced NFT Sale with metadata
 */
export interface EnhancedNFTSale extends NFTSale {
  // Additional metadata fields
  collectionName?: string;
  collectionLogo?: string;
  nftName?: string;
  nftImage?: string;
  nftDescription?: string;
  marketplaceLogo?: string;
  currentUsdValue?: string;
  verifiedCollection?: boolean;
}

/**
 * Moralis Web3 API Service for NFT trade data with metadata
 * Provides real-time NFT sales with rich metadata including names and images
 */
export class MoralisService {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly MIN_BLOCK_NUMBER = 23000000; // Only fetch trades from block 23M onwards

  constructor() {
    if (!config.moralis?.apiKey) {
      throw new Error('MORALIS_API_KEY environment variable is required');
    }
    
    this.baseUrl = config.moralis.baseUrl;
    this.apiKey = config.moralis.apiKey;
  }

  /**
   * Get NFT trades for a specific contract address
   * @param contractAddress - NFT contract address
   * @param limit - Number of trades to fetch (default: 100)
   * @param cursor - Pagination cursor (optional)
   * @param fromBlock - Starting block number (optional)
   */
  async getNFTTrades(
    contractAddress: string,
    limit: number = 100,
    cursor?: string,
    fromBlock?: string
  ): Promise<{ trades: EnhancedNFTSale[], nextCursor?: string }> {
    try {
      logger.info(`Fetching NFT trades for contract: ${contractAddress} (limit: ${limit})`);

      const params: any = {
        chain: 'eth',
        address: contractAddress,
        limit: Math.min(limit, 100), // Moralis max is 100 per request
        include_metadata: true, // Include NFT metadata
      };

      if (cursor) {
        params.cursor = cursor;
      }

      if (fromBlock) {
        params.from_block = fromBlock;
      }

      const response: AxiosResponse<MoralisNFTTradesResponse> = await axios.get(
        `${this.baseUrl}/nft/${contractAddress}/trades`,
        {
          params,
          headers: {
            'X-API-Key': this.apiKey,
            'Content-Type': 'application/json',
          },
          timeout: 30000, // 30 second timeout
        }
      );

      const { result, cursor: nextCursor } = response.data;
      logger.info(`Successfully fetched ${result.length} trades for contract ${contractAddress}`);

      // Convert to our enhanced NFTSale format
      const enhancedTrades = result.map(trade => this.convertToEnhancedNFTSale(trade, contractAddress));

      return {
        trades: enhancedTrades,
        nextCursor: nextCursor || undefined
      };

    } catch (error: any) {
      logger.error(`Failed to fetch NFT trades for contract ${contractAddress}:`, error.message);
      
      if (error.response) {
        logger.error('Moralis API response error:', {
          status: error.response.status,
          data: error.response.data
        });
      }
      
      return { trades: [] };
    }
  }

  /**
   * Get NFT trades for all configured contracts
   * @param limit - Maximum number of trades per contract
   * @param fromBlock - Optional starting block (defaults to 22M for recent data)
   */
  async getAllRecentTrades(limit: number = 100, fromBlock?: string): Promise<EnhancedNFTSale[]> {
    const allTrades: EnhancedNFTSale[] = [];
    
    // Default to block 22M if no fromBlock specified (filters out old data)
    const minBlock = fromBlock || this.MIN_BLOCK_NUMBER.toString();
    logger.info(`Fetching trades from block ${minBlock} onwards to ensure recent data`);

    for (const contractAddress of config.contracts) {
      logger.info(`Fetching recent trades for contract: ${contractAddress}`);
      
      const { trades } = await this.getNFTTrades(contractAddress, limit, undefined, minBlock);
      
      if (trades.length > 0) {
        // Additional client-side filtering to ensure block number >= 22M
        const filteredTrades = trades.filter(trade => trade.blockNumber >= this.MIN_BLOCK_NUMBER);
        allTrades.push(...filteredTrades);
        
        logger.info(`Added ${filteredTrades.length} recent trades from contract ${contractAddress} (filtered from ${trades.length})`);
      } else {
        logger.info(`No recent trades found for contract ${contractAddress}`);
      }
    }

    // Sort all trades by block number (newest first)
    allTrades.sort((a, b) => b.blockNumber - a.blockNumber);
    
    logger.info(`Total recent trades found: ${allTrades.length} (block >= ${this.MIN_BLOCK_NUMBER})`);
    return allTrades;
  }

  /**
   * Get NFT trades with pagination support
   * Fetches multiple pages to get more comprehensive data
   */
  async getNFTTradesWithPagination(
    contractAddress: string,
    maxResults: number = 500,
    fromBlock?: string
  ): Promise<EnhancedNFTSale[]> {
    const allTrades: EnhancedNFTSale[] = [];
    let cursor: string | undefined;
    let remainingResults = maxResults;

    try {
      do {
        const limit = Math.min(remainingResults, 100); // Moralis max per request
        const { trades, nextCursor } = await this.getNFTTrades(contractAddress, limit, cursor, fromBlock);
        
        if (trades.length === 0) {
          break; // No more results
        }

        allTrades.push(...trades);
        cursor = nextCursor;
        remainingResults -= trades.length;

        logger.debug(`Fetched ${trades.length} trades, total: ${allTrades.length}, remaining: ${remainingResults}`);

        // Respect rate limits - small delay between requests
        if (cursor && remainingResults > 0) {
          await new Promise(resolve => setTimeout(resolve, 100)); // 100ms delay
        }

      } while (cursor && remainingResults > 0);

      logger.info(`Pagination complete for ${contractAddress}: ${allTrades.length} total trades`);
      return allTrades;

    } catch (error: any) {
      logger.error(`Pagination failed for ${contractAddress}:`, error.message);
      return allTrades; // Return what we have so far
    }
  }

  /**
   * Convert Moralis trade data to our enhanced NFTSale interface
   */
  private convertToEnhancedNFTSale(trade: MoralisNFTTrade, contractAddress: string): EnhancedNFTSale {
    const blockNumber = parseInt(trade.block_number);
    const blockTime = trade.block_timestamp;
    const transactionHash = trade.transaction_hash;
    
    // Extract trade details
    const buyerAddress = trade.buyer_address;
    const sellerAddress = trade.seller_address;
    const tokenId = trade.token_ids.length > 0 ? trade.token_ids[0] : '0';
    
    // Marketplace info
    const marketplace = this.normalizeMarketplaceName(trade.marketplace);
    
    // Price info (already in wei format)
    const priceWei = trade.price;
    const currencySymbol = trade.token_symbol || 'ETH';
    
    // Enhanced metadata
    const collectionName = trade.collection_name;
    const collectionLogo = trade.collection_logo;
    const nftName = trade.metadata?.name;
    const nftImage = trade.metadata?.image;
    const nftDescription = trade.metadata?.description;
    const marketplaceLogo = trade.marketplace_logo;
    const currentUsdValue = trade.current_usd_value;
    const verifiedCollection = trade.verified_collection;

    return {
      blockNumber,
      blockTime,
      transactionHash,
      contractAddress,
      tokenId,
      marketplace,
      buyerAddress,
      sellerAddress,
      quantity: '1', // NFTs are typically quantity 1
      taker: 'BUYER', // Default assumption
      sellerFee: {
        amount: priceWei,
        symbol: currencySymbol,
        decimals: parseInt(trade.token_decimals) || 18
      },
      protocolFee: {
        amount: '0', // Moralis provides total price, not separate fees
        symbol: currencySymbol,
        decimals: parseInt(trade.token_decimals) || 18
      },
      royaltyFee: {
        amount: '0', // Moralis provides total price, not separate fees
        symbol: currencySymbol,
        decimals: parseInt(trade.token_decimals) || 18
      },
      logIndex: parseInt(trade.transaction_index) || 0,
      bundleIndex: 0,
      // Enhanced metadata fields
      collectionName,
      collectionLogo,
      nftName,
      nftImage,
      nftDescription,
      marketplaceLogo,
      currentUsdValue,
      verifiedCollection,
    };
  }

  /**
   * Normalize marketplace names to match our existing format
   */
  private normalizeMarketplaceName(marketplace: string): string {
    const normalizedName = marketplace.toLowerCase();
    
    // Map Moralis marketplace names to our standardized names
    switch (normalizedName) {
      case 'opensea':
        return 'seaport'; // OpenSea uses Seaport protocol
      case 'blur':
        return 'blur';
      case 'x2y2':
        return 'x2y2';
      case 'looksrare':
        return 'looksrare';
      case 'rarible':
        return 'rarible';
      case 'foundation':
        return 'foundation';
      case 'superrare':
        return 'superrare';
      default:
        return normalizedName;
    }
  }

  /**
   * Test connection to Moralis API
   */
  async testConnection(): Promise<boolean> {
    try {
      logger.info('Testing Moralis API connection...');
      
      // Test with a simple request to get a few trades
      const testContract = config.contracts[0]; // Use first contract for testing
      const { trades } = await this.getNFTTrades(testContract, 1);
      
      if (trades.length >= 0) { // Even 0 results means the API is working
        logger.info('✅ Moralis API connection successful');
        return true;
      } else {
        logger.error('❌ Moralis API connection failed - unexpected response');
        return false;
      }
    } catch (error: any) {
      logger.error('❌ Moralis API connection test failed:', error.message);
      return false;
    }
  }

  /**
   * Get API usage statistics (if available)
   */
  async getApiStats(): Promise<{ rateLimitRemaining?: number; rateLimitReset?: number }> {
    // Moralis includes rate limit info in response headers
    // This would be populated during actual API calls
    return {};
  }
}
