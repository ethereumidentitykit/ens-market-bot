import { logger } from '../utils/logger';
import { TokenActivity } from '../types/activity';
import { ENSWorkerService } from './ensWorkerService';
import { ClubService, ClubStats } from './clubService';
import { ClubActivityEntry, GrailsActiveListing, GrailsApiService } from './grailsApiService';
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
  
  // Current ENS holdings (from Grails search API)
  currentHoldings: { name: string; clubs: string[] }[] | null;
  holdingsIncomplete: boolean;
  
  // Bidding behavior (optional - only if bid activities found)
  biddingStats?: BiddingStats;
  
  // Portfolio analysis (optional - financial standing across chains)
  portfolio?: {
    totalValueUsd: number;
    ethBalance: number; // ETH on mainnet
    ethValueUsd: number;
    
    majorHoldings: Array<{
      symbol: string;
      balance: number;
      valueUsd: number;
      network: string;
    }>; // Top 5 non-native tokens by value
    
    crossChainPresence: {
      mainnet: boolean;
      base: boolean;
      optimism: boolean;
      arbitrum: boolean;
      zksync: boolean;
      polygon: boolean;
      linea: boolean;
    };
    
    incomplete: boolean; // True if data fetch failed
  };
}

/**
 * Bidding behavior statistics
 */
export interface BiddingStats {
  totalBids: number; // Total number of bids made
  // Lifecycle counts: null when not derivable from current data source
  // (Grails activity feed only exposes BID_CREATED events, not status transitions).
  // Treat null as "unknown" — do not display as zero in prompts/UI.
  activeBids: number | null;
  filledBids: number | null;
  cancelledBids: number | null;
  expiredBids: number | null;

  totalBidVolume: number; // Total ETH bid across all bids
  totalBidVolumeUsd: number; // Total USD value of bids
  averageBidAmount: number; // Average bid amount in ETH
  
  recentBids: Array<{
    name: string; // ENS name bid on
    amount: number; // Bid amount in ETH
    amountUsd: number; // USD value
    status: string; // active, filled, cancelled, expired
    timestamp: number; // Unix timestamp
    daysAgo: number; // Days since bid
  }>;
  
  // Pattern analysis
  bidPatterns: {
    namesSimilar: boolean; // Are the names they're bidding on similar?
    commonThemes: string[]; // Detected themes (e.g., "3-letter", "animals", "numbers")
    exampleNames: string[]; // Up to 3 example names from recent bids
  };
}

/**
 * Complete context package for LLM prompts
 * Combines data from DATABASE (event details) and Grails API (historical context)
 */
export interface LLMPromptContext {
  // Current event details (FROM DATABASE - master source of truth)
  event: {
    type: 'sale' | 'registration' | 'bid';
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
    recipientAddress?: string; // Name recipient when different from minter/executor (registrations only)
    recipientEnsName?: string | null;
    recipientTwitter?: string | null;
    txHash?: string; // Transaction hash from DB (optional for bids)
  };
  
  // Token historical context (FROM GRAILS API)
  tokenInsights: TokenInsights;
  
  // User activity context (FROM GRAILS API)
  buyerStats: UserStats;
  sellerStats: UserStats | null; // Null for registrations
  recipientStats: UserStats | null; // Recipient stats when minter ≠ recipient (registrations only)
  
  // Full user activity histories for pattern detection (condensed)
  buyerActivityHistory: Array<{
    type: 'mint' | 'sale' | 'bid';
    timestamp: number;
    tokenName?: string;  // Name of token traded (if available)
    role: 'buyer' | 'seller' | 'bidder'; // Was this user buying, selling, or bidding?
    price: number;       // ETH
    priceUsd: number;    // USD
    txHash: string;
  }>;
  sellerActivityHistory: Array<{
    type: 'mint' | 'sale' | 'bid';
    timestamp: number;
    tokenName?: string;  // Name of token traded (if available)
    role: 'buyer' | 'seller' | 'bidder'; // Was this user buying, selling, or bidding?
    price: number;       // ETH
    priceUsd: number;    // USD
    txHash: string;
  }> | null; // Null for registrations
  recipientActivityHistory: Array<{
    type: 'mint' | 'sale' | 'bid';
    timestamp: number;
    tokenName?: string;
    role: 'buyer' | 'seller' | 'bidder';
    price: number;
    priceUsd: number;
    txHash: string;
  }> | null;
  
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
    // API unavailability tracking (unavailable = API error/404, data not accessible)
    tokenDataUnavailable: boolean;
    buyerDataUnavailable: boolean;
    sellerDataUnavailable: boolean;
    recipientDataIncomplete: boolean;
    recipientDataUnavailable: boolean;
    // Bid truncation tracking (bids limited to prevent token overflow)
    buyerBidsTruncated: boolean;
    buyerBidsTruncatedCount: number;
    sellerBidsTruncated: boolean;
    sellerBidsTruncatedCount: number;
  };
  
  // Category membership info (if name belongs to any categories)
  clubInfo: string | null; // Formatted category string (e.g., "999 Club @ens999club")

  // Full club context: stats + recent activity for each club the name belongs to
  clubContext: Array<{
    slug: string;
    stats: ClubStats;
    recentActivity: ClubActivityEntry[];
  }> | null;

  // Active marketplace listings for this name (from Grails API, aggregates across marketplaces)
  activeListings: GrailsActiveListing[];

  // Previous AI replies for context (avoid repetition, maintain voice consistency)
  previousReplies: {
    recent: import('../types').PreviousReply[];
    buyer: import('../types').PreviousReply[];
    seller: import('../types').PreviousReply[];
  };
}

/**
 * Data Processing Service for AI Reply Feature
 * Transforms raw activity data into structured insights for LLM consumption
 */
export class DataProcessingService {
  // Category service for checking ENS name category memberships
  private readonly clubService = new ClubService();

  constructor() {
    logger.info('🔬 DataProcessingService initialized');
  }

  /**
   * Extract insights from token's trading history
   * Analyzes price trends, volume, and trading patterns
   * Resolves proxy contracts using transfer events
   * 
   * @param activities - Token activity history (sales, mints, transfers)
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
    
    // Grails API returns proxy-resolved addresses — no transfer-based resolution needed
    const sales = activities.filter(a => 
      a.type === 'sale' && 
      a.price?.amount?.decimal !== undefined
    );
    const mints = activities.filter(a =>
      a.type === 'mint' &&
      a.price?.amount?.decimal !== undefined
    );
    
    logger.debug(`   Found ${sales.length} sales, ${mints.length} mints (before filtering)`);
    
    const resolvedSales = sales
      .filter(sale => {
        if (currentTxHash && sale.txHash && sale.txHash.toLowerCase() === currentTxHash.toLowerCase()) {
          logger.debug(`   Filtering out current tx: ${sale.txHash.slice(0, 10)}...`);
          return false;
        }
        return true;
      })
      .map(sale => ({
        ...sale,
        resolvedBuyer: sale.toAddress.toLowerCase(),
        resolvedSeller: sale.fromAddress.toLowerCase()
      }));
    
    const resolvedMints = mints
      .filter(mint => {
        if (currentTxHash && mint.txHash && mint.txHash.toLowerCase() === currentTxHash.toLowerCase()) {
          logger.debug(`   Filtering out current tx: ${mint.txHash.slice(0, 10)}...`);
          return false;
        }
        return true;
      })
      .map(mint => ({
        ...mint,
        resolvedBuyer: mint.toAddress.toLowerCase(),
        resolvedSeller: mint.fromAddress.toLowerCase()
      }));
    
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
      const rawValue = isEth ? tx.price.amount.decimal : (tx.price.amount.native || 0);
      const ethValue = typeof rawValue === 'number' ? rawValue : parseFloat(rawValue) || 0;
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
        const rawBuyPrice = isEth ? sellerAcquisition.price.amount.decimal : (sellerAcquisition.price.amount.native || 0);
        sellerBuyPrice = typeof rawBuyPrice === 'number' ? rawBuyPrice : parseFloat(rawBuyPrice) || 0;
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
      const rawValue = isEth ? tx.price.amount.decimal : (tx.price.amount.native || 0);
      return typeof rawValue === 'number' ? rawValue : parseFloat(rawValue) || 0;
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
   * Grails API provides proxy-resolved addresses — no additional resolution needed.
   */
  async processUserActivity(
    activities: TokenActivity[],
    userAddress: string,
    role: 'buyer' | 'seller',
    currentHoldings?: { names: { name: string; clubs: string[] }[]; incomplete: boolean } | null
  ): Promise<UserStats> {
    logger.debug(`👤 Processing user activity: ${activities.length} activities for ${userAddress.slice(0, 8)}... (${role})`);
    
    const normalizedAddress = userAddress.toLowerCase();
    
    const salesAndMints = activities.filter(a => 
      (a.type === 'sale' || a.type === 'mint') &&
      a.price?.amount?.decimal !== undefined
    );
    
    logger.debug(`   Found ${salesAndMints.length} sales/mints`);
    
    // Grails API returns proxy-resolved addresses — map directly
    const resolvedActivities = salesAndMints.map(activity => ({
      ...activity,
      resolvedBuyer: activity.toAddress.toLowerCase(),
      resolvedSeller: activity.fromAddress.toLowerCase()
    }));
    
    logger.debug(`   Processed ${resolvedActivities.length} activities`);
    
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
      const rawValue = isEth ? activity.price.amount.decimal : (activity.price.amount.native || 0);
      const ethValue = typeof rawValue === 'number' ? rawValue : parseFloat(rawValue) || 0;
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
      const rawValue = isEth ? activity.price.amount.decimal : (activity.price.amount.native || 0);
      const ethValue = typeof rawValue === 'number' ? rawValue : parseFloat(rawValue) || 0;
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
    
    // Process bidding behavior if any BID activities found
    const biddingStats = this.processBiddingStats(activities, normalizedAddress);
    if (biddingStats) {
      stats.biddingStats = biddingStats;
      logger.debug(`      Bidding: ${biddingStats.totalBids} bids placed, ${biddingStats.totalBidVolume.toFixed(4)} ETH total, avg ${biddingStats.averageBidAmount.toFixed(4)} ETH`);
    }
    
    return stats;
  }

  /**
   * Process bidding behavior from user activities
   * Extracts bid statistics and patterns from BID_CREATED activities
   * Note: We only fetch BID_CREATED, not BID_CANCELLED, so we can't accurately track status
   */
  private processBiddingStats(activities: TokenActivity[], userAddress: string): BiddingStats | null {
    // Filter for bid activities where user is the maker (bidder)
    const bidActivities = activities.filter(a => 
      a.type === 'bid' && 
      a.fromAddress.toLowerCase() === userAddress
    );
    
    if (bidActivities.length === 0) {
      return null;
    }
    
    logger.debug(`   🤝 Processing ${bidActivities.length} bid creation activities...`);
    
    // Calculate volume
    let totalBidVolume = 0;
    let totalBidVolumeUsd = 0;
    
    bidActivities.forEach(bid => {
      if (bid.price?.amount?.decimal) {
        totalBidVolume += bid.price.amount.decimal;
        if (bid.price.amount.usd) {
          totalBidVolumeUsd += bid.price.amount.usd;
        }
      }
    });
    
    const averageBidAmount = bidActivities.length > 0 ? totalBidVolume / bidActivities.length : 0;
    
    // Get recent bids (last 10, sorted by most recent)
    const sortedBids = [...bidActivities].sort((a, b) => b.timestamp - a.timestamp).slice(0, 10);
    const now = Math.floor(Date.now() / 1000);
    
    const recentBids = sortedBids.map(bid => ({
      name: bid.token?.tokenName || 'Unknown',
      amount: bid.price?.amount?.decimal || 0,
      amountUsd: bid.price?.amount?.usd || 0,
      status: 'created', // We only know they created the bid
      timestamp: bid.timestamp,
      daysAgo: Math.floor((now - bid.timestamp) / (60 * 60 * 24))
    }));
    
    // Analyze patterns in bid names
    const bidNames = recentBids.map(b => b.name.replace(/\.eth$/i, '').toLowerCase());
    const bidPatterns = this.analyzeBidPatterns(bidNames);
    
    return {
      totalBids: bidActivities.length,
      // Status counts are NOT derivable from Grails BID_CREATED activities alone.
      // Mark as null so prompts/UI can show "unknown" rather than misleading zeros.
      activeBids: null,
      filledBids: null,
      cancelledBids: null,
      expiredBids: null,
      totalBidVolume,
      totalBidVolumeUsd,
      averageBidAmount,
      recentBids,
      bidPatterns
    };
  }

  /**
   * Analyze patterns in bid names to detect themes
   */
  private analyzeBidPatterns(names: string[]): {
    namesSimilar: boolean;
    commonThemes: string[];
    exampleNames: string[];
  } {
    if (names.length === 0) {
      return { namesSimilar: false, commonThemes: [], exampleNames: [] };
    }
    
    const themes: string[] = [];
    
    // Check for numeric patterns
    const allNumeric = names.filter(n => /^\d+$/.test(n));
    if (allNumeric.length >= 3) themes.push('numbers');
    
    // Check for length patterns
    const threeChar = names.filter(n => n.length === 3);
    const fourChar = names.filter(n => n.length === 4);
    const fiveChar = names.filter(n => n.length === 5);
    if (threeChar.length >= 3) themes.push('3-letter');
    if (fourChar.length >= 3) themes.push('4-letter');
    if (fiveChar.length >= 3) themes.push('5-letter');
    
    // Check for 999 Club pattern (3 digits)
    const club999 = names.filter(n => /^\d{3}$/.test(n));
    if (club999.length >= 2) themes.push('999 Club');
    
    // Check for 10k Club pattern (4 digits)
    const club10k = names.filter(n => /^\d{4}$/.test(n));
    if (club10k.length >= 2) themes.push('10k Club');
    
    // Example names (up to 3)
    const exampleNames = names.slice(0, 3);
    
    // Consider similar if we found themes or more than 50% have similar characteristics
    const namesSimilar = themes.length > 0;
    
    return {
      namesSimilar,
      commonThemes: themes,
      exampleNames
    };
  }

  /**
   * Enrich user stats with portfolio data (multi-chain token balances + values)
   * @param stats UserStats object to enrich
   * @param alchemyService AlchemyService instance for fetching portfolio
   */
  async enrichWithPortfolioData(
    stats: UserStats,
    alchemyService: any // Using any to avoid circular dependency
  ): Promise<void> {
    try {
      logger.debug(`   📊 Enriching portfolio data for ${stats.address.slice(0, 10)}...`);
      
      // Fetch portfolio from Alchemy
      const portfolio = await alchemyService.getWalletPortfolio(stats.address);
      
      // Extract mainnet ETH balance
      const ethBalance = portfolio.nativeTokens.find((t: any) => t.network === 'eth-mainnet')?.balance || 0;
      const ethValueUsd = portfolio.nativeTokens.find((t: any) => t.network === 'eth-mainnet')?.valueUsd || 0;
      
      // Extract top 5 ERC20 holdings
      const majorHoldings = portfolio.erc20Tokens
        .slice(0, 5)
        .map((token: any) => ({
          symbol: token.symbol,
          balance: token.balance,
          valueUsd: token.valueUsd,
          network: token.network
        }));
      
      // Determine cross-chain presence
      type ChainKey = 'mainnet' | 'base' | 'optimism' | 'arbitrum' | 'zksync' | 'polygon' | 'linea';
      const networkMap: Record<string, ChainKey | undefined> = {
        'eth-mainnet': 'mainnet',
        'base-mainnet': 'base',
        'opt-mainnet': 'optimism',
        'arb-mainnet': 'arbitrum',
        'zksync-mainnet': 'zksync',
        'polygon-mainnet': 'polygon',
        'linea-mainnet': 'linea'
      };
      
      const crossChainPresence: Record<ChainKey, boolean> = {
        mainnet: false,
        base: false,
        optimism: false,
        arbitrum: false,
        zksync: false,
        polygon: false,
        linea: false
      };
      
      portfolio.networksAnalyzed.forEach((network: string) => {
        const key = networkMap[network];
        if (key) {
          crossChainPresence[key] = true;
        }
      });
      
      // Attach to stats
      stats.portfolio = {
        totalValueUsd: portfolio.totalValueUsd,
        ethBalance,
        ethValueUsd,
        majorHoldings,
        crossChainPresence,
        incomplete: portfolio.incomplete
      };
      
      logger.debug(`   ✅ Portfolio: $${portfolio.totalValueUsd.toLocaleString()} (${portfolio.nativeTokens.length + portfolio.erc20Tokens.length} tokens)`);
    } catch (error: any) {
      logger.error(`   ❌ Failed to enrich portfolio data: ${error.message}`);
      // Don't set portfolio field on error - leave it undefined
    }
  }

  /**
   * Build complete LLM prompt context from all data sources
   * Combines token insights, buyer stats, and seller stats into one package
   * 
   * DATA SOURCES:
   * - eventData: From DATABASE sale/registration record (master source of truth)
   * - tokenActivities: From Grails API (historical token trading data)
   * - buyerActivities: From Grails API (buyer's ENS trading history)
   * - sellerActivities: From Grails API (seller's ENS trading history)
   * 
   * @param eventData - Current sale/registration event from DB record
   *                    Should include: txHash (for history filtering),
   *                    buyer/seller addresses, price (ETH + USD), timestamp
   * @param tokenActivities - Token's trading history (from Grails API)
   * @param buyerActivities - Buyer's activity history (from Grails API)
   * @param sellerActivities - Seller's activity history (from Grails API, null for registrations)
   * @returns Complete context for LLM prompt
   */
  async buildLLMContext(
    eventData: {
      type: 'sale' | 'registration' | 'bid';
      tokenName: string;
      price: number;
      priceUsd: number;
      currency: string;
      timestamp: number;
      buyerAddress: string;
      sellerAddress?: string;
      recipientAddress?: string;
      txHash?: string;
    },
    tokenActivities: TokenActivity[],
    buyerActivities: TokenActivity[],
    sellerActivities: TokenActivity[] | null,
    ensWorkerService?: ENSWorkerService,
    fetchStatus?: {
      tokenDataIncomplete: boolean;
      buyerDataIncomplete: boolean;
      sellerDataIncomplete: boolean;
      tokenDataUnavailable?: boolean;
      buyerDataUnavailable?: boolean;
      sellerDataUnavailable?: boolean;
      recipientDataIncomplete?: boolean;
      recipientDataUnavailable?: boolean;
    },
    holdingsData?: {
      buyerHoldings: { names: { name: string; clubs: string[] }[]; incomplete: boolean } | null;
      sellerHoldings: { names: { name: string; clubs: string[] }[]; incomplete: boolean } | null;
      recipientHoldings?: { names: { name: string; clubs: string[] }[]; incomplete: boolean } | null;
    },
    recipientActivities?: TokenActivity[] | null
  ): Promise<LLMPromptContext> {
    logger.info(`🧠 Building LLM context for ${eventData.type}: ${eventData.tokenName}`);
    logger.debug(`   Event from DB: ${eventData.price} ETH ($${eventData.priceUsd})${eventData.txHash ? `, txHash: ${eventData.txHash.slice(0, 10)}...` : ''}`);
    logger.debug(`   Raw data: ${tokenActivities.length} token activities, ${buyerActivities.length} buyer activities, ${sellerActivities?.length || 0} seller activities`);
    
    const startTime = Date.now();
    
    // Step 0: Resolve ENS names and Twitter handles for buyer and seller
    let buyerEnsName: string | null = null;
    let sellerEnsName: string | null = null;
    let buyerTwitter: string | null = null;
    let sellerTwitter: string | null = null;
    let recipientEnsName: string | null = null;
    let recipientTwitter: string | null = null;
    
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

        if (eventData.recipientAddress) {
          const recipientAccount = await ensWorkerService.getFullAccountData(eventData.recipientAddress);
          recipientEnsName = recipientAccount?.name || null;
          recipientTwitter = recipientAccount?.records?.['com.twitter'] || null;
        }
        
        logger.debug(`   ✅ Buyer: ${buyerEnsName || eventData.buyerAddress.slice(0, 8) + '...'}, Seller: ${sellerEnsName || (eventData.sellerAddress?.slice(0, 8) + '...') || 'N/A'}${eventData.recipientAddress ? `, Recipient: ${recipientEnsName || eventData.recipientAddress.slice(0, 8) + '...'}` : ''}`);
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
        holdingsData?.sellerHoldings || null
      );
    } else {
      logger.debug(`   ⏭️  No seller data (registration)`);
    }

    // Step 3a: Process recipient activity (registrations where minter ≠ recipient)
    let recipientStats: UserStats | null = null;
    if (eventData.recipientAddress && recipientActivities) {
      logger.debug(`   👤 Processing recipient activity...`);
      recipientStats = await this.processUserActivity(
        recipientActivities,
        eventData.recipientAddress,
        'buyer',
        holdingsData?.recipientHoldings || null
      );
    }
    
    // Update stats with resolved ENS names
    buyerStats.ensName = buyerEnsName;
    if (sellerStats) {
      sellerStats.ensName = sellerEnsName;
    }
    if (recipientStats) {
      recipientStats.ensName = recipientEnsName;
    }
    
    // Step 3.5: Build condensed user activity histories for pattern detection
    logger.debug(`   📜 Building condensed user activity histories...`);
    
    // Buyer's full trading history (including bids, limited to prevent token overflow)
    const MAX_BIDS_FOR_LLM = 500;
    
    // Process all activities first
    const allBuyerActivities = buyerActivities
      .filter(a => (a.type === 'mint' || a.type === 'sale' || a.type === 'bid') && a.price?.amount?.decimal !== undefined)
      .map(a => {
        const normalizedBuyerAddress = eventData.buyerAddress.toLowerCase();
        
        // Determine role based on activity type
        let role: 'buyer' | 'seller' | 'bidder';
        if (a.type === 'bid') {
          // For bids, user is always the bidder
          role = 'bidder';
        } else {
          // For sales/mints, check if user was buyer or seller
          role = a.toAddress.toLowerCase() === normalizedBuyerAddress ? 'buyer' : 'seller';
        }
        
        // Convert price to ETH: use 'decimal' for ETH (precise), 'native' for other currencies (converted)
        const currencyContract = a.price.currency.contract;
        const isEth = CurrencyUtils.isETHEquivalent(currencyContract);
        const rawPrice = isEth ? a.price.amount.decimal : (a.price.amount.native || 0);
        const priceEth = typeof rawPrice === 'number' ? rawPrice : parseFloat(rawPrice) || 0;
        
        return {
          type: a.type as 'mint' | 'sale' | 'bid',
          timestamp: a.timestamp,
          tokenName: a.token?.tokenName ?? undefined,
          role,
          price: priceEth,
          priceUsd: a.price.amount.usd || 0,
          txHash: a.txHash
        };
      });
    
    // Separate bids from sales/mints
    const buyerBids = allBuyerActivities.filter(a => a.type === 'bid');
    const buyerSalesMints = allBuyerActivities.filter(a => a.type !== 'bid');
    
    // Limit bids to most recent 500 (sorted newest first, then take first 500)
    const buyerBidsLimited = buyerBids
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(0, MAX_BIDS_FOR_LLM);
    
    const buyerBidsTruncated = buyerBids.length > MAX_BIDS_FOR_LLM;
    const buyerBidsTruncatedCount = buyerBids.length - buyerBidsLimited.length;
    
    // Combine and sort chronologically
    const buyerActivityHistory = [...buyerSalesMints, ...buyerBidsLimited]
      .sort((a, b) => a.timestamp - b.timestamp); // Chronological order
    
    // Seller's full trading history (if applicable, including bids, limited to prevent token overflow)
    let sellerActivityHistory: typeof buyerActivityHistory | null = null;
    let sellerBidsTruncated = false;
    let sellerBidsTruncatedCount = 0;
    
    if (sellerActivities && eventData.sellerAddress) {
      // Process all activities first
      const allSellerActivities = sellerActivities
        .filter(a => (a.type === 'mint' || a.type === 'sale' || a.type === 'bid') && a.price?.amount?.decimal !== undefined)
        .map(a => {
          const normalizedSellerAddress = eventData.sellerAddress!.toLowerCase();
          
          // Determine role based on activity type
          let role: 'buyer' | 'seller' | 'bidder';
          if (a.type === 'bid') {
            // For bids, user is always the bidder
            role = 'bidder';
          } else {
            // For sales/mints, check if user was buyer or seller
            role = a.toAddress.toLowerCase() === normalizedSellerAddress ? 'buyer' : 'seller';
          }
          
          // Convert price to ETH: use 'decimal' for ETH (precise), 'native' for other currencies (converted)
          const currencyContract = a.price.currency.contract;
          const isEth = CurrencyUtils.isETHEquivalent(currencyContract);
          const rawPrice = isEth ? a.price.amount.decimal : (a.price.amount.native || 0);
          const priceEth = typeof rawPrice === 'number' ? rawPrice : parseFloat(rawPrice) || 0;
          
          return {
            type: a.type as 'mint' | 'sale' | 'bid',
            timestamp: a.timestamp,
            tokenName: a.token?.tokenName ?? undefined,
            role,
            price: priceEth,
            priceUsd: a.price.amount.usd || 0,
            txHash: a.txHash
          };
        });
      
      // Separate bids from sales/mints
      const sellerBids = allSellerActivities.filter(a => a.type === 'bid');
      const sellerSalesMints = allSellerActivities.filter(a => a.type !== 'bid');
      
      // Limit bids to most recent 500
      const sellerBidsLimited = sellerBids
        .sort((a, b) => b.timestamp - a.timestamp)
        .slice(0, MAX_BIDS_FOR_LLM);
      
      sellerBidsTruncated = sellerBids.length > MAX_BIDS_FOR_LLM;
      sellerBidsTruncatedCount = sellerBids.length - sellerBidsLimited.length;
      
      // Combine and sort chronologically
      sellerActivityHistory = [...sellerSalesMints, ...sellerBidsLimited]
        .sort((a, b) => a.timestamp - b.timestamp); // Chronological order
    }
    
    // Recipient's full trading history (registrations where minter ≠ recipient)
    let recipientActivityHistory: typeof buyerActivityHistory | null = null;
    if (recipientActivities && eventData.recipientAddress) {
      const allRecipientActivities = recipientActivities
        .filter(a => (a.type === 'mint' || a.type === 'sale' || a.type === 'bid') && a.price?.amount?.decimal !== undefined)
        .map(a => {
          const normalizedRecipientAddress = eventData.recipientAddress!.toLowerCase();
          let role: 'buyer' | 'seller' | 'bidder';
          if (a.type === 'bid') {
            role = 'bidder';
          } else {
            role = a.toAddress.toLowerCase() === normalizedRecipientAddress ? 'buyer' : 'seller';
          }
          const currencyContract = a.price.currency.contract;
          const isEth = CurrencyUtils.isETHEquivalent(currencyContract);
          const rawPrice = isEth ? a.price.amount.decimal : (a.price.amount.native || 0);
          const priceEth = typeof rawPrice === 'number' ? rawPrice : parseFloat(rawPrice) || 0;
          return {
            type: a.type as 'mint' | 'sale' | 'bid',
            timestamp: a.timestamp,
            tokenName: a.token?.tokenName ?? undefined,
            role,
            price: priceEth,
            priceUsd: a.price.amount.usd || 0,
            txHash: a.txHash
          };
        });

      const recipientBids = allRecipientActivities.filter(a => a.type === 'bid');
      const recipientSalesMints = allRecipientActivities.filter(a => a.type !== 'bid');
      const recipientBidsLimited = recipientBids
        .sort((a, b) => b.timestamp - a.timestamp)
        .slice(0, MAX_BIDS_FOR_LLM);

      recipientActivityHistory = [...recipientSalesMints, ...recipientBidsLimited]
        .sort((a, b) => a.timestamp - b.timestamp);
    }

    logger.debug(`   ✅ Buyer activity history: ${buyerActivityHistory.length} entries`);
    if (buyerBidsTruncated) {
      logger.info(`   ⚠️ Buyer bids truncated: showing ${buyerBidsLimited.length}, hiding ${buyerBidsTruncatedCount} older bids`);
    }
    if (sellerActivityHistory) {
      logger.debug(`   ✅ Seller activity history: ${sellerActivityHistory.length} entries`);
      if (sellerBidsTruncated) {
        logger.info(`   ⚠️ Seller bids truncated: showing latest 500, hiding ${sellerBidsTruncatedCount} older bids`);
      }
    }
    if (recipientActivityHistory) {
      logger.debug(`   ✅ Recipient activity history: ${recipientActivityHistory.length} entries`);
    }
    
    // Step 3.75: Check category membership + fetch club stats & recent activity
    logger.debug(`   🎯 Checking category membership for ${eventData.tokenName}...`);
    const { clubs: categories, clubRanks: categoryRanks } = await this.clubService.getClubs(eventData.tokenName);
    const clubInfo = await this.clubService.getFormattedClubString(categories, categoryRanks);

    let clubContext: LLMPromptContext['clubContext'] = null;
    if (categories.length > 0) {
      logger.debug(`   ✅ Category membership found: ${clubInfo}`);
      logger.debug(`   📊 Fetching club stats and activity for ${categories.length} clubs...`);

      const statsMap = await this.clubService.getMultipleClubStats(categories);
      const activityResults = await Promise.all(
        categories.map(slug => GrailsApiService.getClubActivity(slug, { limit: 10 }))
      );

      clubContext = categories
        .map((slug, i) => {
          const stats = statsMap.get(slug);
          if (!stats) return null;
          return { slug, stats, recentActivity: activityResults[i] };
        })
        .filter((c): c is NonNullable<typeof c> => c !== null);

      logger.debug(`   ✅ Club context built for ${clubContext.length} clubs`);
    } else {
      logger.debug(`   ℹ️  No category membership found`);
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
        recipientAddress: eventData.recipientAddress,
        recipientEnsName,
        recipientTwitter,
        txHash: eventData.txHash
      },
      tokenInsights,
      buyerStats,
      sellerStats,
      recipientStats,
      buyerActivityHistory,
      sellerActivityHistory,
      recipientActivityHistory,
      metadata: {
        dataFetchedAt: Date.now(),
        tokenActivityCount: tokenActivities.length,
        buyerActivityCount: buyerActivities.length,
        sellerActivityCount: sellerActivities?.length || 0,
        tokenDataIncomplete: fetchStatus?.tokenDataIncomplete || false,
        buyerDataIncomplete: fetchStatus?.buyerDataIncomplete || false,
        sellerDataIncomplete: fetchStatus?.sellerDataIncomplete || false,
        tokenDataUnavailable: fetchStatus?.tokenDataUnavailable || false,
        buyerDataUnavailable: fetchStatus?.buyerDataUnavailable || false,
        sellerDataUnavailable: fetchStatus?.sellerDataUnavailable || false,
        recipientDataIncomplete: fetchStatus?.recipientDataIncomplete || false,
        recipientDataUnavailable: fetchStatus?.recipientDataUnavailable || false,
        buyerBidsTruncated,
        buyerBidsTruncatedCount,
        sellerBidsTruncated,
        sellerBidsTruncatedCount
      },
      clubInfo,
      clubContext,
      activeListings: [],
      previousReplies: { recent: [], buyer: [], seller: [] }
    };
    
    const processingTime = Date.now() - startTime;
    logger.info(`✅ LLM context built in ${processingTime}ms`);
    logger.debug(`   Token: ${tokenInsights.numberOfSales} historical sales, ${tokenInsights.totalVolume.toFixed(4)} ETH volume`);
    logger.debug(`   Buyer: ${buyerStats.buysCount} buys (${buyerStats.buysVolume.toFixed(4)} ETH), ${buyerStats.sellsCount} sells (${buyerStats.sellsVolume.toFixed(4)} ETH)`);
    if (sellerStats) {
      logger.debug(`   Seller: ${sellerStats.buysCount} buys (${sellerStats.buysVolume.toFixed(4)} ETH), ${sellerStats.sellsCount} sells (${sellerStats.sellsVolume.toFixed(4)} ETH)`);
    }
    if (recipientStats) {
      logger.debug(`   Recipient: ${recipientStats.buysCount} buys (${recipientStats.buysVolume.toFixed(4)} ETH), ${recipientStats.sellsCount} sells (${recipientStats.sellsVolume.toFixed(4)} ETH)`);
    }
    
    return context;
  }
}

// Export singleton instance
export const dataProcessingService = new DataProcessingService();

