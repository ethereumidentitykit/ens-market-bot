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
   * Resolves proxy contract issues by tracing ENS token flow through proxy contracts
   * Includes retry mechanism to handle OpenSea API indexing delays
   * @param contractAddress - ENS contract address
   * @param tokenId - Token ID (decimal format)
   * @param txHash - Transaction hash from QuickNode webhook to match transfer events
   * @param knownProxies - Array of known proxy contract addresses to trace through
   * @returns Real buyer/seller addresses or null if not found
   */
  async getEventAddresses(contractAddress: string, tokenId: string, txHash: string, knownProxies: string[]): Promise<ResolvedAddresses | null> {
    const maxRetries = 3;
    const retryDelay = 5000; // 5 seconds

    for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
      const result = await this.fetchEventAddresses(contractAddress, tokenId, txHash, knownProxies);
      
      if (result) {
        if (attempt > 1) {
          logger.info(`✅ OpenSea Events API succeeded on attempt ${attempt}/${maxRetries + 1}`);
        }
        return result;
      }

      if (attempt <= maxRetries) {
        logger.debug(`🔄 OpenSea Events API attempt ${attempt}/${maxRetries + 1} failed - retrying in ${retryDelay/1000}s...`);
        await new Promise(resolve => setTimeout(resolve, retryDelay));
      } else {
        logger.warn(`❌ OpenSea Events API failed after ${maxRetries + 1} attempts`);
      }
    }

    return null;
  }

  /**
   * Single attempt to fetch event addresses from OpenSea Events API
   * @param contractAddress - ENS contract address
   * @param tokenId - Token ID (decimal format)  
   * @param txHash - Transaction hash from QuickNode webhook
   * @param knownProxies - Array of known proxy contract addresses
   * @returns Real buyer/seller addresses or null if not found
   */
  private async fetchEventAddresses(contractAddress: string, tokenId: string, txHash: string, knownProxies: string[]): Promise<ResolvedAddresses | null> {
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

      // Find transfer events with same transaction hash
      logger.debug(`Looking for tx hash: "${txHash}" in ${events.length} OpenSea events`);
      
      const transferEvents = events.filter(e => 
        e.event_type === 'transfer' && 
        e.transaction === txHash
      );
      

      if (transferEvents.length === 0) {
        logger.debug(`No transfer events found with transaction hash ${txHash}`);
        return null;
      }

      logger.debug(`Found ${transferEvents.length} transfer events for tx ${txHash}`);

      // Normalize proxy addresses for comparison
      const normalizedProxies = knownProxies.map(p => p.toLowerCase());

      let buyer: string | null = null;
      let seller: string | null = null;

      // Trace ENS token flow through proxy contracts
      // Step 1: Find transfer where proxy receives ENS (seller → proxy)
      const sellerToProxy = transferEvents.find(t => 
        t.to_address && normalizedProxies.includes(t.to_address.toLowerCase())
      );
      
      if (sellerToProxy?.from_address) {
        seller = sellerToProxy.from_address.toLowerCase();
        logger.debug(`Found seller → proxy transfer: ${seller} → ${sellerToProxy.to_address}`);
      }

      // Step 2: Find transfer where proxy sends ENS (proxy → buyer)
      const proxyToBuyer = transferEvents.find(t => 
        t.from_address && normalizedProxies.includes(t.from_address.toLowerCase())
      );
      
      if (proxyToBuyer?.to_address) {
        buyer = proxyToBuyer.to_address.toLowerCase();
        logger.debug(`Found proxy → buyer transfer: ${proxyToBuyer.from_address} → ${buyer}`);
      }

      logger.debug(`Flow tracing result - Seller: ${seller}, Buyer: ${buyer}`);

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
