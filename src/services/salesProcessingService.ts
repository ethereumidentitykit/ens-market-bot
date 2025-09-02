import { MoralisService, EnhancedNFTSale } from './moralisService';
import { IDatabaseService } from '../types';
import { logger } from '../utils/logger';
import { NFTSale, ProcessedSale } from '../types';
import { MONITORED_CONTRACTS } from '../config/contracts';
import { config } from '../utils/config';
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
   * Apply WETH price correction if needed
   * Moralis API bug: WETH sales are reported with double the actual price
   */
  private applyWethPriceCorrection(
    sale: EnhancedNFTSale, 
    ethPrice: string, 
    usdPrice?: string
  ): { applied: boolean; correctedEthPrice: string; correctedUsdPrice?: string } {
    // Check if this is a WETH sale and multiplier is not 1.0
    const isWethSale = this.isWethSale(sale);
    const multiplier = config.wethPriceMultiplier;
    
    if (!isWethSale || multiplier === 1.0) {
      return {
        applied: false,
        correctedEthPrice: ethPrice,
        correctedUsdPrice: usdPrice
      };
    }
    
    // Apply multiplier to ETH price
    const originalEthPrice = parseFloat(ethPrice);
    const correctedEthPrice = (originalEthPrice * multiplier).toFixed(8);
    
    // Apply multiplier to USD price if available
    let correctedUsdPrice = usdPrice;
    if (usdPrice) {
      const originalUsdPrice = parseFloat(usdPrice);
      correctedUsdPrice = (originalUsdPrice * multiplier).toFixed(2);
    }
    
    // Log the correction
    logger.info(`🔧 WETH price correction applied (${multiplier}x): ${sale.transactionHash}`);
    logger.info(`   ETH: ${ethPrice} → ${correctedEthPrice}`);
    if (usdPrice && correctedUsdPrice) {
      logger.info(`   USD: $${usdPrice} → $${correctedUsdPrice}`);
    }
    
    return {
      applied: true,
      correctedEthPrice,
      correctedUsdPrice
    };
  }
  
  /**
   * Check if this is a WETH sale by examining the price token address
   */
  private isWethSale(sale: EnhancedNFTSale): boolean {
    const wethAddresses = [
      '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2', // WETH mainnet
      '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2'  // WETH mainnet (different case)
    ];
    
    if (!sale.priceTokenAddress) {
      return false;
    }
    
    return wethAddresses.includes(sale.priceTokenAddress.toLowerCase());
  }

  /**
   * Filter sales based on minimum price and other criteria
   */
  private shouldProcessSale(sale: EnhancedNFTSale): boolean {
    // Calculate total price in ETH with WETH correction applied
    let totalPriceEth = parseFloat(this.calculateTotalPrice(sale));
    
    // Apply WETH price correction for filtering (same logic as in convertToProcessedSale)
    if (this.isWethSale(sale) && config.wethPriceMultiplier !== 1.0) {
      const originalPrice = totalPriceEth;
      totalPriceEth = totalPriceEth * config.wethPriceMultiplier;
      logger.debug(`WETH price correction for filtering: ${originalPrice} ETH → ${totalPriceEth} ETH (multiplier: ${config.wethPriceMultiplier})`);
    }
    
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
    let priceEth = this.calculateTotalPrice(sale);
    let priceUsd = sale.currentUsdValue;
    
    // Apply WETH price multiplier if this is a WETH sale
    const wethMultiplier = this.applyWethPriceCorrection(sale, priceEth, priceUsd);
    if (wethMultiplier.applied) {
      priceEth = wethMultiplier.correctedEthPrice;
      priceUsd = wethMultiplier.correctedUsdPrice;
    }
    
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
      priceUsd: priceUsd || undefined, // Use corrected USD value if WETH was applied
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

      // Fetch only new sales using cursor pagination with limit=5
      const recentSales = await this.moralisService.getIncrementalTrades(lastProcessedBlock, 5);
      stats.fetched = recentSales.length;

      logger.info(`Fetched ${recentSales.length} new sales from incremental fetch`);

      // Calculate highest block number from ALL fetched sales (regardless of processing outcome)
      let highestFetchedBlockNumber = lastProcessedBlock;
      if (recentSales.length > 0) {
        highestFetchedBlockNumber = Math.max(...recentSales.map(sale => sale.blockNumber));
      }

      if (recentSales.length === 0) {
        logger.info('No new sales found - but still updating block position to avoid re-fetching empty ranges');
        // Update last processed block even when no sales found to avoid re-fetching same empty range
        await this.databaseService.setSystemState('last_processed_block', highestFetchedBlockNumber.toString());
        return stats;
      }

      // Process each sale
      let highestProcessedBlockNumber = 0;

      for (const sale of recentSales) {
        try {
          // Check if already processed
          const isAlreadyProcessed = await this.databaseService.isSaleProcessed(sale.tokenId);
          
          if (isAlreadyProcessed) {
            stats.duplicates++;
            logger.info(`🚀 QuickNode beat Moralis! Sale already processed: ${sale.transactionHash} (${sale.tokenId})`);
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
          
          stats.newSales++;
          highestProcessedBlockNumber = Math.max(highestProcessedBlockNumber, sale.blockNumber);

          logger.info(`✅ Moralis sale stored in DB: ${processedSale.nftName || sale.tokenId} (${processedSale.priceEth} ETH) - ID: ${saleId}`);

        } catch (error: any) {
          stats.errors++;
          logger.error(`Failed to process sale ${sale.transactionHash}:`, error.message);
        }
      }

      // Update last processed block based on highest fetched block (not just processed)
      // This prevents re-fetching the same blocks even if all sales were filtered out
      await this.databaseService.setSystemState('last_processed_block', highestFetchedBlockNumber.toString());
      logger.info(`Updated last processed block to: ${highestFetchedBlockNumber} (processed: ${stats.newSales}, filtered: ${stats.filtered})`);

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
  async getSalesForPosting(limit: number = 5, maxAgeHours: number = 1): Promise<ProcessedSale[]> {
    try {
      const unpostedSales = await this.databaseService.getUnpostedSales(limit, maxAgeHours);
      logger.info(`Found ${unpostedSales.length} sales ready for posting (within ${maxAgeHours}h)`);
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
      filtered: number;
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
