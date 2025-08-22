import axios, { AxiosResponse } from 'axios';
import { config } from '../utils/config';
import { logger } from '../utils/logger';
import { AlchemyNFTSalesResponse, NFTSale, AlchemyPriceResponse } from '../types';

export class AlchemyService {
  private baseUrl: string;
  private apiKey: string;

  // ETH price cache (30-minute in-memory cache to avoid API abuse)
  private ethPriceCache: { price: number; timestamp: number } | null = null;
  private readonly CACHE_DURATION = 30 * 60 * 1000; // 30 minutes in milliseconds

  constructor() {
    this.baseUrl = config.alchemy.baseUrl;
    this.apiKey = config.alchemy.apiKey;
  }

  /**
   * Fetch NFT sales for a specific contract address with pagination support
   * @param contractAddress - The contract address to fetch sales for
   * @param fromBlock - Starting block number (optional)
   * @param toBlock - Ending block number (optional)
   * @param limit - Maximum number of results (default: 1000)
   * @param pageKey - Pagination key for next page (optional)
   */
  async getNFTSales(
    contractAddress: string,
    fromBlock?: string,
    toBlock?: string,
          limit: number = 1000,
    pageKey?: string
  ): Promise<AlchemyNFTSalesResponse | null> {
    try {
      const url = `${this.baseUrl}/nft/v3/${this.apiKey}/getNFTSales`;
      
      const params: any = {
        contractAddress,
        limit
        // Note: Alchemy API doesn't support 'order' parameter, sales are returned in natural order
      };

      if (fromBlock) {
        params.fromBlock = fromBlock;
      }
      
      if (toBlock) {
        params.toBlock = toBlock;
      }

      if (pageKey) {
        params.pageKey = pageKey;
      }

      logger.debug(`Fetching NFT sales for contract ${contractAddress}`, params);

      const response: AxiosResponse<AlchemyNFTSalesResponse> = await axios.get(url, {
        params,
        timeout: 30000, // 30 second timeout
      });

      logger.info(`Successfully fetched ${response.data.nftSales.length} sales for contract ${contractAddress}`);
      return response.data;

    } catch (error: any) {
      logger.error(`Failed to fetch NFT sales for contract ${contractAddress}:`, error.message);
      
      if (error.response) {
        logger.error('API response error:', {
          status: error.response.status,
          data: error.response.data
        });
      }
      
      return null;
    }
  }

  /**
   * Fetch all NFT sales for a contract with automatic pagination
   * @param contractAddress - The contract address to fetch sales for
   * @param fromBlock - Starting block number (optional)
   * @param maxResults - Maximum total results to fetch (default: 5000)
   */
  async getAllSalesForContract(
    contractAddress: string,
    fromBlock?: string,
    maxResults: number = 5000
  ): Promise<NFTSale[]> {
    const allSales: NFTSale[] = [];
    let pageKey: string | undefined;
    let totalFetched = 0;

    try {
      logger.info(`Fetching all sales for contract ${contractAddress} with pagination`);

      do {
        const batchSize = Math.min(1000, maxResults - totalFetched);
        const response = await this.getNFTSales(contractAddress, fromBlock, 'latest', batchSize, pageKey);
        
        if (!response || response.nftSales.length === 0) {
          break;
        }

        allSales.push(...response.nftSales);
        totalFetched += response.nftSales.length;
        pageKey = response.pageKey;

        logger.info(`Fetched ${response.nftSales.length} sales (total: ${totalFetched}) for contract ${contractAddress}`);

        // Safety check to prevent infinite loops
        if (totalFetched >= maxResults) {
          logger.info(`Reached maximum results limit (${maxResults}) for contract ${contractAddress}`);
          break;
        }

      } while (pageKey && totalFetched < maxResults);

      logger.info(`Completed fetching ${totalFetched} sales for contract ${contractAddress}`);
      return allSales;

    } catch (error: any) {
      logger.error(`Failed to fetch paginated sales for contract ${contractAddress}:`, error.message);
      return allSales; // Return what we have so far
    }
  }

  /**
   * Fetch recent NFT sales for all configured contract addresses
   * @param fromBlock - Starting block number (optional)
   * @param limit - Maximum number of results per contract (increased default)
   */
  async getAllRecentSales(fromBlock?: string, limit: number = 1000): Promise<NFTSale[]> {
    const allSales: NFTSale[] = [];

    for (const contractAddress of config.contracts) {
      logger.info(`Fetching recent sales for contract: ${contractAddress}`);
      
      const response = await this.getNFTSales(contractAddress, fromBlock, 'latest', limit);
      
      if (response && response.nftSales.length > 0) {
        allSales.push(...response.nftSales);
        logger.info(`Added ${response.nftSales.length} sales from contract ${contractAddress}`);
      } else {
        logger.info(`No recent sales found for contract ${contractAddress}`);
      }
    }

    // Sort all sales by block number (newest first)
    allSales.sort((a, b) => b.blockNumber - a.blockNumber);
    
    logger.info(`Total recent sales found: ${allSales.length}`);
    return allSales;
  }

  /**
   * Get the latest block number from the last sales fetch
   * This helps us track where to start the next fetch from
   */
  async getLatestValidBlock(): Promise<number | null> {
    try {
      // Fetch a minimal amount of data just to get the latest block info
      const response = await this.getNFTSales(config.contracts[0], undefined, 'latest', 1);
      
      if (response && response.validAt) {
        return response.validAt.blockNumber;
      }
      
      return null;
    } catch (error: any) {
      logger.error('Failed to get latest valid block:', error.message);
      return null;
    }
  }

  /**
   * Get owners for a specific NFT token
   * @param contractAddress - The contract address (e.g., ENS contract)
   * @param tokenId - The token ID to get owners for
   */
  async getOwnersForToken(contractAddress: string, tokenId: string): Promise<string[]> {
    try {
      const url = `${this.baseUrl}/nft/v2/${this.apiKey}/getOwnersForToken`;
      
      const params = {
        contractAddress,
        tokenId
      };

      logger.debug(`Fetching owners for token ${tokenId} on contract ${contractAddress}`);

      const response: AxiosResponse<{ owners: string[] }> = await axios.get(url, {
        params,
        timeout: 10000, // 10 second timeout
      });

      const owners = response.data.owners || [];
      logger.debug(`Found ${owners.length} owners for token ${tokenId}`);
      return owners;

    } catch (error: any) {
      logger.error(`Failed to fetch owners for token ${tokenId}:`, error.message);
      
      if (error.response) {
        logger.error('API response error:', {
          status: error.response.status,
          data: error.response.data
        });
      }
      
      return []; // Return empty array on failure
    }
  }

  /**
   * Get current ETH price in USD with 30-minute caching to avoid API abuse
   * Uses Alchemy's prices API endpoint
   */
  async getETHPriceUSD(): Promise<number | null> {
    try {
      // Check for cached price first (30-minute cache)
      const cachedPrice = await this.getCachedETHPrice();
      if (cachedPrice) {
        return cachedPrice;
      }

      logger.debug('ETH price cache expired, fetching fresh price from Alchemy API');
      
      const response: AxiosResponse<AlchemyPriceResponse> = await axios.get(
        `https://api.g.alchemy.com/prices/v1/${this.apiKey}/tokens/by-symbol`,
        {
          params: {
            symbols: 'ETH'
          },
          timeout: 10000, // 10 second timeout
          headers: {
            'Accept': 'application/json',
            'User-Agent': 'ENS-TwitterBot/1.0'
          }
        }
      );

      const ethData = response.data.data[0]; // First token in response
      if (!ethData || ethData.symbol !== 'ETH') {
        throw new Error('ETH price data not found in response');
      }

      const usdPrice = ethData.prices.find(p => p.currency === 'usd');
      if (!usdPrice) {
        throw new Error('USD price not found for ETH');
      }

      const priceValue = parseFloat(usdPrice.value);
      logger.debug(`ETH price fetched: $${priceValue} (last updated: ${usdPrice.lastUpdatedAt})`);
      
      // Cache the fresh price for 30 minutes
      await this.cacheETHPrice(priceValue);
      
      return priceValue;
    } catch (error: any) {
      logger.warn('Failed to fetch ETH price from Alchemy:', error.message);
      
      // Fallback to $4000 if API is unavailable
      const fallbackPrice = 4000;
      logger.info(`💰 Using fallback ETH price: $${fallbackPrice} (API unavailable)`);
      
      // Cache the fallback price to avoid repeated API attempts
      await this.cacheETHPrice(fallbackPrice);
      
      return fallbackPrice;
    }
  }

  /**
   * Check for cached ETH price (30-minute cache)
   * Returns null if cache is expired or missing
   */
  private async getCachedETHPrice(): Promise<number | null> {
    try {
      if (!this.ethPriceCache) {
        return null;
      }

      const now = Date.now();
      const age = now - this.ethPriceCache.timestamp;
      
      if (age > this.CACHE_DURATION) {
        logger.debug('ETH price cache expired, will fetch fresh');
        this.ethPriceCache = null;
        return null;
      }

      const cacheAgeMinutes = Math.floor(age / 60000);
      logger.debug(`Using cached ETH price: $${this.ethPriceCache.price} (${cacheAgeMinutes}m old)`);
      return this.ethPriceCache.price;
    } catch (error: any) {
      logger.debug('Failed to get cached ETH price:', error.message);
      return null;
    }
  }

  /**
   * Cache ETH price with timestamp for 30-minute expiry
   */
  private async cacheETHPrice(price: number): Promise<void> {
    try {
      this.ethPriceCache = {
        price: price,
        timestamp: Date.now()
      };
      logger.debug(`ETH price cached: $${price} (will expire in 30 minutes)`);
    } catch (error: any) {
      logger.debug('Failed to cache ETH price:', error.message);
    }
  }

  /**
   * Test the API connection and configuration
   */
  async testConnection(): Promise<boolean> {
    try {
      logger.info('Testing Alchemy API connection...');
      
      const response = await this.getNFTSales(config.contracts[0], undefined, 'latest', 1);
      
      if (response) {
        logger.info('Alchemy API connection test successful');
        return true;
      } else {
        logger.error('Alchemy API connection test failed');
        return false;
      }
    } catch (error: any) {
      logger.error('Alchemy API connection test failed:', error.message);
      return false;
    }
  }
}
