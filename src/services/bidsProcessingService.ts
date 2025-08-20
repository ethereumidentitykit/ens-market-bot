import { MagicEdenService } from './magicEdenService';
import { IDatabaseService, ENSBid, BidProcessingStats, MagicEdenBid } from '../types';
import { logger } from '../utils/logger';
import { MoralisService } from './moralisService';
import axios from 'axios';

interface ENSMetadata {
  name: string;
  description: string;
  image: string;
  image_url: string;
  attributes: any[];
}

export class BidsProcessingService {
  private magicEdenService: MagicEdenService;
  private databaseService: IDatabaseService;
  private moralisService: MoralisService; // For ETH price and ENS metadata

  constructor(
    magicEdenService: MagicEdenService, 
    databaseService: IDatabaseService,
    moralisService: MoralisService
  ) {
    this.magicEdenService = magicEdenService;
    this.databaseService = databaseService;
    this.moralisService = moralisService;
  }

  /**
   * Process new ENS bids using timestamp-based pagination
   * Implements reliable processing with downtime recovery
   */
  async processNewBids(): Promise<BidProcessingStats> {
    const stats: BidProcessingStats = {
      newBids: 0,
      duplicates: 0,
      filtered: 0,
      errors: 0,
      processedCount: 0,
    };

    try {
      logger.info('🔍 Starting ENS bids processing...');
      
      // Get last processed timestamp and apply boundary logic
      const lastProcessedTimestamp = await this.databaseService.getLastProcessedBidTimestamp();
      
      // Boundary logic: For testing use future timestamp, for production use lookback cap
      const isTestMode = process.env.NODE_ENV !== 'production';
      let boundaryTimestamp: number;
      
      if (isTestMode) {
        // Testing: use 7 days ago as boundary (captures all recent bids for first run)
        boundaryTimestamp = Date.now() - (7 * 24 * 60 * 60 * 1000); // 7 days ago
        logger.info(`📅 Boundary timestamp: ${boundaryTimestamp} (${new Date(boundaryTimestamp).toISOString()})`);
        logger.info(`🧪 Testing mode: Using 7-day lookback boundary to capture recent bids`);
      } else {
        // Production: use 1-day lookback cap to prevent runaway cursoring
        const oneDayAgo = Date.now() - (24 * 60 * 60 * 1000); // 1 day cap
        boundaryTimestamp = Math.max(lastProcessedTimestamp, oneDayAgo);
        logger.info(`📅 Boundary timestamp: ${boundaryTimestamp} (${new Date(boundaryTimestamp).toISOString()})`);
        logger.info(`🏭 Production mode: Using 1-day lookback cap`);
      }

      // Cursor through API until we hit the boundary timestamp
      const newBidsUnsorted = await this.magicEdenService.getNewBidsSince(boundaryTimestamp);
      logger.info(`📊 Cursor-based fetch: Retrieved ${newBidsUnsorted.length} new bids`);

      if (newBidsUnsorted.length === 0) {
        logger.info('✅ No new bids found - all up to date');
        return stats;
      }

      // Sort bids chronologically (oldest first) for consistent database insertion
      // Even though API returns newest first, we process oldest first
      const newBids = newBidsUnsorted.sort((a, b) => {
        const timestampA = new Date(a.createdAt).getTime();
        const timestampB = new Date(b.createdAt).getTime();
        return timestampA - timestampB; // Ascending order (oldest first)
      });
      
      const oldestBid = new Date(newBids[0].createdAt).toISOString();
      const newestBid = new Date(newBids[newBids.length - 1].createdAt).toISOString();
      logger.info(`🔄 Sorted for chronological processing: ${oldestBid} → ${newestBid}`);

      // Calculate newest timestamp from all bids retrieved
      let newestTimestamp = boundaryTimestamp; // Start with boundary as minimum
      for (const bid of newBids) {
        const bidTimestamp = new Date(bid.createdAt).getTime();
        newestTimestamp = Math.max(newestTimestamp, bidTimestamp);
      }

      // Process each bid
      for (const magicEdenBid of newBids) {
        try {
          await this.processSingleBid(magicEdenBid, stats);
          stats.processedCount++;
        } catch (error: any) {
          logger.error(`❌ Failed to process bid ${magicEdenBid.id}:`, error.message);
          stats.errors++;
        }
      }

      // Always update timestamp (even if all filtered - API credit optimization)
      await this.databaseService.setLastProcessedBidTimestamp(newestTimestamp);
      logger.info(`📍 Updated last processed timestamp to: ${newestTimestamp} (processed: ${stats.newBids}, filtered: ${stats.filtered})`);

      logger.info(`✅ Bids processing complete: ${stats.newBids} new, ${stats.duplicates} duplicates, ${stats.filtered} filtered, ${stats.errors} errors`);
      return stats;

    } catch (error: any) {
      logger.error('❌ ENS bids processing failed:', error.message);
      stats.errors++;
      return stats;
    }
  }

  /**
   * Process a single ENS bid
   */
  private async processSingleBid(magicEdenBid: MagicEdenBid, stats: BidProcessingStats): Promise<void> {
    try {
      // Check if already processed (duplicate detection)
      const isProcessed = await this.databaseService.isBidProcessed(magicEdenBid.id);
      if (isProcessed) {
        logger.debug(`⏭️  Bid ${magicEdenBid.id} already processed, skipping`);
        stats.duplicates++;
        return;
      }

      // Transform Magic Eden bid to our internal format
      const transformedBid = this.magicEdenService.transformBid(magicEdenBid);

      // Apply filtering logic
      if (!(await this.shouldProcessBid(transformedBid))) {
        logger.debug(`🚫 Bid ${magicEdenBid.id} filtered out (${transformedBid.priceDecimal} ${transformedBid.currencySymbol})`);
        stats.filtered++;
        return;
      }

      // Enrich with ENS metadata (if token ID available)
      let enrichedBid = { ...transformedBid };
      if (transformedBid.tokenId) {
        try {
          enrichedBid = await this.enrichBidWithMetadata(transformedBid);
        } catch (error: any) {
          logger.warn(`⚠️  Failed to enrich bid ${magicEdenBid.id} with metadata:`, error.message);
          // Continue without metadata
        }
      }

      // Add USD pricing
      enrichedBid = await this.addUSDPricing(enrichedBid);

      // Add default values for database insertion
      const bidForStorage = {
        ...enrichedBid,
        tokenId: enrichedBid.tokenId || undefined, // Convert null to undefined
        posted: false, // New bids are not posted yet
        tweetId: undefined,
        createdAt: undefined,
        updatedAt: undefined
      };

      // Store in database
      const insertedId = await this.databaseService.insertBid(bidForStorage);
      logger.info(`✅ Stored bid ${magicEdenBid.id} (ID: ${insertedId}) - ${enrichedBid.priceDecimal} ${enrichedBid.currencySymbol}`);
      
      stats.newBids++;

    } catch (error: any) {
      if (error.message?.includes('already processed')) {
        stats.duplicates++;
      } else {
        throw error;
      }
    }
  }

  /**
   * Enrich bid with ENS metadata (image, description)
   */
  private async enrichBidWithMetadata(bid: any): Promise<any> {
    try {
      if (!bid.tokenId) {
        return bid;
      }

      logger.debug(`🖼️  Fetching ENS metadata for token ID: ${bid.tokenId}`);
      const metadataStartTime = Date.now();
      
      // Use ENS Base Registrar contract for metadata
      const ensContract = '0x57f1887a8bf19b14fc0df6fd9b2acc9af147ea85';
      const metadataUrl = `https://metadata.ens.domains/mainnet/${ensContract}/${bid.tokenId}`;
      
      const response = await axios.get(metadataUrl, { timeout: 3000 }); // Reduced from 10s to 3s
      const metadata: ENSMetadata = response.data;
      
      const metadataTime = Date.now() - metadataStartTime;
      logger.debug(`✅ ENS metadata fetched in ${metadataTime}ms for: ${metadata.name}`);
      
      return {
        ...bid,
        ensName: metadata.name, // Store the actual ENS name
        nftImage: metadata.image || metadata.image_url,
        nftDescription: metadata.description,
      };

    } catch (error: any) {
      logger.warn(`Failed to fetch ENS metadata for ${bid.tokenId}:`, error.message);
      return bid;
    }
  }

  /**
   * Add USD pricing to bid data
   */
  private async addUSDPricing(bid: any): Promise<any> {
    try {
      // Only add USD pricing for ETH/WETH bids
      if (bid.currencySymbol !== 'WETH' && bid.currencySymbol !== 'ETH') {
        return bid;
      }

      const pricingStartTime = Date.now();
      const ethPriceUSD = await this.moralisService.getETHPriceUSD();
      const pricingTime = Date.now() - pricingStartTime;
      
      if (ethPriceUSD) {
        const priceUsd = (parseFloat(bid.priceDecimal) * ethPriceUSD).toFixed(2);
        logger.debug(`💰 USD pricing added in ${pricingTime}ms: ${bid.priceDecimal} ETH = $${priceUsd}`);
        return {
          ...bid,
          priceUsd
        };
      }

      return bid;
    } catch (error: any) {
      logger.warn(`Failed to add USD pricing for bid:`, error.message);
      return bid;
    }
  }

  /**
   * Filtering logic for ENS bids
   * Applies club-aware minimum thresholds and age limits
   */
  private async shouldProcessBid(bid: any): Promise<boolean> {
    try {
      // Only process active bids
      if (bid.status !== 'active') {
        return false;
      }

      // Age filter: only bids from last 24 hours
      const bidAge = Date.now() - new Date(bid.createdAtApi).getTime();
      const maxAge = 24 * 60 * 60 * 1000; // 24 hours
      if (bidAge > maxAge) {
        return false;
      }

      // Price filtering with club-aware thresholds
      const priceEth = parseFloat(bid.priceDecimal);
      
      // For ETH/WETH bids, apply club-aware filtering
      if (bid.currencySymbol === 'WETH' || bid.currencySymbol === 'ETH') {
        const ethMinimum = await this.getEthMinimumForBid(bid);
        return priceEth >= ethMinimum;
      }
      
      // For stablecoins, use fixed USD minimums
      if (bid.currencySymbol === 'USDC' || bid.currencySymbol === 'USDT') {
        return priceEth >= 100; // Minimum $100 for stablecoins
      }

      // Default minimum for other currencies  
      return priceEth >= 0.1; // Consistent 0.1 ETH equivalent for all currencies

    } catch (error: any) {
      logger.error(`Error in bid filtering:`, error.message);
      return false;
    }
  }

  /**
   * Get ETH minimum requirement for a bid based on ENS name category
   */
  private async getEthMinimumForBid(bid: any): Promise<number> {
    try {
      // We need the ENS name to determine the category
      // If we don't have it cached, resolve it temporarily for filtering
      let ensName = '';
      
      if (bid.tokenId) {
        try {
          // Temporary ENS name resolution for filtering  
          const ensContract = '0x57f1887a8bf19b14fc0df6fd9b2acc9af147ea85';
          const metadataUrl = `https://metadata.ens.domains/mainnet/${ensContract}/${bid.tokenId}`;
          
          const response = await fetch(metadataUrl);
          if (response.ok) {
            const metadata = await response.json();
            ensName = metadata.name || '';
          }
        } catch (error) {
          // If resolution fails, use default threshold
          return this.getDefaultBidMinimums().minEthDefault;
        }
      }

      // Apply club-aware logic
      const patterns = this.getClubPatterns();
      const minimums = this.getDefaultBidMinimums();

      if (patterns.CLUB_999_PATTERN.test(ensName)) {
        return minimums.minEth999Club;
      } else if (patterns.CLUB_10K_PATTERN.test(ensName)) {
        return minimums.minEth10kClub;
      } else {
        return minimums.minEthDefault;
      }

    } catch (error: any) {
      logger.warn(`Error determining ETH minimum for bid:`, error.message);
      return this.getDefaultBidMinimums().minEthDefault;
    }
  }

  /**
   * Get club detection patterns (same as AutoTweetService)
   */
  private getClubPatterns() {
    return {
      CLUB_10K_PATTERN: /^\d{4}\.eth$/, // e.g., 1234.eth
      CLUB_999_PATTERN: /^\d{3}\.eth$/  // e.g., 123.eth
    };
  }

  /**
   * Get default bid minimums for ingestion (will be filtered again pre-tweet)
   */
  private getDefaultBidMinimums() {
    return {
      minEthDefault: 0.1,     // Base minimum for ingestion - 0.1 ETH
      minEth10kClub: 0.1,     // Same for all categories at ingestion
      minEth999Club: 0.1      // Club-specific filtering happens pre-tweet
    };
  }

  /**
   * Calculate human-readable bid duration
   * Uses the calculation from MagicEdenService
   */
  calculateBidDuration(validFrom: number, validUntil: number): string {
    return this.magicEdenService.calculateBidDuration(validFrom, validUntil);
  }

  /**
   * Get user-friendly currency display name
   */
  getCurrencyDisplayName(symbol: string): string {
    return this.magicEdenService.getCurrencyDisplayName(symbol);
  }

  /**
   * Manual sync method for dashboard/testing
   */
  async manualSync(): Promise<{
    success: boolean;
    stats?: BidProcessingStats;
    error?: string;
  }> {
    try {
      logger.info('🔧 Manual ENS bids sync started');
      
      const stats = await this.processNewBids();
      
      return {
        success: true,
        stats,
      };
    } catch (error: any) {
      logger.error('❌ Manual bids sync failed:', error.message);
      return {
        success: false,
        error: error.message,
      };
    }
  }
}
