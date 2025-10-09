import { logger } from '../utils/logger';
import { TokenActivity } from './magicEdenService';
import { ENSWorkerService } from './ensWorkerService';
import { ClubService } from './clubService';
import { CurrencyUtils } from '../utils/currencyUtils';

/**
 * Insights extracted from token's trading history
 */
export interface TokenInsights {
  firstTx: {
    type: 'mint' | 'sale';
    price: number;
    priceUsd: number;
    timestamp: number;
    buyer: string;
    seller: string;
  } | null;
  previousTx: {
    type: 'mint' | 'sale';
    price: number;
    priceUsd: number;
    timestamp: number;
    buyer: string;
    seller: string;
  } | null;
  totalVolume: number; // Sum of all transaction prices: sales + mints (ETH)
  totalVolumeUsd: number; // Sum of all transaction prices: sales + mints (USD)
  numberOfSales: number; // Count of sales only (mints not included)
  averageHoldDuration: number; // Average time between sales in hours
  
  // Current seller's flip tracking (if determinable)
  sellerAcquisitionTracked: boolean; // Can we track where seller got it?
  sellerAcquisitionType: 'mint' | 'sale' | null; // How seller acquired (mint or sale)
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
  ensName: string | null; // Resolved ENS name (e.g., "trader.eth")
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
  
  // Current ENS holdings (from OpenSea)
  currentHoldings: string[] | null; // Array of ENS names they currently hold
  holdingsIncomplete: boolean; // True if holdings fetch was incomplete
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
    buyerEnsName: string | null; // Resolved ENS name for buyer (e.g., "trader.eth")
    buyerTwitter: string | null; // Twitter handle from ENS records (e.g., "handle" without @)
    sellerAddress?: string; // Not present for registrations
    sellerEnsName?: string | null; // Resolved ENS name for seller (if applicable)
    sellerTwitter?: string | null; // Twitter handle from ENS records (if applicable)
    txHash: string; // Transaction hash from DB
  };
  
  // Token historical context (FROM MAGIC EDEN API)
  tokenInsights: TokenInsights;
  
  // User activity context (FROM MAGIC EDEN API)
  buyerStats: UserStats;
  sellerStats: UserStats | null; // Null for registrations
  
  // Full user activity histories for pattern detection (condensed)
  buyerActivityHistory: Array<{
    type: 'mint' | 'sale';
    timestamp: number;
    tokenName?: string;  // Name of token traded (if available)
    role: 'buyer' | 'seller'; // Was this user buying or selling?
    price: number;       // ETH
    priceUsd: number;    // USD
    txHash: string;
  }>;
  sellerActivityHistory: Array<{
    type: 'mint' | 'sale';
    timestamp: number;
    tokenName?: string;  // Name of token traded (if available)
    role: 'buyer' | 'seller'; // Was this user buying or selling?
    price: number;       // ETH
    priceUsd: number;    // USD
    txHash: string;
  }> | null; // Null for registrations
  
  // Additional metadata
  metadata: {
    dataFetchedAt: number;
    tokenActivityCount: number;
    buyerActivityCount: number;
    sellerActivityCount: number;
    // API fetch status tracking (incomplete = partial data returned, not all pages fetched)
    tokenDataIncomplete: boolean;
    buyerDataIncomplete: boolean;
    sellerDataIncomplete: boolean;
  };
  
  // Club membership info (if name belongs to any clubs)
  clubInfo: string | null; // Formatted club string (e.g., "999 Club #1,234 @ENS999club")
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
  
  // Club service for checking ENS name club memberships
  private readonly clubService = new ClubService();

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
   * @param currentSellerAddress - Address of seller in current transaction (for PNL tracking)
   * @param currentSalePrice - Price of current sale in ETH (for PNL calculation)
   * @param currentSalePriceUsd - Price of current sale in USD (for PNL calculation)
   * @returns Structured token insights
   */
  async processTokenHistory(
    activities: TokenActivity[],
    currentTxHash?: string,
    currentSellerAddress?: string,
    currentSalePrice?: number,
    currentSalePriceUsd?: number
  ): Promise<TokenInsights> {
    logger.debug(`🔍 Processing token history: ${activities.length} total activities`);
    if (currentTxHash) {
      logger.debug(`   Current tx to exclude: ${currentTxHash}`);
    }
    
    // Separate sales, mints, and transfers
    const sales = activities.filter(a => 
      a.type === 'sale' && 
      a.price?.amount?.decimal !== undefined
    );
    const mints = activities.filter(a =>
      a.type === 'mint' &&
      a.price?.amount?.decimal !== undefined
    );
    const transfers = activities.filter(a => a.type === 'transfer');
    
    logger.debug(`   Found ${sales.length} sales, ${mints.length} mints (before filtering), ${transfers.length} transfers`);
    
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
    
    // Process mints (no proxy resolution needed, seller is always 0x0)
    const resolvedMints = mints.map(mint => {
      // Skip current transaction if provided
      if (currentTxHash && mint.txHash.toLowerCase() === currentTxHash.toLowerCase()) {
        logger.debug(`   Filtering out current tx: ${mint.txHash.slice(0, 10)}...`);
        return null;
      }
      
      return {
        ...mint,
        resolvedBuyer: mint.toAddress.toLowerCase(),
        resolvedSeller: mint.fromAddress.toLowerCase() // Will be 0x0
      };
    }).filter(m => m !== null);
    
    logger.debug(`   ${resolvedSales.length} historical sales, ${resolvedMints.length} historical mints (after filtering current tx)`);
    
    // Combine sales and mints for firstTx/previousTx
    const allTransactions = [...resolvedSales, ...resolvedMints];
    
    // Sort by timestamp (oldest first)
    allTransactions.sort((a, b) => a.timestamp - b.timestamp);
    resolvedSales.sort((a, b) => a.timestamp - b.timestamp);
    
    // Handle edge cases
    if (allTransactions.length === 0) {
      logger.debug('   No historical transactions found - returning empty insights');
      return {
        firstTx: null,
        previousTx: null,
        totalVolume: 0,
        totalVolumeUsd: 0,
        numberOfSales: 0,
        averageHoldDuration: 0,
        sellerAcquisitionTracked: false,
        sellerAcquisitionType: null,
        sellerBuyPrice: null,
        sellerBuyPriceUsd: null,
        sellerPnl: null,
        sellerPnlUsd: null,
        sellerHoldDuration: null
      };
    }
    
    // Extract first and previous transactions (includes mints)
    const firstTx = allTransactions[0];
    const previousTx = allTransactions[allTransactions.length - 1];
    
    // Calculate total volume (ETH and USD) - includes both sales AND mints
    // Mints are real costs paid in a free market (registration fees)
    const totalVolume = allTransactions.reduce((sum, tx) => {
      const currencyContract = tx.price.currency.contract;
      const isEth = CurrencyUtils.isETHEquivalent(currencyContract);
      const ethValue = isEth ? tx.price.amount.decimal : (tx.price.amount.native || 0);
      return sum + ethValue;
    }, 0);
    const totalVolumeUsd = allTransactions.reduce((sum, tx) => 
      sum + (tx.price?.amount?.usd || 0), 0
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
    
    // Track seller's acquisition and PNL (if determinable)
    let sellerAcquisitionTracked = false;
    let sellerAcquisitionType: 'mint' | 'sale' | null = null;
    let sellerBuyPrice: number | null = null;
    let sellerBuyPriceUsd: number | null = null;
    let sellerPnl: number | null = null;
    let sellerPnlUsd: number | null = null;
    let sellerHoldDuration: number | null = null;
    
    // If we have the current seller's address, search through history to find their acquisition
    if (currentSellerAddress && allTransactions.length > 0) {
      const normalizedSellerAddress = currentSellerAddress.toLowerCase();
      logger.debug(`   🔍 Searching for seller's acquisition: ${normalizedSellerAddress.slice(0, 8)}...`);
      
      // Sort by timestamp (newest first) - allTransactions already filtered current tx
      const historicalAcquisitions = allTransactions
        .slice() // Copy to avoid mutating original
        .sort((a, b) => b.timestamp - a.timestamp);
      
      // Find where seller acquired this token (most recent acquisition by this address)
      const sellerAcquisition = historicalAcquisitions.find(activity => {
        const recipientAddress = activity.toAddress?.toLowerCase();
        return recipientAddress === normalizedSellerAddress;
      });
      
      if (sellerAcquisition) {
        sellerAcquisitionTracked = true;
        sellerAcquisitionType = sellerAcquisition.type === 'mint' ? 'mint' : 'sale';
        const currencyContract = sellerAcquisition.price.currency.contract;
        const isEth = CurrencyUtils.isETHEquivalent(currencyContract);
        sellerBuyPrice = isEth ? sellerAcquisition.price.amount.decimal : (sellerAcquisition.price.amount.native || 0);
        sellerBuyPriceUsd = sellerAcquisition.price.amount.usd || 0;
        
        // Calculate PNL using current sale price (if provided)
        if (currentSalePrice !== undefined && currentSalePriceUsd !== undefined) {
          sellerPnl = currentSalePrice - sellerBuyPrice;
          sellerPnlUsd = currentSalePriceUsd - sellerBuyPriceUsd;
          const currentTimestamp = Math.floor(Date.now() / 1000); // Current time as fallback
          sellerHoldDuration = (currentTimestamp - sellerAcquisition.timestamp) / 3600; // hours
        }
        
        const acquisitionTypeLabel = sellerAcquisitionType === 'mint' ? 'minted' : 'bought';
        logger.debug(`   ✅ Seller ${acquisitionTypeLabel} for ${sellerBuyPrice.toFixed(4)} ETH ($${sellerBuyPriceUsd.toFixed(2)}) at ${new Date(sellerAcquisition.timestamp * 1000).toISOString().slice(0, 10)}`);
        if (sellerPnl !== null && sellerPnlUsd !== null && sellerHoldDuration !== null) {
          logger.debug(`      PNL: ${sellerPnl >= 0 ? '+' : ''}${sellerPnl.toFixed(4)} ETH (${sellerPnlUsd >= 0 ? '+' : ''}$${sellerPnlUsd.toFixed(2)}), held ${(sellerHoldDuration / 24).toFixed(1)} days`);
        }
      } else {
        logger.debug(`   ❌ Seller acquisition not found in history (may have acquired via transfer)`);
      }
    } else if (!currentSellerAddress) {
      logger.debug(`   ℹ️  No seller address provided (likely a registration), skipping PNL tracking`);
    }
    
    // Helper to get ETH price from activity
    const getEthPrice = (tx: any) => {
      const currencyContract = tx.price.currency.contract;
      const isEth = CurrencyUtils.isETHEquivalent(currencyContract);
      return isEth ? tx.price.amount.decimal : (tx.price.amount.native || 0);
    };
    
    const insights: TokenInsights = {
      firstTx: {
        type: firstTx.type as 'mint' | 'sale',
        price: getEthPrice(firstTx),
        priceUsd: firstTx.price.amount.usd || 0,
        timestamp: firstTx.timestamp,
        buyer: firstTx.resolvedBuyer,
        seller: firstTx.resolvedSeller
      },
      previousTx: {
        type: previousTx.type as 'mint' | 'sale',
        price: getEthPrice(previousTx),
        priceUsd: previousTx.price.amount.usd || 0,
        timestamp: previousTx.timestamp,
        buyer: previousTx.resolvedBuyer,
        seller: previousTx.resolvedSeller
      },
      totalVolume,
      totalVolumeUsd,
      numberOfSales: resolvedSales.length,
      averageHoldDuration,
      sellerAcquisitionTracked,
      sellerAcquisitionType,
      sellerBuyPrice,
      sellerBuyPriceUsd,
      sellerPnl,
      sellerPnlUsd,
      sellerHoldDuration
    };
    
    logger.debug(`   ✅ Token insights: ${allTransactions.length} total txs (${resolvedSales.length} sales, ${resolvedMints.length} mints), ${totalVolume.toFixed(4)} ETH ($${totalVolumeUsd.toFixed(2)}) volume`);
    
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
    magicEdenService?: any,
    currentHoldings?: { names: string[]; incomplete: boolean } | null
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
    // Use 'native' for non-ETH currencies (converts to ETH), 'decimal' for ETH (more precise)
    const buysVolume = buys.reduce((sum, activity) => {
      const currencyContract = activity.price.currency.contract;
      const isEth = CurrencyUtils.isETHEquivalent(currencyContract);
      const ethValue = isEth ? activity.price.amount.decimal : (activity.price.amount.native || 0);
      return sum + ethValue;
    }, 0);
    const buysVolumeUsd = buys.reduce((sum, activity) => 
      sum + (activity.price.amount.usd || 0), 0
    );
    
    // Calculate sell statistics
    const sellsCount = sells.length;
    // Use 'native' for non-ETH currencies (converts to ETH), 'decimal' for ETH (more precise)
    const sellsVolume = sells.reduce((sum, activity) => {
      const currencyContract = activity.price.currency.contract;
      const isEth = CurrencyUtils.isETHEquivalent(currencyContract);
      const ethValue = isEth ? activity.price.amount.decimal : (activity.price.amount.native || 0);
      return sum + ethValue;
    }, 0);
    const sellsVolumeUsd = sells.reduce((sum, activity) => 
      sum + (activity.price.amount.usd || 0), 0
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
      ensName: null, // Will be populated in buildLLMContext after ENS resolution
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
      topMarketplaces,
      currentHoldings: currentHoldings?.names || null,
      holdingsIncomplete: currentHoldings?.incomplete || false
    };
    
    logger.debug(`   ✅ User stats: ${buysCount} buys (${buysVolume.toFixed(4)} ETH / $${buysVolumeUsd.toFixed(2)}), ${sellsCount} sells (${sellsVolume.toFixed(4)} ETH / $${sellsVolumeUsd.toFixed(2)})`);
    logger.debug(`      Activity: ${transactionsPerMonth.toFixed(2)} txns/month, Top marketplaces: ${topMarketplaces.join(', ')}`);
    if (currentHoldings) {
      logger.debug(`      Current holdings: ${currentHoldings.names.length} names${currentHoldings.incomplete ? ' (incomplete)' : ''}`);
    }
    
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
    magicEdenService?: any,
    ensWorkerService?: ENSWorkerService,
    fetchStatus?: {
      tokenDataIncomplete: boolean;
      buyerDataIncomplete: boolean;
      sellerDataIncomplete: boolean;
    },
    holdingsData?: {
      buyerHoldings: { names: string[]; incomplete: boolean } | null;
      sellerHoldings: { names: string[]; incomplete: boolean } | null;
    }
  ): Promise<LLMPromptContext> {
    logger.info(`🧠 Building LLM context for ${eventData.type}: ${eventData.tokenName}`);
    logger.debug(`   Event from DB: ${eventData.price} ETH ($${eventData.priceUsd}), txHash: ${eventData.txHash.slice(0, 10)}...`);
    logger.debug(`   Raw data: ${tokenActivities.length} token activities, ${buyerActivities.length} buyer activities, ${sellerActivities?.length || 0} seller activities`);
    
    const startTime = Date.now();
    
    // Step 0: Resolve ENS names and Twitter handles for buyer and seller
    let buyerEnsName: string | null = null;
    let sellerEnsName: string | null = null;
    let buyerTwitter: string | null = null;
    let sellerTwitter: string | null = null;
    
    if (ensWorkerService) {
      logger.debug(`   🔍 Resolving ENS names and Twitter handles...`);
      try {
        const buyerAccount = await ensWorkerService.getFullAccountData(eventData.buyerAddress);
        buyerEnsName = buyerAccount?.name || null;
        buyerTwitter = buyerAccount?.records?.['com.twitter'] || null;
        
        if (eventData.sellerAddress) {
          const sellerAccount = await ensWorkerService.getFullAccountData(eventData.sellerAddress);
          sellerEnsName = sellerAccount?.name || null;
          sellerTwitter = sellerAccount?.records?.['com.twitter'] || null;
        }
        
        logger.debug(`   ✅ Buyer: ${buyerEnsName || eventData.buyerAddress.slice(0, 8) + '...'}, Seller: ${sellerEnsName || (eventData.sellerAddress?.slice(0, 8) + '...') || 'N/A'}`);
      } catch (error: any) {
        logger.warn(`   ⚠️  ENS resolution failed: ${error.message}`);
      }
    }
    
    // Step 1: Process token history (exclude current transaction)
    logger.debug(`   📊 Processing token history...`);
    const tokenInsights = await this.processTokenHistory(
      tokenActivities,
      eventData.txHash,
      eventData.sellerAddress, // For sales, track seller's acquisition
      eventData.price,          // Current sale price in ETH
      eventData.priceUsd        // Current sale price in USD
    );
    
    // Step 2: Process buyer activity
    logger.debug(`   👤 Processing buyer activity...`);
    const buyerStats = await this.processUserActivity(
      buyerActivities,
      eventData.buyerAddress,
      'buyer',
      magicEdenService,
      holdingsData?.buyerHoldings || null
    );
    
    // Step 3: Process seller activity (if this is a sale)
    let sellerStats: UserStats | null = null;
    if (eventData.sellerAddress && sellerActivities) {
      logger.debug(`   👤 Processing seller activity...`);
      sellerStats = await this.processUserActivity(
        sellerActivities,
        eventData.sellerAddress,
        'seller',
        magicEdenService,
        holdingsData?.sellerHoldings || null
      );
    } else {
      logger.debug(`   ⏭️  No seller data (registration)`);
    }
    
    // Update stats with resolved ENS names
    buyerStats.ensName = buyerEnsName;
    if (sellerStats) {
      sellerStats.ensName = sellerEnsName;
    }
    
    // Step 3.5: Build condensed user activity histories for pattern detection
    logger.debug(`   📜 Building condensed user activity histories...`);
    
    // Buyer's full trading history
    const buyerActivityHistory = buyerActivities
      .filter(a => (a.type === 'mint' || a.type === 'sale') && a.price?.amount?.decimal !== undefined)
      .map(a => {
        const normalizedBuyerAddress = eventData.buyerAddress.toLowerCase();
        const role = a.toAddress.toLowerCase() === normalizedBuyerAddress ? 'buyer' : 'seller';
        // Convert price to ETH: use 'decimal' for ETH (precise), 'native' for other currencies (converted)
        const currencyContract = a.price.currency.contract;
        const isEth = CurrencyUtils.isETHEquivalent(currencyContract);
        const priceEth = isEth ? a.price.amount.decimal : (a.price.amount.native || 0);
        return {
          type: a.type as 'mint' | 'sale',
          timestamp: a.timestamp,
          tokenName: a.token?.tokenName ?? undefined,
          role: role as 'buyer' | 'seller',
          price: priceEth,
          priceUsd: a.price.amount.usd || 0,
          txHash: a.txHash
        };
      })
      .sort((a, b) => a.timestamp - b.timestamp); // Chronological order
    
    // Seller's full trading history (if applicable)
    let sellerActivityHistory: typeof buyerActivityHistory | null = null;
    if (sellerActivities && eventData.sellerAddress) {
      sellerActivityHistory = sellerActivities
        .filter(a => (a.type === 'mint' || a.type === 'sale') && a.price?.amount?.decimal !== undefined)
        .map(a => {
          const normalizedSellerAddress = eventData.sellerAddress!.toLowerCase();
          const role = a.toAddress.toLowerCase() === normalizedSellerAddress ? 'buyer' : 'seller';
          // Convert price to ETH: use 'decimal' for ETH (precise), 'native' for other currencies (converted)
          const currencyContract = a.price.currency.contract;
          const isEth = CurrencyUtils.isETHEquivalent(currencyContract);
          const priceEth = isEth ? a.price.amount.decimal : (a.price.amount.native || 0);
          return {
            type: a.type as 'mint' | 'sale',
            timestamp: a.timestamp,
            tokenName: a.token?.tokenName ?? undefined,
            role: role as 'buyer' | 'seller',
            price: priceEth,
            priceUsd: a.price.amount.usd || 0,
            txHash: a.txHash
          };
        })
        .sort((a, b) => a.timestamp - b.timestamp); // Chronological order
    }
    
    logger.debug(`   ✅ Buyer activity history: ${buyerActivityHistory.length} entries`);
    if (sellerActivityHistory) {
      logger.debug(`   ✅ Seller activity history: ${sellerActivityHistory.length} entries`);
    }
    
    // Step 3.75: Check club membership
    logger.debug(`   🎯 Checking club membership for ${eventData.tokenName}...`);
    const clubInfo = this.clubService.getFormattedClubString(eventData.tokenName);
    if (clubInfo) {
      logger.debug(`   ✅ Club membership found: ${clubInfo}`);
    } else {
      logger.debug(`   ℹ️  No club membership found`);
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
        buyerEnsName,
        buyerTwitter,
        sellerAddress: eventData.sellerAddress,
        sellerEnsName,
        sellerTwitter,
        txHash: eventData.txHash
      },
      tokenInsights,
      buyerStats,
      sellerStats,
      buyerActivityHistory,
      sellerActivityHistory,
      metadata: {
        dataFetchedAt: Date.now(),
        tokenActivityCount: tokenActivities.length,
        buyerActivityCount: buyerActivities.length,
        sellerActivityCount: sellerActivities?.length || 0,
        tokenDataIncomplete: fetchStatus?.tokenDataIncomplete || false,
        buyerDataIncomplete: fetchStatus?.buyerDataIncomplete || false,
        sellerDataIncomplete: fetchStatus?.sellerDataIncomplete || false
      },
      clubInfo
    };
    
    const processingTime = Date.now() - startTime;
    logger.info(`✅ LLM context built in ${processingTime}ms`);
    logger.debug(`   Token: ${tokenInsights.numberOfSales} historical sales, ${tokenInsights.totalVolume.toFixed(4)} ETH volume`);
    logger.debug(`   Buyer: ${buyerStats.buysCount} buys (${buyerStats.buysVolume.toFixed(4)} ETH), ${buyerStats.sellsCount} sells (${buyerStats.sellsVolume.toFixed(4)} ETH)`);
    if (sellerStats) {
      logger.debug(`   Seller: ${sellerStats.buysCount} buys (${sellerStats.buysVolume.toFixed(4)} ETH), ${sellerStats.sellsCount} sells (${sellerStats.sellsVolume.toFixed(4)} ETH)`);
    }
    
    return context;
  }
}

// Export singleton instance
export const dataProcessingService = new DataProcessingService();

