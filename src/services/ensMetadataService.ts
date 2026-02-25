import axios, { AxiosResponse } from 'axios';
import { logger } from '../utils/logger';

export interface ENSMetadata {
  name: string;
  description?: string;
  image?: string;
  image_url?: string; // ENS API provides both image and image_url
  background_image?: string;
  url?: string;
  is_normalized?: boolean;
  attributes?: Array<{
    trait_type: string;
    value: any;
    display_type?: string;
  }>;
}

/**
 * Centralized ENS Metadata Service
 * Handles all calls to the official ENS metadata API
 */
export class ENSMetadataService {
  private readonly baseUrl = 'https://metadata.ens.domains/mainnet';
  private readonly timeout = 10000; // 5 second timeout

  /**
   * Fetch ENS metadata from the official ENS metadata API
   * @param contractAddress - ENS contract address (NameWrapper or OG Registry)
   * @param tokenId - Token ID (decimal format)
   * @returns ENS metadata or null if failed
   */
  async getMetadata(contractAddress: string, tokenId: string): Promise<ENSMetadata | null> {
    try {
      const url = `${this.baseUrl}/${contractAddress.toLowerCase()}/${tokenId}`;
      logger.debug(`Fetching ENS metadata from: ${url}`);
      
      const response: AxiosResponse<ENSMetadata> = await axios.get(url, {
        timeout: this.timeout,
        headers: {
          'User-Agent': 'ENS-TwitterBot/1.0',
          'Accept': 'application/json'
        },
        responseType: 'json' // Explicitly parse as JSON
      });
      
      // Debug: Log response details
      logger.debug(`Response status: ${response.status}`);
      logger.debug(`Response headers content-type: ${response.headers['content-type']}`);
      logger.debug(`Response data type: ${typeof response.data}`);
      logger.debug(`Response data is string: ${typeof response.data === 'string'}`);
      
      // If response.data is a string, parse it manually
      let metadata: ENSMetadata;
      if (typeof response.data === 'string') {
        logger.warn(`⚠️ ENS API returned string instead of parsed JSON, parsing manually`);
        metadata = JSON.parse(response.data);
      } else {
        metadata = response.data;
      }
      
      logger.debug(`Successfully fetched ENS metadata: ${metadata.name}`);
      logger.debug(`Full ENS metadata response:`, JSON.stringify(metadata, null, 2));
      
      return metadata;
      
    } catch (error: any) {
      if (error.code === 'ECONNABORTED') {
        logger.warn(`ENS metadata API timeout for ${contractAddress}/${tokenId}`);
      } else if (error.response) {
        logger.warn(`ENS metadata API error ${error.response.status} for ${contractAddress}/${tokenId}: ${error.response.statusText}`);
      } else {
        logger.warn(`ENS metadata API error for ${contractAddress}/${tokenId}: ${error.message}`);
      }
      return null;
    }
  }

  /**
   * Get metadata with automatic contract detection
   * Tries NameWrapper first, then falls back to OG Registry
   * @param tokenId - Token ID (decimal format)
   * @returns ENS metadata or null if failed
   */
  async getMetadataWithFallback(tokenId: string): Promise<ENSMetadata | null> {
    // Try NameWrapper first (most common)
    const nameWrapperContract = '0xD4416b13d2b3a9aBae7AcD5D6C2BbDBE25686401';
    let metadata = await this.getMetadata(nameWrapperContract, tokenId);
    
    if (metadata) {
      logger.debug(`Found metadata using NameWrapper contract for token ${tokenId}`);
      return metadata;
    }

    // Fallback to OG Registry
    const ogRegistryContract = '0x57f1887a8BF19b14fC0dF6Fd9B2acc9Af147eA85';
    metadata = await this.getMetadata(ogRegistryContract, tokenId);
    
    if (metadata) {
      logger.debug(`Found metadata using OG Registry contract for token ${tokenId}`);
      return metadata;
    }

    logger.warn(`No ENS metadata found for token ${tokenId} using either contract`);
    return null;
  }

  /**
   * Test connection to ENS metadata API
   */
  async testConnection(): Promise<boolean> {
    try {
      // Test with a known ENS token (vitalik.eth)
      const testTokenId = '79233663829379634837589865448569342784712482819484549289560981379859480642508';
      const testContract = '0x57f1887a8BF19b14fC0dF6Fd9B2acc9Af147eA85';
      
      const metadata = await this.getMetadata(testContract, testTokenId);
      
      if (metadata && metadata.name) {
        logger.info('✅ ENS Metadata API connection successful');
        return true;
      } else {
        logger.error('❌ ENS Metadata API connection failed - no data returned');
        return false;
      }
    } catch (error: any) {
      logger.error('❌ ENS Metadata API connection test failed:', error.message);
      return false;
    }
  }
}
