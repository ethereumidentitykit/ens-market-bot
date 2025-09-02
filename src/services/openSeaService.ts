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
