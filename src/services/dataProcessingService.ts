import { logger } from '../utils/logger';
import { TokenActivity } from './magicEdenService';

/**
 * Insights extracted from token's trading history
 */
export interface TokenInsights {
  firstSale: {
    price: number;
    priceUsd: number;
    timestamp: number;
    buyer: string;
    seller: string;
  } | null;
  lastSale: {
    price: number;
    priceUsd: number;
    timestamp: number;
    buyer: string;
    seller: string;
  } | null;
  totalVolume: number; // Sum of all sale prices (ETH)
  totalVolumeUsd: number; // Sum of all sale prices (USD)
  numberOfSales: number;
  averageHoldDuration: number; // Average time between sales in hours
  priceDirection: 'increasing' | 'decreasing' | 'stable' | 'unknown';
  
  // Current seller's flip tracking (if determinable)
  sellerAcquisitionTracked: boolean; // Can we track where seller got it?
  sellerBuyPrice: number | null; // What seller paid in ETH (if tracked)
  sellerBuyPriceUsd: number | null; // What seller paid in USD (if tracked)
  sellerPnl: number | null; // Seller's profit/loss in ETH (if tracked)
  sellerPnlUsd: number | null; // Seller's profit/loss in USD (if tracked)
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
  buysVolume: number; // Total ETH spent
  buysVolumeUsd: number; // Total USD spent
  
  // Sell statistics
  sellsCount: number;
  sellsVolume: number; // Total ETH received
  sellsVolumeUsd: number; // Total USD received
  
  // Activity timing
  firstActivityTimestamp: number | null;
  lastActivityTimestamp: number | null;
  transactionsPerMonth: number; // Average monthly transaction rate
  
  // Marketplace preferences
  topMarketplaces: string[]; // Most frequently used marketplaces
}

/**
 * Complete context package for LLM prompts
 * Combines data from DATABASE (event details) and Magic Eden API (historical context)
 */
export interface LLMPromptContext {
  // Current event details (FROM DATABASE - master source of truth)
  event: {
    type: 'sale' | 'registration';
    tokenName: string;
    price: number;
    priceUsd: number;
    currency: string;
    timestamp: number;
    buyerAddress: string;
    sellerAddress?: string; // Not present for registrations
    txHash: string; // Transaction hash from DB
  };
  
  // Token historical context (FROM MAGIC EDEN API)
  tokenInsights: TokenInsights;
  
  // User activity context (FROM MAGIC EDEN API)
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
  // Known marketplace proxy contracts (matches QuickNodeSalesService and MagicEdenService)
  private readonly KNOWN_PROXY_CONTRACTS = [
    '0x0000a26b00c1f0df003000390027140000faa719', // OpenSea WETH wrapper
    '0xe6ee2b1eaac6520be709e77780abb50e7fffcccd', // Seaport proxy
    '0x00ca04c45da318d5b7e7b14d5381ca59f09c73f0', // Additional proxy
  ];

  constructor() {
    logger.info('🔬 DataProcessingService initialized');
  }

  /**
   * Check if an address is a known proxy contract
   */
  private isKnownProxy(address: string): boolean {
    const normalized = address.toLowerCase();
    return this.KNOWN_PROXY_CONTRACTS.includes(normalized);
  }

  /**
   * Resolve proxy addresses for a specific transaction by fetching token transfers
   * Only called when a proxy is detected in user activity
   * 
   * @param activity - Sale/mint activity with proxy address
   * @param magicEdenService - MagicEdenService instance for fetching token data
   * @returns Resolved buyer and seller addresses
   */
  private async resolveProxyForActivity(
    activity: TokenActivity,
    magicEdenService: any
  ): Promise<{
    resolvedBuyer: string;
    resolvedSeller: string;
  }> {
    try {
      // Fetch just this token's activity (including transfers) - limit to recent activity
      const tokenActivities = await magicEdenService.getTokenActivityHistory(
        activity.contract,
        activity.token.tokenId,
        { types: ['sale', 'mint', 'transfer'], maxPages: 2 }  // Only fetch recent pages
      );
      
      // Find transfers matching this transaction
      const transfers = tokenActivities.filter((a: TokenActivity) => 
        a.type === 'transfer' && 
        a.txHash.toLowerCase() === activity.txHash.toLowerCase()
      );
      
      if (transfers.length > 0) {
        // Use transfer chain to resolve
        const finalTransfer = transfers[transfers.length - 1];
        const firstTransfer = transfers[0];
        
        return {
          resolvedBuyer: finalTransfer.toAddress?.toLowerCase() || activity.toAddress.toLowerCase(),
          resolvedSeller: firstTransfer.fromAddress?.toLowerCase() || activity.fromAddress.toLowerCase()
        };
      }
      
      // No transfers found, return original addresses
      return {
        resolvedBuyer: activity.toAddress.toLowerCase(),
        resolvedSeller: activity.fromAddress.toLowerCase()
      };
      
    } catch (error: any) {
      logger.warn(`Failed to resolve proxy for tx ${activity.txHash.slice(0, 10)}...: ${error.message}`);
      // On error, return original addresses
      return {
        resolvedBuyer: activity.toAddress.toLowerCase(),
        resolvedSeller: activity.fromAddress.toLowerCase()
      };
    }
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
    logger.debug(`🔍 Processing token history: ${activities.length} total activities`);
    if (currentTxHash) {
      logger.debug(`   Current tx to exclude: ${currentTxHash}`);
    }
    
    // Separate sales and transfers
    const sales = activities.filter(a => 
      a.type === 'sale' && 
      a.price?.amount?.decimal !== undefined
    );
    const transfers = activities.filter(a => a.type === 'transfer');
    
    logger.debug(`   Found ${sales.length} sales (before filtering), ${transfers.length} transfers`);
    
    // Log all sale txHashes for debugging
    if (sales.length > 0) {
      logger.debug(`   Sale txHashes: ${sales.slice(0, 3).map(s => s.txHash.slice(0, 10) + '...').join(', ')}${sales.length > 3 ? ` (+${sales.length - 3} more)` : ''}`);
    }
    
    // Resolve real buyer/seller for each sale using transfer events
    const resolvedSales = sales.map(sale => {
      // Skip current transaction if provided
      if (currentTxHash && sale.txHash.toLowerCase() === currentTxHash.toLowerCase()) {
        logger.debug(`   Filtering out current tx: ${sale.txHash.slice(0, 10)}...`);
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
        totalVolumeUsd: 0,
        numberOfSales: 0,
        averageHoldDuration: 0,
        priceDirection: 'unknown',
        sellerAcquisitionTracked: false,
        sellerBuyPrice: null,
        sellerBuyPriceUsd: null,
        sellerPnl: null,
        sellerPnlUsd: null,
        sellerHoldDuration: null
      };
    }
    
    // Extract first and last sale
    const firstSale = resolvedSales[0];
    const lastSale = resolvedSales[resolvedSales.length - 1];
    
    // Calculate total volume (ETH and USD)
    const totalVolume = resolvedSales.reduce((sum, sale) => 
      sum + (sale.price?.amount?.decimal || 0), 0
    );
    const totalVolumeUsd = resolvedSales.reduce((sum, sale) => 
      sum + (sale.price?.amount?.usd || 0), 0
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
    let sellerBuyPriceUsd: number | null = null;
    let sellerPnl: number | null = null;
    let sellerPnlUsd: number | null = null;
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
        sellerBuyPriceUsd = previousSale.price.amount.usd;
        sellerPnl = lastSale.price.amount.decimal - sellerBuyPrice;
        sellerPnlUsd = lastSale.price.amount.usd - sellerBuyPriceUsd;
        sellerHoldDuration = (lastSale.timestamp - previousSale.timestamp) / 3600; // hours
        
        logger.debug(`   ✅ Seller PNL tracked: bought for ${sellerBuyPrice.toFixed(4)} ETH ($${sellerBuyPriceUsd.toFixed(2)}), held ${sellerHoldDuration.toFixed(1)}h`);
        logger.debug(`      PNL: ${sellerPnl >= 0 ? '+' : ''}${sellerPnl.toFixed(4)} ETH (${sellerPnlUsd >= 0 ? '+' : ''}$${sellerPnlUsd.toFixed(2)})`);
      } else {
        logger.debug(`   ❌ Seller PNL not trackable: seller ${currentSeller.slice(0, 8)}... ≠ previous buyer ${previousBuyer.slice(0, 8)}...`);
      }
    }
    
    const insights: TokenInsights = {
      firstSale: {
        price: firstSale.price.amount.decimal,
        priceUsd: firstSale.price.amount.usd,
        timestamp: firstSale.timestamp,
        buyer: firstSale.resolvedBuyer,
        seller: firstSale.resolvedSeller
      },
      lastSale: {
        price: lastSale.price.amount.decimal,
        priceUsd: lastSale.price.amount.usd,
        timestamp: lastSale.timestamp,
        buyer: lastSale.resolvedBuyer,
        seller: lastSale.resolvedSeller
      },
      totalVolume,
      totalVolumeUsd,
      numberOfSales: resolvedSales.length,
      averageHoldDuration,
      priceDirection,
      sellerAcquisitionTracked,
      sellerBuyPrice,
      sellerBuyPriceUsd,
      sellerPnl,
      sellerPnlUsd,
      sellerHoldDuration
    };
    
    logger.debug(`   ✅ Token insights: ${resolvedSales.length} sales, ${totalVolume.toFixed(4)} ETH ($${totalVolumeUsd.toFixed(2)}) volume, ${priceDirection} trend`);
    
    return insights;
  }

  /**
   * Calculate trading statistics for a user
   * Tracks buy/sell volumes, PNL, and activity patterns
   * Resolves proxy contracts on-demand by fetching token transfers
   * 
   * @param activities - User activity history from Magic Eden (sales, mints only)
   * @param userAddress - The address of the user we're analyzing (already resolved from DB)
   * @param role - Whether this user is the buyer or seller in current event
   * @param magicEdenService - MagicEdenService instance for on-demand token data fetching
   * @returns User trading statistics
   */
  async processUserActivity(
    activities: TokenActivity[],
    userAddress: string,
    role: 'buyer' | 'seller',
    magicEdenService?: any
  ): Promise<UserStats> {
    logger.debug(`👤 Processing user activity: ${activities.length} activities for ${userAddress.slice(0, 8)}... (${role})`);
    
    // Normalize address for comparison (DB already resolved proxies)
    const normalizedAddress = userAddress.toLowerCase();
    
    // Filter for sales/mints with valid prices
    const salesAndMints = activities.filter(a => 
      (a.type === 'sale' || a.type === 'mint') &&
      a.price?.amount?.decimal !== undefined
    );
    
    logger.debug(`   Found ${salesAndMints.length} sales/mints`);
    
    // Check which activities have known proxy addresses
    const activitiesWithProxies = salesAndMints.filter(a => 
      this.isKnownProxy(a.fromAddress) || this.isKnownProxy(a.toAddress)
    );
    
    if (activitiesWithProxies.length > 0) {
      logger.debug(`   ⚠️  Detected ${activitiesWithProxies.length} activities with proxies - will resolve on-demand`);
    }
    
    // Process each activity - resolve proxies on-demand if magicEdenService is provided
    const resolvedActivities = await Promise.all(
      salesAndMints.map(async (activity) => {
        // Check if this activity has a proxy
        const hasProxy = this.isKnownProxy(activity.fromAddress) || this.isKnownProxy(activity.toAddress);
        
        if (hasProxy && magicEdenService) {
          // Lazy-fetch token transfers for this specific transaction
          const resolved = await this.resolveProxyForActivity(activity, magicEdenService);
          return {
            ...activity,
            ...resolved
          };
        } else {
          // No proxy or no service provided, use addresses directly
          return {
            ...activity,
            resolvedBuyer: activity.toAddress.toLowerCase(),
            resolvedSeller: activity.fromAddress.toLowerCase()
          };
        }
      })
    );
    
    const proxiesResolved = magicEdenService ? activitiesWithProxies.length : 0;
    logger.debug(`   Processed ${resolvedActivities.length} activities (${proxiesResolved} proxies resolved)`);
    
    // Separate buys vs sells using RESOLVED addresses
    const buys = resolvedActivities.filter(a => 
      a.resolvedBuyer === normalizedAddress
    );
    const sells = resolvedActivities.filter(a => 
      a.resolvedSeller === normalizedAddress &&
      a.resolvedSeller !== '0x0000000000000000000000000000000000000000' // Exclude mints
    );
    
    logger.debug(`   Buys: ${buys.length}, Sells: ${sells.length}`);
    
    // Calculate buy statistics
    const buysCount = buys.length;
    const buysVolume = buys.reduce((sum, activity) => 
      sum + activity.price.amount.decimal, 0
    );
    const buysVolumeUsd = buys.reduce((sum, activity) => 
      sum + activity.price.amount.usd, 0
    );
    
    // Calculate sell statistics
    const sellsCount = sells.length;
    const sellsVolume = sells.reduce((sum, activity) => 
      sum + activity.price.amount.decimal, 0
    );
    const sellsVolumeUsd = sells.reduce((sum, activity) => 
      sum + activity.price.amount.usd, 0
    );
    
    // Track activity timing
    const allActivities = [...buys, ...sells];
    let firstActivityTimestamp: number | null = null;
    let lastActivityTimestamp: number | null = null;
    let transactionsPerMonth = 0;
    
    if (allActivities.length > 0) {
      // Sort by timestamp
      allActivities.sort((a, b) => a.timestamp - b.timestamp);
      
      firstActivityTimestamp = allActivities[0].timestamp;
      lastActivityTimestamp = allActivities[allActivities.length - 1].timestamp;
      
      // Calculate transactions per month
      if (allActivities.length > 1) {
        const durationSeconds = lastActivityTimestamp - firstActivityTimestamp;
        const durationMonths = durationSeconds / (30 * 24 * 60 * 60); // Approximate months
        transactionsPerMonth = durationMonths > 0 ? allActivities.length / durationMonths : allActivities.length;
      } else {
        // Only 1 transaction
        transactionsPerMonth = allActivities.length;
      }
    }
    
    // Extract top marketplaces from fillSource
    const marketplaceCounts = new Map<string, number>();
    
    for (const activity of allActivities) {
      if (activity.fillSource?.name) {
        const marketplace = activity.fillSource.name;
        marketplaceCounts.set(marketplace, (marketplaceCounts.get(marketplace) || 0) + 1);
      }
    }
    
    // Sort by count (descending) and take top 3
    const topMarketplaces = Array.from(marketplaceCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([name]) => name);
    
    const stats: UserStats = {
      address: normalizedAddress,
      role,
      buysCount,
      buysVolume,
      buysVolumeUsd,
      sellsCount,
      sellsVolume,
      sellsVolumeUsd,
      firstActivityTimestamp,
      lastActivityTimestamp,
      transactionsPerMonth,
      topMarketplaces
    };
    
    logger.debug(`   ✅ User stats: ${buysCount} buys (${buysVolume.toFixed(4)} ETH / $${buysVolumeUsd.toFixed(2)}), ${sellsCount} sells (${sellsVolume.toFixed(4)} ETH / $${sellsVolumeUsd.toFixed(2)})`);
    logger.debug(`      Activity: ${transactionsPerMonth.toFixed(2)} txns/month, Top marketplaces: ${topMarketplaces.join(', ')}`);
    
    return stats;
  }

  /**
   * Build complete LLM prompt context from all data sources
   * Combines token insights, buyer stats, and seller stats into one package
   * 
   * DATA SOURCES:
   * - eventData: From DATABASE sale/registration record (master source of truth)
   * - tokenActivities: From Magic Eden API (historical token trading data)
   * - buyerActivities: From Magic Eden API (buyer's ENS trading history)
   * - sellerActivities: From Magic Eden API (seller's ENS trading history)
   * 
   * @param eventData - Current sale/registration event from DB record
   *                    Should include: txHash (for Magic Eden filtering),
   *                    buyer/seller addresses, price (ETH + USD), timestamp
   * @param tokenActivities - Token's trading history from Magic Eden
   * @param buyerActivities - Buyer's activity history from Magic Eden
   * @param sellerActivities - Seller's activity history from Magic Eden (null for registrations)
   * @returns Complete context for LLM prompt
   */
  async buildLLMContext(
    eventData: {
      type: 'sale' | 'registration';
      tokenName: string;
      price: number;
      priceUsd: number;
      currency: string;
      timestamp: number;
      buyerAddress: string;
      sellerAddress?: string;
      txHash: string; // Required for filtering Magic Eden historical data
    },
    tokenActivities: TokenActivity[],
    buyerActivities: TokenActivity[],
    sellerActivities: TokenActivity[] | null,
    magicEdenService?: any
  ): Promise<LLMPromptContext> {
    logger.info(`🧠 Building LLM context for ${eventData.type}: ${eventData.tokenName}`);
    logger.debug(`   Event from DB: ${eventData.price} ETH ($${eventData.priceUsd}), txHash: ${eventData.txHash.slice(0, 10)}...`);
    logger.debug(`   Raw data: ${tokenActivities.length} token activities, ${buyerActivities.length} buyer activities, ${sellerActivities?.length || 0} seller activities`);
    
    const startTime = Date.now();
    
    // Step 1: Process token history (exclude current transaction)
    logger.debug(`   📊 Processing token history...`);
    const tokenInsights = await this.processTokenHistory(tokenActivities, eventData.txHash);
    
    // Step 2: Process buyer activity
    logger.debug(`   👤 Processing buyer activity...`);
    const buyerStats = await this.processUserActivity(
      buyerActivities,
      eventData.buyerAddress,
      'buyer',
      magicEdenService
    );
    
    // Step 3: Process seller activity (if this is a sale)
    let sellerStats: UserStats | null = null;
    if (eventData.sellerAddress && sellerActivities) {
      logger.debug(`   👤 Processing seller activity...`);
      sellerStats = await this.processUserActivity(
        sellerActivities,
        eventData.sellerAddress,
        'seller',
        magicEdenService
      );
    } else {
      logger.debug(`   ⏭️  No seller data (registration)`);
    }
    
    // Step 4: Assemble complete context
    const context: LLMPromptContext = {
      event: {
        type: eventData.type,
        tokenName: eventData.tokenName,
        price: eventData.price,
        priceUsd: eventData.priceUsd,
        currency: eventData.currency,
        timestamp: eventData.timestamp,
        buyerAddress: eventData.buyerAddress,
        sellerAddress: eventData.sellerAddress,
        txHash: eventData.txHash
      },
      tokenInsights,
      buyerStats,
      sellerStats,
      metadata: {
        dataFetchedAt: Date.now(),
        tokenActivityCount: tokenActivities.length,
        buyerActivityCount: buyerActivities.length,
        sellerActivityCount: sellerActivities?.length || 0
      }
    };
    
    const processingTime = Date.now() - startTime;
    logger.info(`✅ LLM context built in ${processingTime}ms`);
    logger.debug(`   Token: ${tokenInsights.numberOfSales} sales, ${tokenInsights.priceDirection} trend`);
    logger.debug(`   Buyer: ${buyerStats.buysCount} buys (${buyerStats.buysVolume.toFixed(4)} ETH), ${buyerStats.sellsCount} sells (${buyerStats.sellsVolume.toFixed(4)} ETH)`);
    if (sellerStats) {
      logger.debug(`   Seller: ${sellerStats.buysCount} buys (${sellerStats.buysVolume.toFixed(4)} ETH), ${sellerStats.sellsCount} sells (${sellerStats.sellsVolume.toFixed(4)} ETH)`);
    }
    
    return context;
  }
}

// Export singleton instance
export const dataProcessingService = new DataProcessingService();

