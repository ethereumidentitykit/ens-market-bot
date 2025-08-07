import { AlchemyService } from './alchemyService';
import { DatabaseService } from './databaseService';
import { logger } from '../utils/logger';
import { NFTSale, ProcessedSale } from '../types';

export class SalesProcessingService {
  private alchemyService: AlchemyService;
  private databaseService: DatabaseService;

  constructor(alchemyService: AlchemyService, databaseService: DatabaseService) {
    this.alchemyService = alchemyService;
    this.databaseService = databaseService;
  }

  /**
   * Convert Wei to ETH string
   */
  private weiToEth(weiAmount: string): string {
    try {
      const wei = BigInt(weiAmount);
      const eth = Number(wei) / Math.pow(10, 18);
      return eth.toFixed(6); // 6 decimal places for ETH
    } catch (error) {
      logger.warn(`Failed to convert Wei to ETH: ${weiAmount}`, error);
      return '0';
    }
  }

  /**
   * Calculate total sale price from all fees
   */
  private calculateTotalPrice(sale: NFTSale): string {
    try {
      const sellerFee = BigInt(sale.sellerFee.amount);
      const protocolFee = BigInt(sale.protocolFee.amount);
      const royaltyFee = BigInt(sale.royaltyFee.amount);
      
      const totalWei = sellerFee + protocolFee + royaltyFee;
      return this.weiToEth(totalWei.toString());
    } catch (error) {
      logger.warn('Failed to calculate total price for sale:', error);
      return this.weiToEth(sale.sellerFee.amount); // Fallback to seller fee only
    }
  }

  /**
   * Convert blockchain timestamp to ISO string
   */
  private formatBlockTimestamp(blockNumber: number): string {
    // For now, use current timestamp since we don't have block timestamp from Alchemy
    // In a more complete implementation, we'd fetch this from another API
    return new Date().toISOString();
  }

  /**
   * Convert NFTSale to ProcessedSale format
   */
  private convertToProcessedSale(sale: NFTSale): Omit<ProcessedSale, 'id'> {
    const priceEth = this.calculateTotalPrice(sale);
    const blockTimestamp = this.formatBlockTimestamp(sale.blockNumber);

    return {
      transactionHash: sale.transactionHash,
      contractAddress: sale.contractAddress.toLowerCase(),
      tokenId: sale.tokenId,
      marketplace: sale.marketplace,
      buyerAddress: sale.buyerAddress.toLowerCase(),
      sellerAddress: sale.sellerAddress.toLowerCase(),
      priceEth,
      priceUsd: undefined, // Will be populated later if needed
      blockNumber: sale.blockNumber,
      blockTimestamp,
      processedAt: new Date().toISOString(),
      posted: false,
    };
  }

  /**
   * Process new sales from Alchemy API
   * Fetches recent sales and stores only new ones in database
   */
  async processNewSales(): Promise<{
    fetched: number;
    newSales: number;
    duplicates: number;
    errors: number;
  }> {
    const stats = {
      fetched: 0,
      newSales: 0,
      duplicates: 0,
      errors: 0,
    };

    try {
      logger.info('Starting to process new sales...');

      // Get last processed block to optimize fetching
      const lastProcessedBlock = await this.databaseService.getSystemState('last_processed_block');
      const fromBlock = lastProcessedBlock || undefined;

      logger.info(`Fetching sales from block: ${fromBlock || 'genesis'}`);

      // Fetch recent sales from all contracts
      const recentSales = await this.alchemyService.getAllRecentSales(fromBlock, 100);
      stats.fetched = recentSales.length;

      logger.info(`Fetched ${recentSales.length} recent sales from Alchemy`);

      if (recentSales.length === 0) {
        logger.info('No new sales found');
        return stats;
      }

      // Process each sale
      let highestBlockNumber = 0;

      for (const sale of recentSales) {
        try {
          // Check if already processed
          const isAlreadyProcessed = await this.databaseService.isSaleProcessed(sale.transactionHash);
          
          if (isAlreadyProcessed) {
            stats.duplicates++;
            logger.debug(`Skipping duplicate sale: ${sale.transactionHash}`);
            continue;
          }

          // Convert and store the sale
          const processedSale = this.convertToProcessedSale(sale);
          await this.databaseService.insertSale(processedSale);
          
          stats.newSales++;
          highestBlockNumber = Math.max(highestBlockNumber, sale.blockNumber);

          logger.debug(`Processed new sale: ${sale.transactionHash} for ${processedSale.priceEth} ETH`);

        } catch (error: any) {
          stats.errors++;
          logger.error(`Failed to process sale ${sale.transactionHash}:`, error.message);
        }
      }

      // Update last processed block
      if (highestBlockNumber > 0) {
        await this.databaseService.setSystemState('last_processed_block', highestBlockNumber.toString());
        logger.info(`Updated last processed block to: ${highestBlockNumber}`);
      }

      logger.info(`Sales processing completed:`, stats);
      return stats;

    } catch (error: any) {
      logger.error('Failed to process new sales:', error.message);
      throw error;
    }
  }

  /**
   * Get sales ready for Twitter posting
   * Returns unposted sales in chronological order
   */
  async getSalesForPosting(limit: number = 5): Promise<ProcessedSale[]> {
    try {
      const unpostedSales = await this.databaseService.getUnpostedSales(limit);
      logger.info(`Found ${unpostedSales.length} sales ready for posting`);
      return unpostedSales;
    } catch (error: any) {
      logger.error('Failed to get sales for posting:', error.message);
      throw error;
    }
  }

  /**
   * Mark a sale as posted
   */
  async markSaleAsPosted(saleId: number, tweetId: string): Promise<void> {
    try {
      await this.databaseService.markAsPosted(saleId, tweetId);
      logger.info(`Marked sale ${saleId} as posted with tweet ${tweetId}`);
    } catch (error: any) {
      logger.error(`Failed to mark sale ${saleId} as posted:`, error.message);
      throw error;
    }
  }

  /**
   * Get processing statistics
   */
  async getProcessingStats(): Promise<{
    database: {
      totalSales: number;
      postedSales: number;
      unpostedSales: number;
      lastProcessedBlock: string | null;
    };
    recentSales: ProcessedSale[];
  }> {
    try {
      const dbStats = await this.databaseService.getStats();
      const recentSales = await this.databaseService.getRecentSales(10);

      return {
        database: dbStats,
        recentSales,
      };
    } catch (error: any) {
      logger.error('Failed to get processing stats:', error.message);
      throw error;
    }
  }

  /**
   * Manually trigger sales processing (for testing/admin use)
   */
  async manualSync(): Promise<{
    success: boolean;
    stats?: {
      fetched: number;
      newSales: number;
      duplicates: number;
      errors: number;
    };
    error?: string;
  }> {
    try {
      logger.info('Manual sync triggered');
      const stats = await this.processNewSales();
      
      return {
        success: true,
        stats,
      };
    } catch (error: any) {
      logger.error('Manual sync failed:', error.message);
      return {
        success: false,
        error: error.message,
      };
    }
  }
}
