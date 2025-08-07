import axios, { AxiosResponse } from 'axios';
import { config } from '../utils/config';
import { logger } from '../utils/logger';
import { AlchemyNFTSalesResponse, NFTSale } from '../types';

export class AlchemyService {
  private baseUrl: string;
  private apiKey: string;

  constructor() {
    this.baseUrl = config.alchemy.baseUrl;
    this.apiKey = config.alchemy.apiKey;
  }

  /**
   * Fetch NFT sales for a specific contract address
   * @param contractAddress - The contract address to fetch sales for
   * @param fromBlock - Starting block number (optional)
   * @param toBlock - Ending block number (optional)
   * @param limit - Maximum number of results (default: 1000)
   */
  async getNFTSales(
    contractAddress: string,
    fromBlock?: string,
    toBlock?: string,
    limit: number = 1000
  ): Promise<AlchemyNFTSalesResponse | null> {
    try {
      const url = `${this.baseUrl}/nft/v3/${this.apiKey}/getNFTSales`;
      
      const params: any = {
        contractAddress,
        limit,
        order: 'desc' // Get newest sales first
      };

      if (fromBlock) {
        params.fromBlock = fromBlock;
      }
      
      if (toBlock) {
        params.toBlock = toBlock;
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
   * Fetch recent NFT sales for all configured contract addresses
   * @param fromBlock - Starting block number (optional)
   * @param limit - Maximum number of results per contract
   */
  async getAllRecentSales(fromBlock?: string, limit: number = 100): Promise<NFTSale[]> {
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
