import { MagicEdenService } from './magicEdenService';
import { IDatabaseService, ENSBid, BidProcessingStats, MagicEdenBid } from '../types';
import { logger } from '../utils/logger';
import { AlchemyService } from './alchemyService';
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
  private alchemyService: AlchemyService; // For ETH price

  constructor(
    magicEdenService: MagicEdenService, 
    databaseService: IDatabaseService,
    alchemyService: AlchemyService
  ) {
    this.magicEdenService = magicEdenService;
    this.databaseService = databaseService;
    this.alchemyService = alchemyService;
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
      
      // Boundary logic: Use 1-hour maximum lookback cap for safety
      const oneHourAgo = Date.now() - (60 * 60 * 1000); // 1 hour cap
      const boundaryTimestamp = Math.max(lastProcessedTimestamp, oneHourAgo);
      
      logger.info(`🔒 Using 1-hour lookback cap for safe API usage`);
      logger.info(`📈 Cursoring for bids newer than: ${boundaryTimestamp} (${new Date(boundaryTimestamp).toISOString()})`);

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
   * Only calls ENS service if Magic Eden didn't provide name/image
   */
  private async enrichBidWithMetadata(bid: any): Promise<any> {
    try {
      if (!bid.tokenId) {
        return bid;
      }

      // Check if Magic Eden already provided metadata (80-90% of cases)
      const hasName = !!bid.ensName;
      const hasImage = !!bid.nftImage;
      
      logger.debug(`🔍 Magic Eden metadata check - Name: ${hasName ? `"${bid.ensName}"` : 'missing'}, Image: ${hasImage ? 'provided' : 'missing'}`);
      
      if (hasName && hasImage) {
        logger.debug(`✅ Using Magic Eden metadata for ${bid.ensName} (no API call needed)`);
        return {
          ...bid,
          nftDescription: undefined, // Magic Eden doesn't provide description
        };
      }

      // Only fetch from ENS service if missing data
      logger.debug(`🖼️  Fetching missing ENS metadata for token ID: ${bid.tokenId} (name: ${hasName ? '✓' : '✗'}, image: ${hasImage ? '✓' : '✗'})`);
      const metadataStartTime = Date.now();
      
      // Use the actual contract address from the bid (instead of hard-coding old contract)
      const ensContract = bid.contractAddress || '0x57f1887a8bf19b14fc0df6fd9b2acc9af147ea85';
      const metadataUrl = `https://metadata.ens.domains/mainnet/${ensContract}/${bid.tokenId}`;
      
      logger.debug(`🔗 Using contract ${ensContract} for metadata lookup`);
      
      const response = await axios.get(metadataUrl, { timeout: 3000 }); // Reduced from 10s to 3s
      const metadata: ENSMetadata = response.data;
      
      const metadataTime = Date.now() - metadataStartTime;
      logger.debug(`✅ ENS metadata fetched in ${metadataTime}ms for: ${metadata.name}`);
      
      return {
        ...bid,
        // Use Magic Eden data if available, otherwise ENS metadata
        ensName: bid.ensName || metadata.name,
        nftImage: bid.nftImage || metadata.image || metadata.image_url,
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
      const ethPriceUSD = await this.alchemyService.getETHPriceUSD();
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

      // Skip bids without token ID - can't resolve ENS name
      if (!bid.tokenId || bid.tokenId === 'null') {
        logger.debug(`🚫 Skipping bid without token ID: ${bid.bidId || 'unknown'}`);
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
        const passes = priceEth >= ethMinimum;
        
        // DEBUG: Log filtering decision for troubleshooting
        const bidName = bid.ensName || bid.tokenId?.slice(-6) || 'unnamed';
        logger.info(`🔍 BID FILTER: ${bidName} - ${priceEth} ETH vs ${ethMinimum} ETH minimum = ${passes ? 'PASS ✅' : 'REJECT ❌'}`);
        
        return passes;
      }
      
      // For stablecoins, use fixed USD minimums
      if (bid.currencySymbol === 'USDC' || bid.currencySymbol === 'USDT') {
        return priceEth >= 100; // Minimum $100 for stablecoins
      }

      // Default minimum for other currencies  
      return priceEth >= 0.4; // Increased fallback

    } catch (error: any) {
      logger.error(`Error in bid filtering:`, error.message);
      return false;
    }
  }

  /**
   * Get ETH minimum requirement for a bid based on ENS name category
   * Uses Magic Eden data first, only calls ENS service if name is missing
   */
  private async getEthMinimumForBid(bid: any): Promise<number> {
    try {
      // Simple database lookups for limits
      const defaultMin = await this.databaseService.getSystemState('autopost_bids_min_eth_default') || '5';
      const club10kMin = await this.databaseService.getSystemState('autopost_bids_min_eth_10k') || '5';
      const club999Min = await this.databaseService.getSystemState('autopost_bids_min_eth_999') || '20';
      
      // DEBUG: Log the actual database values being used
      logger.info(`🔍 BID THRESHOLDS: Default=${defaultMin}, 10k=${club10kMin}, 999=${club999Min}`);
      
      // Use Magic Eden name if available (80-90% of cases)
      let ensName = bid.ensName || '';
      
      if (ensName) {
        logger.debug(`🚀 Using Magic Eden name for filtering: "${ensName}" (no API call needed)`);
      }
      
      // Only call ENS service if Magic Eden didn't provide the name
      if (!ensName && bid.tokenId) {
        try {
          logger.debug(`🔍 Fetching ENS name for filtering (Magic Eden didn't provide): ${bid.tokenId}`);
          const ensContract = '0x57f1887a8bf19b14fc0df6fd9b2acc9af147ea85';
          const metadataUrl = `https://metadata.ens.domains/mainnet/${ensContract}/${bid.tokenId}`;
          
          const response = await fetch(metadataUrl);
          if (response.ok) {
            const metadata = await response.json();
            ensName = metadata.name || '';
            logger.debug(`✅ ENS name resolved: ${ensName}`);
          }
        } catch (error) {
          logger.debug(`🚫 ENS name resolution failed, rejecting bid without proper name`);
          return 999; // Impossibly high threshold = always reject
        }
      }

      // Final check: reject if still no ENS name
      if (!ensName) {
        logger.debug(`🚫 No ENS name available, rejecting bid without proper name`);
        return 999; // Impossibly high threshold = always reject
      }

      // Apply club-aware logic
      const patterns = this.getClubPatterns();

      if (patterns.CLUB_999_PATTERN.test(ensName)) {
        return parseFloat(club999Min);
      } else if (patterns.CLUB_10K_PATTERN.test(ensName)) {
        return parseFloat(club10kMin);
      } else {
        return parseFloat(defaultMin);
      }

    } catch (error: any) {
      logger.warn(`Error determining ETH minimum for bid:`, error.message);
      return 0.4; // Fallback
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
