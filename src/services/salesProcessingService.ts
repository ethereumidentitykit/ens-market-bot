import { MoralisService, EnhancedNFTSale } from './moralisService';
import { IDatabaseService } from '../types';
import { logger } from '../utils/logger';
import { NFTSale, ProcessedSale } from '../types';
import { MONITORED_CONTRACTS } from '../config/contracts';
import axios from 'axios';

interface ENSMetadata {
  name: string;
  description: string;
  image: string;
  image_url: string;
  attributes: any[];
}

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
    
    // Filter out sales below 0.05 ETH (temp reduced from 0.1)
    if (totalPriceEth < 0.05) {
      logger.debug(`Filtering out sale below 0.05 ETH: ${totalPriceEth} ETH (tx: ${sale.transactionHash})`);
      return false;
    }

    // Add other filters here if needed
    // For example, could filter by specific token ID patterns, marketplaces, etc.
    
    logger.debug(`Sale passes filters: ${totalPriceEth} ETH (tx: ${sale.transactionHash})`);
    return true;
  }

  /**
   * Get the proper collection name from our contracts config, fallback to Moralis name
   */
  private getCollectionName(contractAddress: string, moralisName?: string): string | undefined {
    const contract = MONITORED_CONTRACTS.find(
      c => c.address.toLowerCase() === contractAddress.toLowerCase()
    );
    
    if (contract) {
      logger.debug(`Using contract name "${contract.name}" for ${contractAddress} instead of Moralis name "${moralisName}"`);
      return contract.name;
    }
    
    // Fallback to Moralis name if contract not found in our config
    return moralisName;
  }

  /**
   * Fetch ENS metadata from the official ENS metadata API
   */
  private async fetchENSMetadata(contractAddress: string, tokenId: string): Promise<ENSMetadata | null> {
    try {
      const url = `https://metadata.ens.domains/mainnet/${contractAddress}/${tokenId}`;
      logger.debug(`Fetching ENS metadata from: ${url}`);
      
      const response = await axios.get<ENSMetadata>(url, {
        timeout: 5000, // 5 second timeout
      });
      
      logger.debug(`Successfully fetched ENS metadata: ${response.data.name}`);
      return response.data;
      
    } catch (error: any) {
      logger.warn(`Failed to fetch ENS metadata for ${contractAddress}/${tokenId}:`, error.message);
      return null;
    }
  }

  /**
   * Convert NFTSale (Enhanced from Moralis) to ProcessedSale format
   */
  private async convertToProcessedSale(sale: EnhancedNFTSale): Promise<Omit<ProcessedSale, 'id'>> {
    const priceEth = this.calculateTotalPrice(sale);
    const blockTimestamp = sale.blockTime || this.formatBlockTimestamp(sale.blockNumber);

    // Use Moralis data initially
    let nftName = sale.nftName;
    let nftImage = sale.nftImage;
    let nftDescription = sale.nftDescription;

    // If missing name or image, try ENS metadata API as fallback
    if (!nftName || !nftImage) {
      logger.debug(`Missing metadata from Moralis - name: ${!!nftName}, image: ${!!nftImage}. Trying ENS API...`);
      
      const ensMetadata = await this.fetchENSMetadata(sale.contractAddress, sale.tokenId);
      if (ensMetadata) {
        nftName = nftName || ensMetadata.name;
        nftImage = nftImage || ensMetadata.image;
        nftDescription = nftDescription || ensMetadata.description;
        
        logger.info(`ENS metadata enriched: ${ensMetadata.name} (${sale.transactionHash})`);
      }
    }

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
      // Enhanced metadata (from Moralis + ENS API fallback, override collection name with our config)
      collectionName: this.getCollectionName(sale.contractAddress, sale.collectionName),
      collectionLogo: sale.collectionLogo,
      nftName,
      nftImage,
      nftDescription,
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
    processedSales: ProcessedSale[];
  }> {
    const stats = {
      fetched: 0,
      newSales: 0,
      duplicates: 0,
      filtered: 0,
      errors: 0,
      processedSales: [] as ProcessedSale[],
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
          const processedSale = await this.convertToProcessedSale(sale);
          const saleId = await this.databaseService.insertSale(processedSale);
          
          // Create sale with ID and add to results
          const saleWithId: ProcessedSale = { ...processedSale, id: saleId };
          stats.processedSales.push(saleWithId);
          
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
  public async convertToProcessedSalePublic(sale: EnhancedNFTSale): Promise<Omit<ProcessedSale, 'id'>> {
    return await this.convertToProcessedSale(sale);
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
      processedSales: ProcessedSale[];
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
