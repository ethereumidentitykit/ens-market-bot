import axios, { AxiosResponse, AxiosInstance } from 'axios';
import { logger } from '../utils/logger';
import { MagicEdenBid, BidProcessingStats } from '../types';
import { APIToggleService } from './apiToggleService';

/**
 * Magic Eden V4 API Response Types
 * New activity-based API with improved data structure
 */

/**
 * All available activity types in V4 API
 */
export type MagicEdenV4ActivityType = 
  | 'ASK_CREATED'      // Listing created
  | 'ASK_CANCELLED'    // Listing cancelled
  | 'BID_CREATED'      // Bid/offer created
  | 'BID_CANCELLED'    // Bid/offer cancelled
  | 'BURN'             // NFT burned
  | 'MINT'             // NFT minted
  | 'TRANSFER'         // NFT transferred
  | 'TRADE';           // Sale/trade executed

export interface MagicEdenV4Activity {
  activityType: MagicEdenV4ActivityType;
  activityId: string;
  namespace: string;
  timestamp: string; // ISO 8601 timestamp
  
  collection: {
    id: string; // Contract address
    chain: string;
    name: string;
    symbol: string;
    description: string;
  };
  
  asset: {
    id: string; // Format: "contract:tokenId"
    collectionId: string;
    name: string; // ENS name (e.g., "645.eth")
    description: string;
    assetClass: string;
    attributes: Array<{
      traitType: string;
      value: string;
    }>;
    mediaV2?: {
      main?: {
        type: string;
        uri: string; // Direct image URL
      };
    };
    chain: string;
    contractAddress: string;
    tokenId: string; // Full numeric token ID
    standard: string;
  };
  
  bid: {
    id: string; // Order ID
    status: 'active' | 'cancelled' | 'filled' | 'expired';
    maker: string; // Bidder address
    priceV2: {
      amount: {
        raw: string; // Wei amount
        native: string; // Decimal ETH (e.g., "0.98")
        fiat?: {
          usd?: string; // USD value
        };
      };
      currency: {
        contract: string;
        symbol: string; // WETH, USDC, etc.
        decimals: number;
        displayName: string;
        fiatConversion?: {
          usd: number;
        };
      };
    };
    quantity: {
      filled: string;
      remaining: string;
    };
    expiry: {
      validFrom: string; // ISO timestamp
      validUntil: string; // ISO timestamp
    };
    source: string; // "OPENSEA", "BLUR", etc.
    maxFees: {
      royaltyBp: number;
      makerMarketplaceBp: number;
      takerMarketplaceBp: number;
      lpFeeBp: number;
    };
    createdAt: string; // ISO timestamp
    updatedAt: string; // ISO timestamp
    kind: string;
    criteria: {
      type: string;
      assetId: string; // "contract:tokenId"
    };
    chain: string;
    protocol: string;
    contract: string;
  };
}

export interface MagicEdenV4ActivityResponse {
  activities: MagicEdenV4Activity[];
  pagination: {
    limit: number;
    cursorTimestamp?: string; // ISO timestamp for next page
  };
}

/**
 * Magic Eden V4 API Service
 * Handles fetching ENS bid data using the new V4 activity-based API
 * 
 * Key improvements over V3:
 * - ENS names directly in response (no fallback needed)
 * - Images directly in response (no metadata lookup)
 * - Token IDs directly accessible (no extraction)
 * - Better timestamp handling (ISO strings)
 * - Cleaner pagination (timestamp-based)
 */
export class MagicEdenV4Service {
  private readonly baseUrl: string;
  private readonly ensContracts: string[];
  private readonly axiosInstance: AxiosInstance;
  private readonly apiToggleService: APIToggleService;
  
  constructor() {
    this.baseUrl = 'https://api-mainnet.magiceden.dev/v4';
    this.apiToggleService = APIToggleService.getInstance();
    
    // ENS Contract Addresses (lowercase for consistent matching)
    this.ensContracts = [
      '0x57f1887a8bf19b14fc0df6fd9b2acc9af147ea85', // ENS Base Registrar (old)
      '0xd4416b13d2b3a9abae7acd5d6c2bbdbe25686401'  // ENS Names (new)
    ];
    
    // Create axios instance with interceptor for API toggle protection
    this.axiosInstance = axios.create({
      baseURL: this.baseUrl
    });
    
    // Intercept ALL Magic Eden API requests automatically
    this.axiosInstance.interceptors.request.use((config) => {
      if (!this.apiToggleService.isMagicEdenEnabled()) {
        logger.warn('Magic Eden V4 API call blocked - API disabled via admin toggle');
        throw new Error('Magic Eden API disabled via admin toggle');
      }
      return config;
    });
    
    logger.info('🆕 MagicEdenV4Service initialized (activity-based API)');
  }

  /**
   * Get activities by type from the V4 API with retry logic
   * Generic method that can fetch any activity type
   * 
   * @param activityTypes - Activity types to fetch (BID_CREATED, ASK_CREATED, TRADE, etc.)
   * @param cursor - Optional cursor timestamp for pagination (ISO 8601)
   * @param limit - Number of activities to fetch (default: 100)
   * @param retryCount - Current retry attempt (internal use only)
   * @returns Activities and next cursor
   */
  async getActivities(
    activityTypes: MagicEdenV4ActivityType[],
    cursor?: string,
    limit: number = 100,
    retryCount: number = 0
  ): Promise<{ activities: MagicEdenV4Activity[]; continuation?: string }> {
    const maxRetries = 3;
    const isTimeout = (error: any) => 
      error.code === 'ECONNABORTED' || 
      error.message?.includes('timeout');
    try {
      logger.info(`🔍 Fetching ENS activities from Magic Eden V4 API`);
      logger.info(`📊 Types: ${activityTypes.join(', ')}, Cursor: ${cursor || 'none'}, Limit: ${limit}`);

      // Build query parameters for activity endpoint
      const params: any = {
        chain: 'ethereum',
        collectionId: this.ensContracts[0], // Primary ENS contract (old registry)
        activityType: activityTypes, // V4 API accepts array of types
        limit: limit,
        sortBy: 'timestamp',
        sortDir: 'desc' // Newest first
      };

      // Add cursor for pagination if provided
      if (cursor) {
        params.cursorTimestamp = cursor;
      }

      const response: AxiosResponse<MagicEdenV4ActivityResponse> = await this.axiosInstance.get(
        '/activity/nft',
        {
          params,
          headers: {
            'Accept': '*/*',
            'User-Agent': 'ENS-TwitterBot/2.0'
          },
          timeout: 30000 // 30 seconds
        }
      );

      const activities = response.data.activities || [];
      const nextCursor = response.data.pagination?.cursorTimestamp;
      
      logger.info(`✅ Magic Eden V4 API: Retrieved ${activities.length} activities`);
      
      if (nextCursor) {
        logger.debug(`📄 Next cursor: ${nextCursor}`);
      }

      return {
        activities,
        continuation: nextCursor
      };

    } catch (error: any) {
      const isTimeoutError = isTimeout(error);
      
      // Log error details
      logger.error(`❌ Magic Eden V4 API Error (attempt ${retryCount + 1}/${maxRetries + 1}):`, {
        message: error.message,
        status: error.response?.status,
        code: error.code,
        isTimeout: isTimeoutError
      });

      // Retry logic
      if (retryCount < maxRetries) {
        const waitTime = Math.min(1000 * Math.pow(2, retryCount), 5000); // Exponential backoff, max 5s
        
        // If timeout and first retry, reduce limit to 50
        let newLimit = limit;
        if (isTimeoutError && retryCount === 0 && limit > 50) {
          newLimit = 50;
          logger.warn(`⚠️  Timeout detected, reducing limit from ${limit} to ${newLimit} and retrying...`);
        } else {
          logger.warn(`⚠️  Retrying in ${waitTime}ms...`);
        }
        
        await new Promise(resolve => setTimeout(resolve, waitTime));
        
        // Recursive retry with potentially reduced limit
        return this.getActivities(activityTypes, cursor, newLimit, retryCount + 1);
      }

      // Max retries exceeded - return empty result
      logger.error(`❌ Max retries (${maxRetries}) exceeded for Magic Eden V4 API`);
      return {
        activities: [],
        continuation: undefined
      };
    }
  }

  /**
   * Get active bids using the new activity endpoint
   * Filters for BID_CREATED activities on ENS collections
   * 
   * @param cursor - Optional cursor timestamp for pagination (ISO 8601)
   * @param limit - Number of activities to fetch (default: 100)
   * @returns Bid activities and next cursor
   */
  async getActiveBids(
    cursor?: string,
    limit: number = 100
  ): Promise<{ bids: MagicEdenBid[]; continuation?: string }> {
    try {
      // Use generic getActivities method
      const { activities, continuation } = await this.getActivities(['BID_CREATED'], cursor, limit);
      
      // Transform V4 activities to internal MagicEdenBid format
      const transformedBids = activities
        .filter(activity => activity.activityType === 'BID_CREATED')
        .map(activity => this.transformV4ActivityToBid(activity));

      logger.info(`🎯 Transformed ${transformedBids.length} bids to internal format`);

      return {
        bids: transformedBids,
        continuation
      };

    } catch (error: any) {
      logger.error('❌ Magic Eden V4 API Error (getActiveBids):', error.message);

      // Return empty result on error rather than throwing
      return {
        bids: [],
        continuation: undefined
      };
    }
  }

  /**
   * Get all new bids by cursoring until we hit the boundary timestamp
   * Uses timestamp-based pagination for reliable recovery after downtime
   * 
   * @param boundaryTimestamp - Unix timestamp in milliseconds
   * @returns Object with bids and the newest timestamp seen from API (for safe bookmark updates)
   */
  async getNewBidsSince(boundaryTimestamp: number): Promise<{ bids: MagicEdenBid[]; newestTimestampSeen: number | null }> {
    logger.info(`📈 Cursoring for bids newer than: ${boundaryTimestamp} (${new Date(boundaryTimestamp).toISOString()})`);
    
    const startTime = Date.now();
    let cursor: string | undefined;
    let allNewBids: MagicEdenBid[] = [];
    let newestTimestampSeen: number | null = null; // Track newest timestamp from API
    let totalPages = 0;
    const maxPages = 10; // Safety limit (1000 bids max)
    let consecutiveEmptyPages = 0;
    const maxConsecutiveEmpty = 3; // Stop if 3 pages in a row have 0 new bids
    
    do {
      totalPages++;
      const { bids, continuation } = await this.getActiveBids(cursor);
      
      if (bids.length === 0) break;
      
      // Filter bids to only those newer than our boundary AND with >30min validity remaining
      // V4 API uses ISO timestamps, need to convert for comparison
      let tooOld = 0;
      let expiringSoon = 0;
      
      const newBids = bids.filter(bid => {
        const bidTimestamp = new Date(bid.createdAt).getTime();
        const validUntil = bid.validUntil * 1000; // Convert Unix seconds to milliseconds
        const now = Date.now();
        const fifteenMinutes = 15 * 60 * 1000; // 15 minutes in milliseconds
        
        // Track the newest timestamp we've seen from the API (even if filtered out)
        if (newestTimestampSeen === null || bidTimestamp > newestTimestampSeen) {
          newestTimestampSeen = bidTimestamp;
        }
        
        const isNewerThanBoundary = bidTimestamp > boundaryTimestamp;
        const hasValidityRemaining = validUntil > (now + fifteenMinutes); // Must have >15min remaining
        
        if (!isNewerThanBoundary) tooOld++;
        if (isNewerThanBoundary && !hasValidityRemaining) expiringSoon++;
        
        return isNewerThanBoundary && hasValidityRemaining;
      });
      
      if (tooOld > 0 || expiringSoon > 0) {
        logger.debug(`🔍 Filtered: ${tooOld} too old, ${expiringSoon} expiring soon (<15min remaining)`);
      }
      
      allNewBids.push(...newBids);
      logger.debug(`📄 Page ${totalPages}/${maxPages}: ${bids.length} total, ${newBids.length} new, ${allNewBids.length} collected`);
      
      // Track consecutive empty pages for early exit
      if (newBids.length === 0) {
        consecutiveEmptyPages++;
        if (consecutiveEmptyPages >= maxConsecutiveEmpty) {
          logger.info(`🛑 Stopping after ${consecutiveEmptyPages} consecutive pages with 0 new bids`);
          break;
        }
      } else {
        consecutiveEmptyPages = 0; // Reset on successful page
      }
      
      // Check if oldest bid in this batch is older than boundary - if so, we're done
      const oldestInBatch = Math.min(...bids.map(bid => new Date(bid.createdAt).getTime()));
      const boundaryDate = new Date(boundaryTimestamp).toISOString();
      const oldestDate = new Date(oldestInBatch).toISOString();
      
      logger.debug(`🕒 Oldest bid in batch: ${oldestDate}, Boundary: ${boundaryDate}`);
      
      if (oldestInBatch <= boundaryTimestamp) {
        logger.info(`🎯 Hit boundary timestamp, stopping cursor`);
        break;
      }
      
      cursor = continuation;
      
      // Safety limit to prevent runaway cursoring
      if (totalPages >= maxPages) {
        logger.warn(`⚠️  Hit max pages limit (${maxPages}), stopping cursor`);
        break;
      }
      
      // Rate limiting: 1 call per second
      if (cursor) {
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
      
    } while (cursor);
    
    const totalTime = ((Date.now() - startTime) / 1000).toFixed(1);
    logger.info(`✅ Cursored ${totalPages} pages in ${totalTime}s, found ${allNewBids.length} new bids`);
    
    if (totalPages > 1) {
      const avgTimePerPage = (parseFloat(totalTime) / totalPages).toFixed(1);
      logger.debug(`⚡ Average: ${avgTimePerPage}s per page (includes 1s rate limiting)`);
    }
    
    if (newestTimestampSeen) {
      logger.debug(`📍 Newest timestamp from API: ${new Date(newestTimestampSeen).toISOString()}`);
    }
    
    return {
      bids: allNewBids,
      newestTimestampSeen
    };
  }

  /**
   * Transform V4 activity to internal MagicEdenBid format
   * Maintains compatibility with existing BidsProcessingService
   * 
   * Key mappings:
   * - activity.asset.name -> ENS name (directly available! 🎉)
   * - activity.asset.mediaV2.main.uri -> NFT image (directly available! 🎉)
   * - activity.asset.tokenId -> Token ID (no extraction needed! 🎉)
   * - activity.bid.priceV2.amount.native -> Decimal price
   * - activity.bid.expiry -> validFrom/validUntil
   */
  private transformV4ActivityToBid(activity: MagicEdenV4Activity): MagicEdenBid {
    // Parse timestamps - V4 uses ISO strings, we need Unix timestamps (seconds)
    const validFrom = Math.floor(new Date(activity.bid.expiry.validFrom).getTime() / 1000);
    const validUntil = Math.floor(new Date(activity.bid.expiry.validUntil).getTime() / 1000);
    
    // Extract marketplace fee (sum of all fees)
    const totalFeeBps = 
      activity.bid.maxFees.royaltyBp +
      activity.bid.maxFees.makerMarketplaceBp +
      activity.bid.maxFees.takerMarketplaceBp +
      activity.bid.maxFees.lpFeeBp;

    return {
      id: activity.bid.id,
      kind: activity.bid.kind,
      side: 'buy', // Bids are always buy side
      status: activity.bid.status,
      tokenSetId: activity.bid.criteria.assetId, // Use assetId as tokenSetId for compatibility
      tokenSetSchemaHash: '', // Not provided in V4, not critical
      contract: activity.asset.contractAddress,
      maker: activity.bid.maker,
      taker: '0x0000000000000000000000000000000000000000', // Not provided in V4, use zero address
      
      price: {
        currency: {
          contract: activity.bid.priceV2.currency.contract,
          name: activity.bid.priceV2.currency.displayName,
          symbol: activity.bid.priceV2.currency.symbol,
          decimals: activity.bid.priceV2.currency.decimals,
        },
        amount: {
          raw: activity.bid.priceV2.amount.raw,
          decimal: parseFloat(activity.bid.priceV2.amount.native),
          usd: parseFloat(activity.bid.priceV2.amount.fiat?.usd || '0'),
          native: parseFloat(activity.bid.priceV2.amount.native), // V4 provides this directly
        },
      },
      
      validFrom: validFrom,
      validUntil: validUntil,
      quantityFilled: activity.bid.quantity.filled,
      quantityRemaining: activity.bid.quantity.remaining,
      
      // 🎉 V4 provides ENS name and image directly - no metadata lookup needed!
      criteria: {
        kind: 'token',
        data: {
          token: {
            tokenId: activity.asset.tokenId,
            name: activity.asset.name, // ENS name is here! (e.g., "645.eth")
            image: activity.asset.mediaV2?.main?.uri, // Image is here!
          },
        },
      },
      
      source: {
        id: activity.bid.source.toLowerCase(),
        domain: `${activity.bid.source.toLowerCase()}.io`, // Approximate domain
        name: activity.bid.source,
        icon: '', // Not provided in V4
        url: '', // Not provided in V4
      },
      
      feeBps: totalFeeBps,
      feeBreakdown: [
        {
          kind: 'marketplace',
          recipient: '', // Not provided in V4
          bps: totalFeeBps,
        },
      ],
      
      expiration: validUntil,
      isReservoir: activity.bid.source === 'RESERVOIR', // V4 is powered by Reservoir
      createdAt: activity.bid.createdAt,
      updatedAt: activity.bid.updatedAt,
    };
  }

  /**
   * Extract ENS token ID - V4 provides it directly, no extraction needed!
   * Kept for API compatibility with existing code
   */
  extractTokenId(tokenSetId: string): string | null {
    try {
      // V4 format: "contract:tokenId"
      const parts = tokenSetId.split(':');
      if (parts.length === 2) {
        return parts[1];
      }
      return tokenSetId; // Already just the token ID
    } catch (error: any) {
      logger.error(`❌ Error extracting token ID from ${tokenSetId}:`, error.message);
      return null;
    }
  }

  /**
   * Transform bid to internal storage format
   * Compatible with existing BidsProcessingService.transformBid()
   */
  transformBid(magicEdenBid: MagicEdenBid): {
    bidId: string;
    contractAddress: string;
    tokenId: string | null;
    makerAddress: string;
    takerAddress: string;
    status: string;
    priceRaw: string;
    priceDecimal: string;
    priceUsd: string;
    currencyContract: string;
    currencySymbol: string;
    sourceDomain: string;
    sourceName: string;
    marketplaceFee: number;
    createdAtApi: string;
    updatedAtApi: string;
    validFrom: number;
    validUntil: number;
    processedAt: string;
    ensName?: string;
    nftImage?: string;
  } {
    return {
      bidId: magicEdenBid.id,
      contractAddress: magicEdenBid.contract,
      tokenId: this.extractTokenId(magicEdenBid.tokenSetId),
      makerAddress: magicEdenBid.maker,
      takerAddress: magicEdenBid.taker,
      status: 'unposted', // Always use 'unposted' for internal status
      priceRaw: magicEdenBid.price.amount.raw,
      priceDecimal: magicEdenBid.price.amount.decimal.toString(),
      priceUsd: magicEdenBid.price.amount.usd?.toString() || '',
      currencyContract: magicEdenBid.price.currency.contract,
      currencySymbol: magicEdenBid.price.currency.symbol,
      sourceDomain: magicEdenBid.source.domain,
      sourceName: magicEdenBid.source.name,
      marketplaceFee: magicEdenBid.feeBps,
      createdAtApi: magicEdenBid.createdAt,
      updatedAtApi: magicEdenBid.updatedAt,
      validFrom: magicEdenBid.validFrom,
      validUntil: magicEdenBid.validUntil,
      processedAt: new Date().toISOString(),
      // 🎉 ENS name and image directly from V4 API!
      ensName: magicEdenBid.criteria?.data?.token?.name,
      nftImage: magicEdenBid.criteria?.data?.token?.image,
    };
  }

  /**
   * Calculate human-readable duration from timestamps
   */
  calculateBidDuration(validFrom: number, validUntil: number): string {
    const durationMs = (validUntil - validFrom) * 1000;
    const minutes = Math.floor(durationMs / (1000 * 60));
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);
    const weeks = Math.floor(days / 7);
    const months = Math.floor(days / 30);
    
    if (months >= 6) return `${months} months`;
    if (months >= 1) return `${months} month${months > 1 ? 's' : ''}`;
    if (weeks >= 1) return `${weeks} week${weeks > 1 ? 's' : ''}`;
    if (days >= 1) return `${days} day${days > 1 ? 's' : ''}`;
    if (hours >= 1) return `${hours} hour${hours > 1 ? 's' : ''}`;
    if (minutes >= 1) return `${minutes} minute${minutes > 1 ? 's' : ''}`;
    return 'less than 1 minute';
  }

  /**
   * Get user-friendly currency display name
   */
  getCurrencyDisplayName(symbol: string): string {
    const currencyMap: { [key: string]: string } = {
      'WETH': 'ETH',
      'USDC': 'USDC',
      'USDT': 'USDT',
      'DAI': 'DAI'
    };
    return currencyMap[symbol.toUpperCase()] || symbol;
  }

  /**
   * Get recent sales (TRADE activities)
   * Useful for AI reply context and market analysis
   * 
   * @param cursor - Optional cursor for pagination
   * @param limit - Number of sales to fetch
   * @returns Trade activities and next cursor
   */
  async getRecentSales(
    cursor?: string,
    limit: number = 100
  ): Promise<{ activities: MagicEdenV4Activity[]; continuation?: string }> {
    logger.info(`📊 Fetching recent ENS sales from V4 API`);
    return this.getActivities(['TRADE'], cursor, limit);
  }

  /**
   * Get active listings (ASK_CREATED activities)
   * Useful for showing what's available for sale
   * 
   * @param cursor - Optional cursor for pagination
   * @param limit - Number of listings to fetch
   * @returns Ask activities and next cursor
   */
  async getActiveListings(
    cursor?: string,
    limit: number = 100
  ): Promise<{ activities: MagicEdenV4Activity[]; continuation?: string }> {
    logger.info(`📋 Fetching active ENS listings from V4 API`);
    return this.getActivities(['ASK_CREATED'], cursor, limit);
  }

  /**
   * Get complete token activity history (all types)
   * Useful for comprehensive market analysis
   * 
   * @param cursor - Optional cursor for pagination
   * @param limit - Number of activities to fetch
   * @returns All activities and next cursor
   */
  async getAllActivities(
    cursor?: string,
    limit: number = 100
  ): Promise<{ activities: MagicEdenV4Activity[]; continuation?: string }> {
    logger.info(`📈 Fetching all ENS activities from V4 API`);
    return this.getActivities(
      ['ASK_CREATED', 'ASK_CANCELLED', 'BID_CREATED', 'BID_CANCELLED', 'BURN', 'MINT', 'TRANSFER', 'TRADE'],
      cursor,
      limit
    );
  }

  /**
   * Get bid cancellations
   * Useful for tracking expired/cancelled bids
   * 
   * @param cursor - Optional cursor for pagination
   * @param limit - Number of cancellations to fetch
   * @returns Bid cancellation activities
   */
  async getBidCancellations(
    cursor?: string,
    limit: number = 100
  ): Promise<{ activities: MagicEdenV4Activity[]; continuation?: string }> {
    logger.info(`❌ Fetching bid cancellations from V4 API`);
    return this.getActivities(['BID_CANCELLED'], cursor, limit);
  }

  /**
   * Check if a specific ENS name has club category attribute
   * V4 provides this in asset.attributes - useful for early filtering
   * 
   * @param activity - V4 activity to check
   * @returns Club category if found (e.g., "999 Club")
   */
  getClubCategory(activity: MagicEdenV4Activity): string | null {
    if (!activity.asset?.attributes) return null;
    
    const categoryAttr = activity.asset.attributes.find(
      attr => attr.traitType === 'Category' && attr.value.includes('Club')
    );
    
    return categoryAttr?.value || null;
  }

  /**
   * Health check for V4 API
   */
  async healthCheck(): Promise<boolean> {
    try {
      await this.getActiveBids(undefined, 1);
      return true;
    } catch (error) {
      logger.error('❌ Magic Eden V4 API health check failed:', error);
      return false;
    }
  }
}

