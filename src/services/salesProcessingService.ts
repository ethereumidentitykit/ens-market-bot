import { MoralisService, EnhancedNFTSale } from './moralisService';
import { IDatabaseService } from '../types';
import { logger } from '../utils/logger';
import { NFTSale, ProcessedSale } from '../types';

export class SalesProcessingService {
  private moralisService: MoralisService;
  private databaseService: IDatabaseService;

  constructor(moralisService: MoralisService, databaseService: IDatabaseService) {
    this.moralisService = moralisService;
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
   * Handles both ETH and WETH (both use 18 decimals)
   */
  private calculateTotalPrice(sale: EnhancedNFTSale): string {
    try {
      // Log the currency symbols for debugging
      logger.debug(`Processing sale with currencies - Seller: ${sale.sellerFee.symbol}, Protocol: ${sale.protocolFee.symbol}, Royalty: ${sale.royaltyFee.symbol}`);
      
      // Handle null/empty fee amounts safely
      const sellerFee = sale.sellerFee.amount ? BigInt(sale.sellerFee.amount) : BigInt(0);
      const protocolFee = sale.protocolFee.amount ? BigInt(sale.protocolFee.amount) : BigInt(0);
      const royaltyFee = sale.royaltyFee.amount ? BigInt(sale.royaltyFee.amount) : BigInt(0);
      
      const totalWei = sellerFee + protocolFee + royaltyFee;
      
      // Both ETH and WETH use 18 decimals, so we can treat them the same for price calculation
      const ethValue = this.weiToEth(totalWei.toString());
      
      logger.debug(`Calculated total price: ${ethValue} ETH for tx ${sale.transactionHash}`);
      return ethValue;
    } catch (error) {
      logger.warn(`Failed to calculate total price for sale ${sale.transactionHash}:`, error);
      logger.warn(`Fee amounts - Seller: ${sale.sellerFee.amount}, Protocol: ${sale.protocolFee.amount}, Royalty: ${sale.royaltyFee.amount}`);
      
      // Fallback to seller fee only with null safety
      const fallbackAmount = sale.sellerFee.amount || '0';
      return this.weiToEth(fallbackAmount);
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
   * Filter sales based on minimum price and other criteria
   */
  private shouldProcessSale(sale: EnhancedNFTSale): boolean {
    // Calculate total price in ETH
    const totalPriceEth = parseFloat(this.calculateTotalPrice(sale));
    
    // Filter out sales below 0.1 ETH
    if (totalPriceEth < 0.1) {
      logger.debug(`Filtering out sale below 0.1 ETH: ${totalPriceEth} ETH (tx: ${sale.transactionHash})`);
      return false;
    }

    // Add other filters here if needed
    // For example, could filter by specific token ID patterns, marketplaces, etc.
    
    logger.debug(`Sale passes filters: ${totalPriceEth} ETH (tx: ${sale.transactionHash})`);
    return true;
  }

  /**
   * Convert NFTSale (Enhanced from Moralis) to ProcessedSale format
   */
  private convertToProcessedSale(sale: EnhancedNFTSale): Omit<ProcessedSale, 'id'> {
    const priceEth = this.calculateTotalPrice(sale);
    const blockTimestamp = sale.blockTime || this.formatBlockTimestamp(sale.blockNumber);

    return {
      transactionHash: sale.transactionHash,
      contractAddress: sale.contractAddress.toLowerCase(),
      tokenId: sale.tokenId,
      marketplace: sale.marketplace,
      buyerAddress: sale.buyerAddress.toLowerCase(),
      sellerAddress: sale.sellerAddress.toLowerCase(),
      priceEth,
      priceUsd: sale.currentUsdValue || undefined, // Use Moralis USD value if available
      blockNumber: sale.blockNumber,
      blockTimestamp,
      processedAt: new Date().toISOString(),
      posted: false,
      // Enhanced metadata from Moralis
      collectionName: sale.collectionName,
      collectionLogo: sale.collectionLogo,
      nftName: sale.nftName,
      nftImage: sale.nftImage,
      nftDescription: sale.nftDescription,
      marketplaceLogo: sale.marketplaceLogo,
      currentUsdValue: sale.currentUsdValue,
      verifiedCollection: sale.verifiedCollection,
    };
  }

  /**
   * Process new sales from Moralis API (with block filtering >= 22M)
   * Fetches recent sales and stores only new ones in database
   */
  async processNewSales(): Promise<{
    fetched: number;
    newSales: number;
    duplicates: number;
    filtered: number;
    errors: number;
  }> {
    const stats = {
      fetched: 0,
      newSales: 0,
      duplicates: 0,
      filtered: 0,
      errors: 0,
    };

    try {
      logger.info('Starting to process new sales from Moralis using incremental fetch...');

      // Get last processed block to optimize fetching
      const lastProcessedBlockStr = await this.databaseService.getSystemState('last_processed_block');
      
      // Determine starting block for incremental fetch
      let lastProcessedBlock: number;
      if (lastProcessedBlockStr && parseInt(lastProcessedBlockStr) >= 23000000) {
        lastProcessedBlock = parseInt(lastProcessedBlockStr);
        logger.info(`Using incremental fetch from last processed block: ${lastProcessedBlock}`);
      } else {
        // If no lastProcessedBlock, get the highest block from database
        const recentSales = await this.databaseService.getRecentSales(1);
        if (recentSales.length > 0) {
          lastProcessedBlock = recentSales[0].blockNumber;
          logger.info(`No lastProcessedBlock found, using highest DB block: ${lastProcessedBlock}`);
        } else {
          lastProcessedBlock = 23000000; // Default to 23M minimum
          logger.info(`Empty database, using incremental fetch from default block: ${lastProcessedBlock}`);
        }
      }

      // Fetch only new sales using cursor pagination with limit=10
      const recentSales = await this.moralisService.getIncrementalTrades(lastProcessedBlock, 10);
      stats.fetched = recentSales.length;

      logger.info(`Fetched ${recentSales.length} new sales from incremental fetch`);

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

          // Apply filters (minimum price, etc.)
          if (!this.shouldProcessSale(sale)) {
            stats.filtered++;
            logger.debug(`Skipping sale that doesn't meet criteria: ${sale.transactionHash}`);
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

      const filteringRate = stats.fetched > 0 ? (stats.filtered / stats.fetched * 100).toFixed(1) : '0';
      logger.info(`Sales processing completed:`, {
        ...stats,
        filteringRate: `${filteringRate}%`
      });
      return stats;

    } catch (error: any) {
      logger.error('Failed to process new sales:', error.message);
      throw error;
    }
  }

  /**
   * Public method to check if a sale should be processed (filters)
   */
  public shouldProcessSalePublic(sale: EnhancedNFTSale): boolean {
    return this.shouldProcessSale(sale);
  }

  /**
   * Public method to convert sale to processed format
   */
  public convertToProcessedSalePublic(sale: EnhancedNFTSale): Omit<ProcessedSale, 'id'> {
    return this.convertToProcessedSale(sale);
  }

  /**
   * Public method to calculate total price
   */
  public calculateTotalPricePublic(sale: EnhancedNFTSale): string {
    return this.calculateTotalPrice(sale);
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
