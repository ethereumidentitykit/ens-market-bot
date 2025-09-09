import axios, { AxiosResponse } from 'axios';
import { logger } from '../utils/logger';
import { config } from '../utils/config';

export interface OpenSeaTrait {
  trait_type: string;
  display_type: string | null;
  max_value: string | null;
  value: string | number;
}

export interface OpenSeaOwner {
  address: string;
  quantity: number;
}

export interface OpenSeaNFT {
  identifier: string;
  collection: string;
  contract: string;
  token_standard: string;
  name: string;
  description: string;
  image_url: string;
  display_image_url: string;
  display_animation_url: string | null;
  metadata_url: string;
  opensea_url: string;
  updated_at: string;
  is_disabled: boolean;
  is_nsfw: boolean;
  animation_url: string | null;
  is_suspicious: boolean;
  creator: string;
  traits: OpenSeaTrait[];
  owners: OpenSeaOwner[];
  rarity: any | null;
}

export interface OpenSeaResponse {
  nft: OpenSeaNFT;
}

export interface OpenSeaEventNFT {
  identifier: string;
  collection: string;
  contract: string;
  token_standard: string;
  name: string;
  description: string;
  image_url: string;
  display_image_url: string;
  display_animation_url: string | null;
  metadata_url: string;
  opensea_url: string;
  updated_at: string;
  is_disabled: boolean;
  is_nsfw: boolean;
}

export interface OpenSeaEvent {
  event_type: string;
  event_timestamp: number;
  transaction: string;
  chain: string;
  payment: {
    quantity: string;
    token_address: string;
    decimals: number;
    symbol: string;
  } | null;
  closing_date: number | null;
  seller: string | null;
  buyer: string | null;
  from_address: string | null;
  to_address: string | null;
  quantity: number;
  nft: OpenSeaEventNFT;
}

export interface OpenSeaEventsResponse {
  asset_events: OpenSeaEvent[];
  next: string | null;
}

export interface ResolvedAddresses {
  buyer: string;
  seller: string;
}

/**
 * OpenSea API Service
 * Handles NFT metadata fetching from OpenSea API v2
 */
export class OpenSeaService {
  private readonly baseUrl = 'https://api.opensea.io/api/v2';
  private readonly timeout = 10000; // 10 second timeout
  private readonly rateLimitDelay = 1000; // 1 second between requests
  private lastRequestTime = 0;

  constructor() {
    if (!config.opensea?.apiKey) {
      logger.warn('OPENSEA_API_KEY not configured - OpenSea service will be disabled');
    }
  }

  /**
   * Rate limiting: ensure 1 second delay between requests
   */
  private async enforceRateLimit(): Promise<void> {
    const now = Date.now();
    const timeSinceLastRequest = now - this.lastRequestTime;
    
    if (timeSinceLastRequest < this.rateLimitDelay) {
      const waitTime = this.rateLimitDelay - timeSinceLastRequest;
      logger.debug(`Rate limiting: waiting ${waitTime}ms before OpenSea request`);
      await new Promise(resolve => setTimeout(resolve, waitTime));
    }
    
    this.lastRequestTime = Date.now();
  }

  /**
   * Get NFT metadata from OpenSea API
   * @param contractAddress - NFT contract address
   * @param tokenId - Token ID (decimal format)
   * @returns OpenSea NFT data or null if failed
   */
  async getNFTMetadata(contractAddress: string, tokenId: string): Promise<OpenSeaNFT | null> {
    if (!config.opensea?.apiKey) {
      logger.debug('OpenSea API key not configured, skipping request');
      return null;
    }

    try {
      // Enforce rate limiting
      await this.enforceRateLimit();

      const url = `${this.baseUrl}/chain/ethereum/contract/${contractAddress.toLowerCase()}/nfts/${tokenId}`;
      logger.debug(`Fetching OpenSea metadata from: ${url}`);
      
      const response: AxiosResponse<OpenSeaResponse> = await axios.get(url, {
        timeout: this.timeout,
        headers: {
          'accept': 'application/json',
          'x-api-key': config.opensea.apiKey,
          'User-Agent': 'ENS-TwitterBot/1.0'
        }
      });
      
      const nft = response.data.nft;
      logger.debug(`Successfully fetched OpenSea metadata: ${nft.name}`);
      
      // Log basic NFT info for debugging
      logger.debug(`NFT traits count: ${nft.traits?.length || 0}`);
      
      return nft;
      
    } catch (error: any) {
      if (error.code === 'ECONNABORTED') {
        logger.warn(`OpenSea API timeout for ${contractAddress}/${tokenId}`);
      } else if (error.response) {
        const status = error.response.status;
        if (status === 429) {
          logger.warn(`OpenSea API rate limit exceeded for ${contractAddress}/${tokenId}`);
        } else if (status === 404) {
          logger.debug(`OpenSea NFT not found: ${contractAddress}/${tokenId}`);
        } else {
          logger.warn(`OpenSea API error ${status} for ${contractAddress}/${tokenId}: ${error.response.statusText}`);
        }
      } else {
        logger.warn(`OpenSea API error for ${contractAddress}/${tokenId}: ${error.message}`);
      }
      return null;
    }
  }

  /**
   * Get token owner from OpenSea API
   * @param contractAddress - NFT contract address
   * @param tokenId - Token ID (decimal format)
   * @returns Owner address or null if failed/not found
   */
  async getTokenOwner(contractAddress: string, tokenId: string): Promise<string | null> {
    try {
      const nft = await this.getNFTMetadata(contractAddress, tokenId);
      
      if (!nft || !nft.owners || nft.owners.length === 0) {
        logger.debug(`No owners found in OpenSea data for ${contractAddress}/${tokenId}`);
        return null;
      }

      // For ENS tokens, there should typically be only one owner
      // If multiple owners, take the first one with quantity > 0
      const primaryOwner = nft.owners.find(owner => owner.quantity > 0);
      
      if (primaryOwner) {
        logger.debug(`Found owner via OpenSea: ${primaryOwner.address} (quantity: ${primaryOwner.quantity})`);
        return primaryOwner.address;
      }

      // Fallback to first owner if no quantity info
      const firstOwner = nft.owners[0];
      logger.debug(`Using first owner from OpenSea: ${firstOwner.address}`);
      return firstOwner.address;

    } catch (error: any) {
      logger.warn(`Failed to get token owner from OpenSea for ${contractAddress}/${tokenId}: ${error.message}`);
      return null;
    }
  }

  /**
   * Get simplified metadata for our use case
   * @param contractAddress - NFT contract address  
   * @param tokenId - Token ID (decimal format)
   * @returns Simplified metadata object or null if failed
   */
  async getSimplifiedMetadata(contractAddress: string, tokenId: string): Promise<{
    name: string;
    description: string;
    image: string;
    collection: string;
    opensea_url: string;
  } | null> {
    const nft = await this.getNFTMetadata(contractAddress, tokenId);
    
    if (!nft) {
      return null;
    }
    
    return {
      name: nft.name,
      description: nft.description,
      image: nft.image_url || nft.display_image_url,
      collection: nft.collection,
      opensea_url: nft.opensea_url
    };
  }

  /**
   * Get real buyer and seller addresses from OpenSea Events API
   * Resolves proxy contract issues by finding transfer events at the same timestamp as the sale
   * @param contractAddress - ENS contract address
   * @param tokenId - Token ID (decimal format)
   * @param txHash - Transaction hash from QuickNode webhook to match exact sale
   * @returns Real buyer/seller addresses or null if not found
   */
  async getEventAddresses(contractAddress: string, tokenId: string, txHash: string): Promise<ResolvedAddresses | null> {
    if (!config.opensea?.apiKey) {
      logger.warn('OpenSea API key not configured - cannot resolve proxy addresses');
      return null;
    }

    try {
      const url = `${this.baseUrl}/events/chain/ethereum/contract/${contractAddress}/nfts/${tokenId}?limit=5`;
      
      logger.debug(`🔍 Fetching OpenSea events for ${contractAddress}/${tokenId}`);
      
      const response: AxiosResponse<OpenSeaEventsResponse> = await axios.get(url, {
        headers: {
          'X-API-KEY': config.opensea.apiKey,
        },
        timeout: this.timeout
      });

      const events = response.data.asset_events;
      
      if (!events || events.length === 0) {
        logger.debug(`No events found for ${contractAddress}/${tokenId}`);
        return null;
      }

      // Find sale event by matching transaction hash from QuickNode webhook
      const saleEvent = events.find(e => e.event_type === 'sale' && e.transaction === txHash);
      
      if (!saleEvent) {
        logger.debug(`No sale event found with transaction hash ${txHash}`);
        return null;
      }

      logger.debug(`Found sale event at timestamp ${saleEvent.event_timestamp} for tx ${txHash}`);

      // Find transfer events with exact same timestamp as the sale
      const transferEvents = events.filter(e => 
        e.event_type === 'transfer' && 
        e.event_timestamp === saleEvent.event_timestamp
      );

      if (transferEvents.length === 0) {
        logger.debug(`No transfer events found at timestamp ${saleEvent.event_timestamp}`);
        return null;
      }

      logger.debug(`Found ${transferEvents.length} transfer events at timestamp ${saleEvent.event_timestamp}`);

      // OpenSea API returns events in chronological order (most recent first)
      // For ENS token transfers: seller → proxy → buyer
      // First in array = most recent = final transfer (proxy → buyer)  
      // Last in array = oldest = initial transfer (seller → proxy)

      let buyer: string | null = null;
      let seller: string | null = null;

      // Get buyer from final transfer (first in array - most recent)
      const finalTransfer = transferEvents[0];
      buyer = finalTransfer.to_address?.toLowerCase() || null;

      // Get seller from initial transfer (last in array - oldest) 
      const initialTransfer = transferEvents[transferEvents.length - 1];
      seller = initialTransfer.from_address?.toLowerCase() || null;

      logger.debug(`Transfer events - Final: from=${finalTransfer.from_address} to=${finalTransfer.to_address}, Initial: from=${initialTransfer.from_address} to=${initialTransfer.to_address}`);

      if (buyer && seller) {
        logger.info(`✅ Resolved addresses via OpenSea Events API - Buyer: ${buyer}, Seller: ${seller}`);
        return { buyer, seller };
      } else {
        logger.debug(`Incomplete address resolution - Buyer: ${buyer}, Seller: ${seller}`);
        return null;
      }

    } catch (error: any) {
      logger.warn(`Failed to resolve addresses via OpenSea Events API for ${contractAddress}/${tokenId}: ${error.message}`);
      return null;
    }
  }

  /**
   * Test connection to OpenSea API
   */
  async testConnection(): Promise<boolean> {
    if (!config.opensea?.apiKey) {
      logger.warn('OpenSea API key not configured - cannot test connection');
      return false;
    }

    try {
      // Test with a known ENS token (using the example from your curl)
      const testContract = '0xd4416b13d2b3a9abae7acd5d6c2bbdbe25686401';
      const testTokenId = '85765207615751231047366069629831597556988698047090778655339501630748775762309';
      
      const metadata = await this.getNFTMetadata(testContract, testTokenId);
      
      if (metadata && metadata.name) {
        logger.info('✅ OpenSea API connection successful');
        return true;
      } else {
        logger.error('❌ OpenSea API connection failed - no data returned');
        return false;
      }
    } catch (error: any) {
      logger.error('❌ OpenSea API connection test failed:', error.message);
      return false;
    }
  }

  /**
   * Check if OpenSea service is available
   */
  isAvailable(): boolean {
    return !!config.opensea?.apiKey;
  }
}
