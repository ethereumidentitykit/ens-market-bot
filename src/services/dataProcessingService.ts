import { logger } from '../utils/logger';
import { TokenActivity } from './magicEdenService';

/**
 * Insights extracted from token's trading history
 */
export interface TokenInsights {
  firstSale: {
    price: number;
    timestamp: number;
    buyer: string;
    seller: string;
  } | null;
  lastSale: {
    price: number;
    timestamp: number;
    buyer: string;
    seller: string;
  } | null;
  totalVolume: number; // Sum of all sale prices
  numberOfSales: number;
  averageHoldDuration: number; // Average time between sales in hours
  priceDirection: 'increasing' | 'decreasing' | 'stable' | 'unknown';
  
  // Current seller's flip tracking (if determinable)
  sellerAcquisitionTracked: boolean; // Can we track where seller got it?
  sellerBuyPrice: number | null; // What seller paid (if tracked)
  sellerPnl: number | null; // Seller's profit/loss (if tracked)
  sellerHoldDuration: number | null; // How long seller held in hours (if tracked)
}

/**
 * Trading statistics for a user (buyer or seller)
 */
export interface UserStats {
  address: string;
  role: 'buyer' | 'seller';
  
  // Buy statistics
  buysCount: number;
  buysVolume: number;
  
  // Sell statistics
  sellsCount: number;
  sellsVolume: number;
  
  // PNL calculation
  realizedPnl: number; // sellsVolume - buysVolume
  
  // Activity timing
  firstActivityTimestamp: number | null;
  lastActivityTimestamp: number | null;
  transactionsPerMonth: number; // Average monthly transaction rate
  
  // Marketplace preferences
  topMarketplaces: string[]; // Most frequently used marketplaces
}

/**
 * Complete context package for LLM prompts
 */
export interface LLMPromptContext {
  // Current event details
  event: {
    type: 'sale' | 'registration';
    tokenName: string;
    price: number;
    currency: string;
    timestamp: number;
    buyerAddress: string;
    sellerAddress?: string; // Not present for registrations
  };
  
  // Token historical context
  tokenInsights: TokenInsights;
  
  // User activity context
  buyerStats: UserStats;
  sellerStats: UserStats | null; // Null for registrations
  
  // Additional metadata
  metadata: {
    dataFetchedAt: number;
    tokenActivityCount: number;
    buyerActivityCount: number;
    sellerActivityCount: number;
  };
}

/**
 * Data Processing Service for AI Reply Feature
 * Transforms raw Magic Eden activity data into structured insights for LLM consumption
 */
export class DataProcessingService {
  constructor() {
    logger.info('🔬 DataProcessingService initialized');
  }

  /**
   * Extract insights from token's trading history
   * Analyzes price trends, volume, and trading patterns
   * Resolves proxy contracts using transfer events
   * 
   * @param activities - Token activity history from Magic Eden (sales, mints, transfers)
   * @param currentTxHash - Transaction hash of current sale (to exclude from history)
   * @returns Structured token insights
   */
  async processTokenHistory(
    activities: TokenActivity[],
    currentTxHash?: string
  ): Promise<TokenInsights> {
    logger.debug(`🔍 Processing token history: ${activities.length} activities`);
    if (currentTxHash) {
      logger.debug(`   Current tx to exclude: ${currentTxHash}`);
    }
    
    // Separate sales and transfers
    const sales = activities.filter(a => 
      a.type === 'sale' && 
      a.price?.amount?.decimal !== undefined
    );
    const transfers = activities.filter(a => a.type === 'transfer');
    
    logger.debug(`   Found ${sales.length} sales, ${transfers.length} transfers`);
    
    // Resolve real buyer/seller for each sale using transfer events
    const resolvedSales = sales.map(sale => {
      // Skip current transaction if provided
      if (currentTxHash && sale.txHash.toLowerCase() === currentTxHash.toLowerCase()) {
        return null;
      }
      
      // Find transfers with same txHash
      const saleTransfers = transfers.filter(t => 
        t.txHash.toLowerCase() === sale.txHash.toLowerCase()
      );
      
      let realBuyer = sale.toAddress.toLowerCase();
      let realSeller = sale.fromAddress.toLowerCase();
      
      // If there are transfers in same tx, use them to resolve real addresses
      if (saleTransfers.length > 0) {
        // Find the final recipient (last toAddress in transfer chain)
        const finalTransfer = saleTransfers[saleTransfers.length - 1];
        if (finalTransfer.toAddress) {
          realBuyer = finalTransfer.toAddress.toLowerCase();
        }
        
        // Find the original sender (first fromAddress in transfer chain)
        const firstTransfer = saleTransfers[0];
        if (firstTransfer.fromAddress && firstTransfer.fromAddress !== '0x0000000000000000000000000000000000000000') {
          realSeller = firstTransfer.fromAddress.toLowerCase();
        }
        
        logger.debug(`   Resolved ${sale.txHash.slice(0, 10)}...: ${realSeller.slice(0, 8)}... → ${realBuyer.slice(0, 8)}...`);
      }
      
      return {
        ...sale,
        resolvedBuyer: realBuyer,
        resolvedSeller: realSeller
      };
    }).filter(s => s !== null); // Remove current tx if filtered
    
    logger.debug(`   ${resolvedSales.length} historical sales (after filtering current tx)`);
    
    // Sort by timestamp (oldest first)
    resolvedSales.sort((a, b) => a.timestamp - b.timestamp);
    
    // Handle edge cases
    if (resolvedSales.length === 0) {
      logger.debug('   No historical sales found - returning empty insights');
      return {
        firstSale: null,
        lastSale: null,
        totalVolume: 0,
        numberOfSales: 0,
        averageHoldDuration: 0,
        priceDirection: 'unknown',
        sellerAcquisitionTracked: false,
        sellerBuyPrice: null,
        sellerPnl: null,
        sellerHoldDuration: null
      };
    }
    
    // Extract first and last sale
    const firstSale = resolvedSales[0];
    const lastSale = resolvedSales[resolvedSales.length - 1];
    
    // Calculate total volume
    const totalVolume = resolvedSales.reduce((sum, sale) => 
      sum + (sale.price?.amount?.decimal || 0), 0
    );
    
    // Calculate average hold duration (time between sales)
    let averageHoldDuration = 0;
    if (resolvedSales.length > 1) {
      const durations = [];
      for (let i = 1; i < resolvedSales.length; i++) {
        const durationSeconds = resolvedSales[i].timestamp - resolvedSales[i - 1].timestamp;
        durations.push(durationSeconds / 3600); // Convert to hours
      }
      averageHoldDuration = durations.reduce((sum, d) => sum + d, 0) / durations.length;
    }
    
    // Determine price direction (comparing first to last sale)
    let priceDirection: 'increasing' | 'decreasing' | 'stable' | 'unknown' = 'unknown';
    if (resolvedSales.length > 1) {
      const firstPrice = firstSale.price.amount.decimal;
      const lastPrice = lastSale.price.amount.decimal;
      const priceChange = ((lastPrice - firstPrice) / firstPrice) * 100;
      
      if (priceChange > 10) {
        priceDirection = 'increasing';
      } else if (priceChange < -10) {
        priceDirection = 'decreasing';
      } else {
        priceDirection = 'stable';
      }
      
      logger.debug(`   Price direction: ${priceDirection} (${priceChange.toFixed(1)}% change)`);
    } else {
      priceDirection = 'stable'; // Only 1 sale, consider stable
    }
    
    // Track seller's acquisition and PNL (if determinable)
    let sellerAcquisitionTracked = false;
    let sellerBuyPrice: number | null = null;
    let sellerPnl: number | null = null;
    let sellerHoldDuration: number | null = null;
    
    // Check if last sale's seller was the previous sale's buyer
    if (resolvedSales.length >= 2) {
      const previousSale = resolvedSales[resolvedSales.length - 2];
      const currentSeller = lastSale.resolvedSeller;
      const previousBuyer = previousSale.resolvedBuyer;
      
      if (currentSeller === previousBuyer) {
        // Seller acquired it in the previous sale!
        sellerAcquisitionTracked = true;
        sellerBuyPrice = previousSale.price.amount.decimal;
        sellerPnl = lastSale.price.amount.decimal - sellerBuyPrice;
        sellerHoldDuration = (lastSale.timestamp - previousSale.timestamp) / 3600; // hours
        
        logger.debug(`   ✅ Seller PNL tracked: bought for ${sellerBuyPrice.toFixed(4)} ETH, held ${sellerHoldDuration.toFixed(1)}h, PNL: ${sellerPnl >= 0 ? '+' : ''}${sellerPnl.toFixed(4)} ETH`);
      } else {
        logger.debug(`   ❌ Seller PNL not trackable: seller ${currentSeller.slice(0, 8)}... ≠ previous buyer ${previousBuyer.slice(0, 8)}...`);
      }
    }
    
    const insights: TokenInsights = {
      firstSale: {
        price: firstSale.price.amount.decimal,
        timestamp: firstSale.timestamp,
        buyer: firstSale.resolvedBuyer,
        seller: firstSale.resolvedSeller
      },
      lastSale: {
        price: lastSale.price.amount.decimal,
        timestamp: lastSale.timestamp,
        buyer: lastSale.resolvedBuyer,
        seller: lastSale.resolvedSeller
      },
      totalVolume,
      numberOfSales: resolvedSales.length,
      averageHoldDuration,
      priceDirection,
      sellerAcquisitionTracked,
      sellerBuyPrice,
      sellerPnl,
      sellerHoldDuration
    };
    
    logger.debug(`   ✅ Token insights: ${resolvedSales.length} sales, ${totalVolume.toFixed(4)} ETH volume, ${priceDirection} trend`);
    
    return insights;
  }

  /**
   * Calculate trading statistics for a user
   * Tracks buy/sell volumes, PNL, and activity patterns
   * 
   * @param activities - User activity history from Magic Eden
   * @param role - Whether this user is the buyer or seller in current event
   * @returns User trading statistics
   */
  async processUserActivity(
    activities: TokenActivity[],
    role: 'buyer' | 'seller'
  ): Promise<UserStats> {
    logger.debug(`👤 Processing user activity: ${activities.length} activities (${role})`);
    
    // TODO: Implementation in Task 1.6
    throw new Error('Not implemented yet');
  }

  /**
   * Build complete LLM prompt context from all data sources
   * Combines token insights, buyer stats, and seller stats into one package
   * 
   * @param eventData - Current sale or registration event details
   * @param tokenActivities - Token's trading history
   * @param buyerActivities - Buyer's activity history
   * @param sellerActivities - Seller's activity history (null for registrations)
   * @returns Complete context for LLM prompt
   */
  async buildLLMContext(
    eventData: {
      type: 'sale' | 'registration';
      tokenName: string;
      price: number;
      currency: string;
      timestamp: number;
      buyerAddress: string;
      sellerAddress?: string;
    },
    tokenActivities: TokenActivity[],
    buyerActivities: TokenActivity[],
    sellerActivities: TokenActivity[] | null
  ): Promise<LLMPromptContext> {
    logger.info(`🧠 Building LLM context for ${eventData.type}: ${eventData.tokenName}`);
    
    // TODO: Implementation in Task 1.7
    throw new Error('Not implemented yet');
  }
}

// Export singleton instance
export const dataProcessingService = new DataProcessingService();

