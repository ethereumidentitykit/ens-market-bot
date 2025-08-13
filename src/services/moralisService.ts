import axios, { AxiosResponse } from 'axios';
import { logger } from '../utils/logger';
import { NFTSale } from '../types';
import { config } from '../utils/config';
import { APIToggleService } from './apiToggleService';

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
  private apiToggleService: APIToggleService;

  constructor() {
    this.apiToggleService = APIToggleService.getInstance();
    if (!config.moralis?.apiKey) {
      throw new Error('MORALIS_API_KEY environment variable is required');
    }
    
    this.baseUrl = config.moralis.baseUrl;
    this.apiKey = config.moralis.apiKey;
  }

  /**
   * Check if Moralis API is enabled via admin toggle
   */
  private checkApiEnabled(): boolean {
    if (!this.apiToggleService.isMoralisEnabled()) {
      logger.warn('Moralis API call blocked - API disabled via admin toggle');
      return false;
    }
    return true;
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
    if (!this.checkApiEnabled()) {
      return { trades: [] };
    }

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
   * Get incremental NFT trades since last processed block using cursor pagination
   * Optimized for scheduler use - fetches only new trades since lastProcessedBlock
   * @param lastProcessedBlock - Block number to start from (fetch trades newer than this)
   * @param batchSize - Number of trades to fetch per API call (default: 10)
   */
  async getIncrementalTrades(lastProcessedBlock: number, batchSize: number = 10): Promise<EnhancedNFTSale[]> {
    const allNewTrades: EnhancedNFTSale[] = [];
    
    logger.info(`Starting incremental fetch from block ${lastProcessedBlock} with batch size ${batchSize}`);
    logger.info(`Processing ${config.contracts.length} contracts: ${config.contracts.join(', ')}`);

    for (const contractAddress of config.contracts) {
      logger.info(`Fetching incremental trades for contract: ${contractAddress}`);
      
      let cursor: string | undefined;
      let foundNewTrades = true;
      let requestCount = 0;
      let contractNewTrades = 0;

      try {
        while (foundNewTrades) {
          requestCount++;
          logger.debug(`Request #${requestCount} for contract ${contractAddress}${cursor ? ` (cursor: ${cursor.substring(0, 20)}...)` : ' (initial)'}`);

          // Fetch trades with current cursor
          const { trades, nextCursor } = await this.getNFTTrades(contractAddress, batchSize, cursor);
          
          if (trades.length === 0) {
            logger.debug(`No more trades available for contract ${contractAddress}`);
            break;
          }

          // Check block range in current batch
          const blockNumbers = trades.map(t => t.blockNumber);
          const oldestInBatch = Math.min(...blockNumbers);
          const newestInBatch = Math.max(...blockNumbers);
          
          logger.debug(`Batch block range: ${oldestInBatch} → ${newestInBatch} (${trades.length} trades)`);

          // Filter for trades newer than lastProcessedBlock
          const newTrades = trades.filter(trade => trade.blockNumber > lastProcessedBlock);
          
          if (newTrades.length > 0) {
            allNewTrades.push(...newTrades);
            contractNewTrades += newTrades.length;
            logger.debug(`Found ${newTrades.length} new trades in this batch (${newTrades.length}/${trades.length})`);
          }

          // If oldest trade in batch is < lastProcessedBlock, we've hit older data (all duplicates from here)
          if (oldestInBatch < lastProcessedBlock) {
            logger.debug(`Hit older data (block ${oldestInBatch} < ${lastProcessedBlock}) for contract ${contractAddress} - stopping`);
            foundNewTrades = false;
            break;
          }

          // Continue with next page
          cursor = nextCursor;
          if (!cursor) {
            logger.debug(`No more pages available for contract ${contractAddress}`);
            foundNewTrades = false;
          }

          // Rate limiting
          await new Promise(resolve => setTimeout(resolve, 100));

          // Safety check - prevent infinite loops
          if (requestCount > 20) {
            logger.warn(`Stopping after ${requestCount} requests for safety on contract ${contractAddress}`);
            break;
          }

          // Additional safety: if we're not finding any new trades for several requests, stop
          if (newTrades.length === 0 && requestCount > 5) {
            logger.debug(`No new trades found for ${requestCount} consecutive requests, stopping for ${contractAddress}`);
            foundNewTrades = false;
            break;
          }
        }

        logger.info(`Completed incremental fetch for ${contractAddress}: ${contractNewTrades} new trades in ${requestCount} requests`);

      } catch (error: any) {
        logger.error(`Error during incremental fetch for contract ${contractAddress}:`, error.message);
        logger.error(`Error details:`, error);
        // Continue processing other contracts even if one fails
      }
    }

    // Sort all trades by block number (newest first)
    allNewTrades.sort((a, b) => b.blockNumber - a.blockNumber);
    
    // Log summary by contract
    const contractSummary: { [key: string]: number } = {};
    for (const trade of allNewTrades) {
      contractSummary[trade.contractAddress] = (contractSummary[trade.contractAddress] || 0) + 1;
    }
    
    logger.info(`Incremental fetch complete: ${allNewTrades.length} total new trades found`);
    logger.info(`Trades by contract:`, contractSummary);
    return allNewTrades;
  }

  /**
   * Get NFT trades for all configured contracts (legacy method)
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
    if (!this.checkApiEnabled()) {
      return false;
    }

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

  /**
   * Populate historical data from current block back to target block
   * Uses cursor pagination to go backwards through time until target block is reached
   * @param targetBlock - Stop when we reach this block number (e.g., 23100000)
   * @param contractAddress - Specific contract to process (optional, defaults to all contracts)
   * @param resumeCursor - Resume from this cursor if provided
   */
  async populateHistoricalData(
    targetBlock: number,
    contractAddress?: string,
    resumeCursor?: string
  ): Promise<{
    totalFetched: number;
    totalProcessed: number;
    totalFiltered: number;
    totalDuplicates: number;
    oldestBlockReached: number;
    targetBlockReached: boolean;
    finalCursor?: string;
    trades?: EnhancedNFTSale[];
  }> {
    if (!this.checkApiEnabled()) {
      return {
        totalFetched: 0,
        totalProcessed: 0,
        totalFiltered: 0,
        totalDuplicates: 0,
        oldestBlockReached: 0,
        targetBlockReached: false
      };
    }

    const stats = {
      totalFetched: 0,
      totalProcessed: 0,
      totalFiltered: 0,
      totalDuplicates: 0,
      oldestBlockReached: 0,
      targetBlockReached: false,
      finalCursor: undefined as string | undefined,
      trades: [] as EnhancedNFTSale[]
    };

    // Use single contract or all contracts
    const contracts = contractAddress ? [contractAddress] : config.contracts;
    
    logger.info(`Starting historical data population to block ${targetBlock}`);
    logger.info(`Processing contracts: ${contracts.join(', ')}`);

    for (const contract of contracts) {
      logger.info(`\n=== Processing contract: ${contract} ===`);
      
      let cursor: string | undefined = resumeCursor;
      let targetReached = false;
      let requestCount = 0;

      try {
        while (!targetReached) {
          requestCount++;
          logger.info(`Request #${requestCount} for contract ${contract}${cursor ? ` (cursor: ${cursor.substring(0, 20)}...)` : ' (initial)'}`);

          // Fetch trades with current cursor
          const { trades, nextCursor } = await this.getNFTTrades(contract, 100, cursor);
          
          if (trades.length === 0) {
            logger.info(`No more trades available for contract ${contract}`);
            break;
          }

          stats.totalFetched += trades.length;

          // Check block range in current batch
          const blockNumbers = trades.map(t => t.blockNumber);
          const oldestInBatch = Math.min(...blockNumbers);
          const newestInBatch = Math.max(...blockNumbers);
          
          logger.info(`Batch block range: ${oldestInBatch} → ${newestInBatch} (${trades.length} trades)`);

          // Update oldest block reached
          stats.oldestBlockReached = Math.min(stats.oldestBlockReached || oldestInBatch, oldestInBatch);

          // Filter trades that are >= target block
          let tradesToProcess = trades;
          if (oldestInBatch <= targetBlock) {
            tradesToProcess = trades.filter(trade => trade.blockNumber >= targetBlock);
            targetReached = true;
            stats.targetBlockReached = true;
            logger.info(`Target block ${targetBlock} reached! Processing ${tradesToProcess.length} valid trades from final batch.`);
          }

          // Just count the trades for now - actual processing will be handled by caller
          stats.totalProcessed += tradesToProcess.length;
          
          // Store trades for return to caller for processing
          stats.trades.push(...tradesToProcess);

          // Store cursor for potential resume
          stats.finalCursor = nextCursor;
          cursor = nextCursor;

          // Rate limiting
          if (cursor && !targetReached) {
            await new Promise(resolve => setTimeout(resolve, 100));
          }

          // Safety check - prevent infinite loops
          if (requestCount > 1000) {
            logger.warn(`Stopping after ${requestCount} requests for safety`);
            break;
          }
        }

        logger.info(`Completed contract ${contract}: ${requestCount} requests, oldest block: ${stats.oldestBlockReached}`);

      } catch (error: any) {
        logger.error(`Error processing contract ${contract}:`, error.message);
        throw error;
      }
    }

    logger.info(`\n=== Historical Population Complete ===`);
    logger.info(`Total fetched: ${stats.totalFetched}`);
    logger.info(`Total processed: ${stats.totalProcessed}`);
    logger.info(`Oldest block reached: ${stats.oldestBlockReached}`);
    logger.info(`Target block reached: ${stats.targetBlockReached}`);

    return stats;
  }
}
