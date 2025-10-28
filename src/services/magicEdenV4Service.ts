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
  
  // For TRANSFER and TRADE activities
  assetAmount?: string;
  fromAddress?: string;
  toAddress?: string;
  
  // For TRADE activities
  unitPrice?: {
    amount: {
      raw: string;
      native: string;
      fiat?: {
        usd?: string;
      };
    };
    currency: {
      contract: string;
      symbol: string;
      decimals: number;
      displayName: string;
      fiatConversion?: {
        usd: number;
      };
    };
  };
  
  order?: {
    orderId: string;
    sourceDomain: string;
  };
  
  fillSource?: {
    domain: string;
  };
  
  transactionInfo?: {
    transactionId: string;
    blockNumber: number;
    blockHash: string;
    logIndex: number;
    batchTransferIndex: number;
  };
  
  // For BID_CREATED activities
  bid?: {
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
 * Active Ask (Listing) from V4 /asks endpoint
 */
export interface MagicEdenV4Ask {
  id: string; // Order ID
  status: 'active' | 'cancelled' | 'filled' | 'expired';
  maker: string; // Seller address
  price: {
    currency: {
      symbol: string;
      decimals: number;
      displayName: string;
      address: string;
      assetId: string;
      fiatConversion?: {
        usd: number;
      };
    };
    noFeesRaw: string;
    withRequiredFeesRaw: string;
  };
  priceV2: {
    amount: {
      raw: string; // Wei
      native: string; // Decimal (e.g., "0.019")
      fiat?: {
        usd?: string;
      };
    };
    currency: {
      contract: string;
      symbol: string;
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
  kind: 'ASK';
  assetId: string; // "contract:tokenId"
  chain: string;
  protocol: string; // "ERC721"
  contract: string;
  contractData: {
    orderContractKind: string;
  };
}

export interface MagicEdenV4AsksResponse {
  asks: MagicEdenV4Ask[];
  asksByAssetId: Array<{
    assetId: string;
    asks: MagicEdenV4Ask[];
  }>;
}

/**
 * Bid from V4 /bids endpoint (simplified, direct bid data)
 */
export interface MagicEdenV4Bid {
  id: string; // Order ID
  status: 'active' | 'cancelled' | 'filled' | 'expired';
  maker: string; // Bidder address
  price: {
    currency: {
      symbol: string;
      decimals: number;
      displayName: string;
      address: string;
      assetId: string;
      fiatConversion?: {
        usd: number;
      };
    };
    noFeesRaw: string;
    withRequiredFeesRaw: string;
  };
  priceV2: {
    amount: {
      raw: string; // Wei
      native: string; // Decimal (e.g., "0.250000000000000000")
      fiat?: {
        usd?: string;
      };
    };
    currency: {
      contract: string;
      symbol: string;
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
  kind: 'BID';
  criteria: {
    type: 'ASSET' | 'COLLECTION';
    assetId: string; // "contract:tokenId"
  };
  chain: string;
  protocol: string; // "ERC721"
  contract: string;
  contractData: {
    orderContractKind: string;
  };
}

export interface MagicEdenV4BidsResponse {
  data: Array<{
    bid: MagicEdenV4Bid;
  }>;
  pagination: {
    limit: number;
    offset: number;
  };
}

/**
 * V3 Token Activity Format (Legacy)
 * V4 API transforms to this format for backward compatibility
 * This is the shared format used by data processing services
 */
export interface TokenActivity {
  type: 'mint' | 'sale' | 'transfer' | 'ask' | 'bid' | 'ask_cancel' | 'bid_cancel';
  fromAddress: string;
  toAddress: string;
  price: {
    currency: {
      contract: string;
      name: string;
      symbol: string;
      decimals: number;
    };
    amount: {
      raw: string;
      decimal: number;
      usd: number;
      native: number;
    };
  };
  amount: number;
  timestamp: number;
  createdAt: string;
  contract: string;
  token: {
    tokenId: string;
    isSpam: boolean;
    isNsfw: boolean;
    tokenName: string | null;
    tokenImage: string | null;
    rarityScore: number | null;
    rarityRank: number | null;
  };
  collection: {
    collectionId: string;
    isSpam: boolean;
    isNsfw: boolean;
    collectionName: string;
    collectionImage: string;
  };
  txHash: string;
  logIndex: number;
  batchIndex: number;
  fillSource?: {
    domain: string;
    name: string;
    icon: string;
  };
  comment: string | null;
}

export interface TokenActivityResponse {
  activities: TokenActivity[];
  continuation: string | null;
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
   * Get activities from a single collection (helper method)
   * Private method used by getActivities to fetch from one contract
   * 
   * @param collectionId - Single collection contract address
   * @param activityTypes - Activity types to fetch
   * @param cursor - Optional cursor for pagination
   * @param limit - Number of activities to fetch
   * @param retryCount - Current retry attempt
   * @returns Activities and next cursor
   */
  private async getActivitiesForCollection(
    collectionId: string,
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
      const params = new URLSearchParams({
        chain: 'ethereum',
        collectionId: collectionId,
        limit: limit.toString(),
        sortBy: 'timestamp',
        sortDir: 'desc'
      });

      // Add activity types as array parameters
      activityTypes.forEach(type => params.append('activityTypes[]', type));

      // Add cursor for pagination if provided
      if (cursor) {
        params.append('cursorTimestamp', cursor);
      }

      const fullUrl = `/activity/nft?${params.toString()}`;
      logger.debug(`🌐 Full URL: ${fullUrl}`);

      const response: AxiosResponse<MagicEdenV4ActivityResponse> = await this.axiosInstance.get(
        fullUrl,
        {
          headers: {
            'Accept': '*/*',
            'User-Agent': 'ENS-TwitterBot/2.0'
          },
          timeout: 30000 // 30 seconds
        }
      );

      const activities = response.data.activities || [];
      const nextCursor = response.data.pagination?.cursorTimestamp;

      return {
        activities,
        continuation: nextCursor
      };

    } catch (error: any) {
      const isTimeoutError = isTimeout(error);
      
      // Log error details including response body for debugging
      logger.error(`❌ Magic Eden V4 API Error (attempt ${retryCount + 1}/${maxRetries + 1}):`, {
        message: error.message,
        status: error.response?.status,
        statusText: error.response?.statusText,
        data: error.response?.data,
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
        return this.getActivitiesForCollection(collectionId, activityTypes, cursor, newLimit, retryCount + 1);
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
   * Get activities by type from the V4 API (both ENS contracts)
   * Fetches from both contracts and merges results, sorted by timestamp
   * 
   * @param activityTypes - Activity types to fetch (BID_CREATED, ASK_CREATED, TRADE, etc.)
   * @param cursors - Optional cursor timestamps for pagination (ISO 8601) - one per contract
   * @param limit - Number of activities to fetch per contract (default: 100)
   * @returns Activities from both contracts and next cursors
   */
  async getActivities(
    activityTypes: MagicEdenV4ActivityType[],
    cursors?: { contract1?: string; contract2?: string },
    limit: number = 100
  ): Promise<{ activities: MagicEdenV4Activity[]; continuation?: { contract1?: string; contract2?: string } }> {
    logger.info(`🔍 Fetching ENS activities from Magic Eden V4 API (both contracts)`);
    logger.info(`📊 Types: ${activityTypes.join(', ')}, Cursors: C1=${cursors?.contract1 || 'none'}, C2=${cursors?.contract2 || 'none'}, Limit: ${limit}`);

    try {
      // Fetch from both ENS contracts in parallel with SEPARATE cursors
      const [contract1Result, contract2Result] = await Promise.all([
        this.getActivitiesForCollection(this.ensContracts[0], activityTypes, cursors?.contract1, limit),
        this.getActivitiesForCollection(this.ensContracts[1], activityTypes, cursors?.contract2, limit)
      ]);

      // Merge activities from both contracts
      const allActivities = [...contract1Result.activities, ...contract2Result.activities];

      // Sort by timestamp (newest first) - API returns ISO strings
      allActivities.sort((a, b) => {
        const timeA = new Date(a.timestamp).getTime();
        const timeB = new Date(b.timestamp).getTime();
        return timeB - timeA; // Descending (newest first)
      });

      // Return SEPARATE cursors for each contract
      const continuation = (contract1Result.continuation || contract2Result.continuation) ? {
        contract1: contract1Result.continuation,
        contract2: contract2Result.continuation
      } : undefined;

      logger.info(`✅ Magic Eden V4 API: Retrieved ${allActivities.length} activities (${contract1Result.activities.length} + ${contract2Result.activities.length})`);
      
      if (continuation) {
        logger.debug(`📄 Next cursors: C1=${continuation.contract1 || 'done'}, C2=${continuation.contract2 || 'done'}`);
      }

      return {
        activities: allActivities,
        continuation
      };

    } catch (error: any) {
      logger.error(`❌ Failed to fetch activities from Magic Eden V4: ${error.message}`);
      return {
        activities: [],
        continuation: undefined
      };
    }
  }

  /**
   * Get active bids using the new /v4/bids endpoint
   * Direct endpoint for bids - simpler than activity-based approach
   * 
   * @param offset - Starting offset for pagination (default: 0)
   * @param limit - Number of bids to fetch (default: 50, max: 100)
   * @returns Bid data and pagination info
   */
  async getActiveBids(
    offset: number = 0,
    limit: number = 50
  ): Promise<{ bids: MagicEdenBid[]; nextOffset?: number }> {
    try {
      const params = new URLSearchParams();
      
      // Both ENS contracts in a single query
      this.ensContracts.forEach(contract => {
        params.append('collectionIds[]', `ethereum:${contract}`);
      });
      
      params.append('sortBy', 'createdAt');
      params.append('sortDir', 'desc');
      params.append('limit', Math.min(limit, 100).toString()); // API max is 100
      params.append('offset', offset.toString());
      
      const url = `${this.baseUrl}/bids?${params.toString()}`;
      
      logger.debug(`🔍 Fetching bids from: ${url}`);
      
      const response: AxiosResponse<MagicEdenV4BidsResponse> = await this.axiosInstance.get(url);
      
      const bidsData = response.data.data || [];
      const pagination = response.data.pagination;
      
      logger.info(`✅ Magic Eden V4 /bids API: Retrieved ${bidsData.length} bids (offset: ${offset})`);
      
      // Transform to internal format
      const transformedBids = bidsData
        .filter(item => item.bid.status === 'active') // Only active bids
        .map(item => this.transformV4BidToBid(item.bid));
      
      logger.debug(`   ${transformedBids.length} active bids after filtering`);
      
      // Calculate next offset for pagination (with 5-item overlap)
      const nextOffset = bidsData.length >= limit ? (offset + limit - 5) : undefined;
      
      return {
        bids: transformedBids,
        nextOffset
      };

    } catch (error: any) {
      logger.error('❌ Magic Eden V4 /bids API Error:', error.message);

      // Return empty result on error rather than throwing
      return {
        bids: [],
        nextOffset: undefined
      };
    }
  }

  /**
   * Get all new bids using offset-based pagination until we hit the boundary timestamp
   * Uses 5-item overlap between pages to handle concurrent bid creation
   * 
   * @param boundaryTimestamp - Unix timestamp in milliseconds
   * @returns Object with bids and the newest timestamp seen from API (for safe bookmark updates)
   */
  async getNewBidsSince(boundaryTimestamp: number): Promise<{ bids: MagicEdenBid[]; newestTimestampSeen: number | null }> {
    logger.info(`📈 Paginating for bids newer than: ${boundaryTimestamp} (${new Date(boundaryTimestamp).toISOString()})`);
    
    const startTime = Date.now();
    let currentOffset = 0;
    const allNewBids: MagicEdenBid[] = [];
    const seenBidIds = new Set<string>(); // Deduplicate overlapping bids
    let newestTimestampSeen: number | null = null; // Track newest timestamp from API
    let totalPages = 0;
    const maxPages = 20; // Safety limit (20 pages × 50 bids = 1000 bids max)
    let consecutiveEmptyPages = 0;
    const maxConsecutiveEmpty = 3; // Stop if 3 pages in a row have 0 new bids
    
    while (true) {
      totalPages++;
      const { bids, nextOffset } = await this.getActiveBids(currentOffset);
      
      if (bids.length === 0) break;
      
      // Filter bids to only those newer than our boundary AND with >15min validity remaining
      let tooOld = 0;
      let expiringSoon = 0;
      let duplicates = 0;
      
      const newBids = bids.filter(bid => {
        // Deduplicate (due to 5-item overlap)
        if (seenBidIds.has(bid.id)) {
          duplicates++;
          return false;
        }
        
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
      
      // Add new bids to collection and track their IDs
      newBids.forEach(bid => {
        seenBidIds.add(bid.id);
        allNewBids.push(bid);
      });
      
      if (tooOld > 0 || expiringSoon > 0 || duplicates > 0) {
        logger.debug(`🔍 Filtered: ${tooOld} too old, ${expiringSoon} expiring soon, ${duplicates} duplicates`);
      }
      
      logger.debug(`📄 Page ${totalPages}/${maxPages} (offset ${currentOffset}): ${bids.length} total, ${newBids.length} new, ${allNewBids.length} collected`);
      
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
      if (bids.length > 0) {
        const oldestInBatch = Math.min(...bids.map(bid => new Date(bid.createdAt).getTime()));
        const boundaryDate = new Date(boundaryTimestamp).toISOString();
        const oldestDate = new Date(oldestInBatch).toISOString();
        
        logger.debug(`🕒 Oldest bid in batch: ${oldestDate}, Boundary: ${boundaryDate}`);
        
        if (oldestInBatch <= boundaryTimestamp) {
          logger.info(`🎯 Hit boundary timestamp, stopping pagination`);
          break;
        }
      }
      
      // Check if there are more pages
      if (!nextOffset) {
        logger.info(`📭 No more pages available (reached end of data)`);
        break;
      }
      
      // Safety limit to prevent runaway pagination
      if (totalPages >= maxPages) {
        logger.warn(`⚠️  Hit max pages limit (${maxPages}), stopping pagination`);
        break;
      }
      
      currentOffset = nextOffset;
      
      // Rate limiting: 1 call per second
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    
    const totalTime = ((Date.now() - startTime) / 1000).toFixed(1);
    logger.info(`✅ Paginated ${totalPages} pages in ${totalTime}s, found ${allNewBids.length} new bids`);
    
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
   * Transform V4 /bids endpoint response to internal MagicEdenBid format
   * NOTE: This endpoint doesn't provide ENS name/image - they'll be looked up via fallback
   * 
   * @param v4Bid - Bid from /v4/bids endpoint
   * @returns Internal MagicEdenBid format
   */
  private transformV4BidToBid(v4Bid: MagicEdenV4Bid): MagicEdenBid {
    // Parse timestamps - V4 uses ISO strings, we need Unix timestamps (seconds)
    const validFrom = Math.floor(new Date(v4Bid.expiry.validFrom).getTime() / 1000);
    const validUntil = Math.floor(new Date(v4Bid.expiry.validUntil).getTime() / 1000);
    
    // Extract marketplace fee (sum of all fees)
    const totalFeeBps = 
      v4Bid.maxFees.royaltyBp +
      v4Bid.maxFees.makerMarketplaceBp +
      v4Bid.maxFees.takerMarketplaceBp +
      v4Bid.maxFees.lpFeeBp;

    // Extract token ID from assetId (format: "contract:tokenId")
    const tokenId = v4Bid.criteria.assetId.split(':')[1] || v4Bid.criteria.assetId;

    return {
      id: v4Bid.id,
      kind: v4Bid.kind,
      side: 'buy', // Bids are always buy side
      status: v4Bid.status,
      tokenSetId: v4Bid.criteria.assetId, // Use assetId as tokenSetId for compatibility
      tokenSetSchemaHash: '', // Not provided in V4, not critical
      contract: v4Bid.contract,
      maker: v4Bid.maker,
      taker: '0x0000000000000000000000000000000000000000', // Not provided in V4, use zero address
      
      price: {
        currency: {
          contract: v4Bid.priceV2.currency.contract,
          name: v4Bid.priceV2.currency.displayName,
          symbol: v4Bid.priceV2.currency.symbol,
          decimals: v4Bid.priceV2.currency.decimals,
        },
        amount: {
          raw: v4Bid.priceV2.amount.raw,
          decimal: parseFloat(v4Bid.priceV2.amount.native),
          usd: parseFloat(v4Bid.priceV2.amount.fiat?.usd || '0'),
          native: parseFloat(v4Bid.priceV2.amount.native),
        },
      },
      
      validFrom: validFrom,
      validUntil: validUntil,
      quantityFilled: v4Bid.quantity.filled,
      quantityRemaining: v4Bid.quantity.remaining,
      
      // ⚠️ Note: /v4/bids endpoint doesn't provide ENS name/image
      // These will be undefined and looked up via enrichBidWithMetadata() fallback
      criteria: {
        kind: 'token',
        data: {
          token: {
            tokenId: tokenId,
            name: undefined, // Not provided by /v4/bids - will be looked up
            image: undefined, // Not provided by /v4/bids - will be looked up
          },
        },
      },
      
      source: {
        id: v4Bid.source.toLowerCase(),
        domain: `${v4Bid.source.toLowerCase()}.io`, // Approximate domain
        name: v4Bid.source,
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
      isReservoir: v4Bid.source === 'RESERVOIR', // V4 is powered by Reservoir
      createdAt: v4Bid.createdAt,
      updatedAt: v4Bid.updatedAt,
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
   * 
   * @deprecated This is now only used by old activity-based methods
   */
  private transformV4ActivityToBid(activity: MagicEdenV4Activity): MagicEdenBid {
    // This method should only be called for BID_CREATED activities
    if (!activity.bid) {
      throw new Error('transformV4ActivityToBid called on non-bid activity');
    }
    
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
   * Get token activity (single page) - primitive method
   * NOTE: API can timeout even with limit=10, so we use retry + scale-back logic
   * 
   * @param contract - Contract address
   * @param tokenId - Token ID
   * @param cursor - Cursor timestamp for pagination
   * @param limit - Number of activities (default: 10, API can timeout with higher values)
   * @param types - Activity types to filter (server-side filtering)
   * @param retryCount - Current retry attempt (internal)
   * @returns Activities and next cursor
   */
  private async getTokenActivityPage(
    contract: string,
    tokenId: string,
    cursor?: string,
    limit: number = 10,
    types?: MagicEdenV4ActivityType[],
    retryCount: number = 0
  ): Promise<{ activities: MagicEdenV4Activity[]; continuation?: string }> {
    const maxRetries = 3;
    const isTimeout = (error: any) => 
      error.code === 'ECONNABORTED' || 
      error.message?.includes('timeout');
    
    try {
      const assetId = `${contract.toLowerCase()}:${tokenId}`;
      
      logger.debug(`🔍 Fetching token activity from V4 API: ${assetId}`);
      logger.debug(`   Cursor: ${cursor || 'none'}, Limit: ${limit}, Types: ${types?.join(',') || 'all'}`);

      // Build URL with array parameters for activityTypes (server-side filtering)
      // Magic Eden expects: activityTypes[]=TRADE&activityTypes[]=MINT
      const params = new URLSearchParams({
        chain: 'ethereum',
        assetId: assetId,
        limit: limit.toString(),
        sortBy: 'timestamp',
        sortDir: 'desc'
      });

      if (cursor) {
        params.append('cursorTimestamp', cursor);
      }

      // Add activity types as array parameters for server-side filtering
      if (types && types.length > 0) {
        types.forEach(type => params.append('activityTypes[]', type));
      }

      const response: AxiosResponse<MagicEdenV4ActivityResponse> = await this.axiosInstance.get(
        `/activity/nft?${params.toString()}`,
        {
          headers: {
            'Accept': '*/*',
            'User-Agent': 'ENS-TwitterBot/2.0'
          },
          timeout: 30000 // 30s timeout
        }
      );

      const activities = response.data.activities || [];
      const nextCursor = response.data.pagination?.cursorTimestamp;
      
      logger.debug(`✅ Retrieved ${activities.length} token activities`);
      
      // Log activity types for debugging
      if (activities.length > 0) {
        const activityTypes = activities.map(a => a.activityType).join(', ');
        logger.debug(`   Activity types: ${activityTypes}`);
      }
      
      if (nextCursor) {
        logger.debug(`   Next cursor: ${nextCursor}`);
      }

      return {
        activities,
        continuation: nextCursor
      };

    } catch (error: any) {
      const isTimeoutError = isTimeout(error);
      
      logger.error(`❌ Magic Eden V4 Token Activity Error (attempt ${retryCount + 1}/${maxRetries + 1}):`, {
        message: error.message,
        status: error.response?.status,
        code: error.code,
        isTimeout: isTimeoutError,
        contract: contract.slice(0, 10) + '...',
        tokenId: tokenId.slice(0, 20) + '...'
      });

      if (retryCount < maxRetries) {
        const waitTime = Math.min(1000 * Math.pow(2, retryCount), 5000); // Exponential backoff
        
        // Scale back limit on timeout
        let newLimit = limit;
        if (isTimeoutError && retryCount === 0 && limit > 5) {
          newLimit = 5; // Reduce to 5 on first timeout
          logger.warn(`⚠️  Timeout detected, reducing limit from ${limit} to ${newLimit} and retrying...`);
        } else {
          logger.warn(`⚠️  Retrying in ${waitTime}ms...`);
        }
        
        await new Promise(resolve => setTimeout(resolve, waitTime));
        
        return this.getTokenActivityPage(contract, tokenId, cursor, newLimit, types, retryCount + 1);
      }

      logger.error(`❌ Max retries (${maxRetries}) exceeded for token activity`);
      return {
        activities: [],
        continuation: undefined
      };
    }
  }

  /**
   * Get token activity history with automatic pagination (matches V3 API)
   * 
   * @param contract - Contract address
   * @param tokenId - Token ID
   * @param options - Configuration options
   * @returns All activities up to maxPages, with metadata
   */
  async getTokenActivityHistory(
    contract: string,
    tokenId: string,
    options: {
      limit?: number;  // Items per request (default: 100, API updated to support higher limits)
      types?: MagicEdenV4ActivityType[];  // Activity types to filter
      maxPages?: number;  // Maximum pages to fetch (default: 25)
    } = {}
  ): Promise<{ activities: MagicEdenV4Activity[]; incomplete: boolean; pagesFetched: number }> {
    // Set defaults
    const limit = options.limit || 100;  // API now supports 100 items per page
    const types = options.types || ['TRADE', 'MINT', 'TRANSFER'];  // Match V3 default: sale, mint, transfer
    const maxPages = options.maxPages || 25;  // 25 pages * 100 items = 2500 items max

    logger.info(`📚 Fetching token activity history for ${contract}:${tokenId} (V4 API)`);
    logger.debug(`   Settings: limit=${limit}, types=[${types.join(',')}], maxPages=${maxPages}`);

    const allActivities: MagicEdenV4Activity[] = [];
    let continuation: string | undefined;
    let pageCount = 0;
    let incomplete = false;

    try {
      // Loop through pages until we hit maxPages or run out of data
      while (pageCount < maxPages) {
        pageCount++;
        
        // Fetch single page with server-side filtering
        const response = await this.getTokenActivityPage(
          contract,
          tokenId,
          continuation,
          limit,
          types  // Server-side filtering by activity types
        );

        // Break if no activities returned
        if (!response.activities || response.activities.length === 0) {
          logger.debug(`   Page ${pageCount}: No more activities, stopping pagination`);
          break;
        }

        // Activities are already filtered by API, no need for local filtering
        allActivities.push(...response.activities);
        logger.debug(`   Page ${pageCount}: Fetched ${response.activities.length} activities (total: ${allActivities.length})`);

        // Check for continuation cursor
        continuation = response.continuation;
        if (!continuation) {
          logger.debug(`   Page ${pageCount}: No continuation cursor, reached end of data`);
          break;
        }

        // Rate limiting between requests (1000-1100ms randomized delay)
        if (continuation) {
          const delay = 1000 + Math.random() * 100;
          await new Promise(resolve => setTimeout(resolve, delay));
        }
      }

      // Check if we hit maxPages limit (incomplete data)
      if (pageCount >= maxPages && continuation) {
        logger.warn(`   ⚠️  Hit maxPages limit (${maxPages}), more data may be available`);
        incomplete = true;
      }

      logger.info(`✅ Token activity history complete: ${allActivities.length} activities from ${pageCount} pages${incomplete ? ' (incomplete)' : ''}`);

      return {
        activities: allActivities,
        incomplete,
        pagesFetched: pageCount
      };

    } catch (error: any) {
      logger.error(`❌ Failed to fetch token activity history: ${error.message}`);
      
      // Return partial results if we got any
      return {
        activities: allActivities,
        incomplete: true,  // Mark as incomplete on error
        pagesFetched: pageCount
      };
    }
  }

  /**
   * Get user activity history with automatic pagination (matches V3 API)
   * 
   * @param address - Ethereum address
   * @param options - Configuration options
   * @returns All activities up to maxPages, with metadata
   */
  async getUserActivityHistory(
    address: string,
    options: {
      limit?: number;  // Items per request (default: 100, API updated to support higher limits)
      types?: MagicEdenV4ActivityType[];  // Activity types to filter
      maxPages?: number;  // Maximum pages to fetch (default: 25)
    } = {}
  ): Promise<{ activities: MagicEdenV4Activity[]; incomplete: boolean; pagesFetched: number }> {
    // Set defaults
    const limit = options.limit || 100;  // API now supports 100 items per page
    const types = options.types || ['TRADE', 'TRANSFER'];  // Default to sales and transfers
    const maxPages = options.maxPages || 25;  // 25 pages * 100 items = 2500 items max

    logger.info(`👤 Fetching user activity history for ${address} (V4 API)`);
    logger.debug(`   Settings: limit=${limit}, types=[${types.join(',')}], maxPages=${maxPages}`);

    const allActivities: MagicEdenV4Activity[] = [];
    let continuation: string | undefined;
    let pageCount = 0;
    let incomplete = false;

    try {
      // Loop through pages until we hit maxPages or run out of data
      while (pageCount < maxPages) {
        pageCount++;
        
        // Fetch single page using primitive method
        const response = await this.getUserActivityPage(
          address,
          types,
          continuation,
          limit
        );

        // Break if no activities returned
        if (!response.activities || response.activities.length === 0) {
          logger.debug(`   Page ${pageCount}: No more activities, stopping pagination`);
          break;
        }

        // Add activities to aggregated array
        allActivities.push(...response.activities);
        logger.debug(`   Page ${pageCount}: Fetched ${response.activities.length} ENS activities (total: ${allActivities.length})`);

        // Check for continuation cursor
        continuation = response.continuation;
        if (!continuation) {
          logger.debug(`   Page ${pageCount}: No continuation cursor, reached end of data`);
          break;
        }

        // Rate limiting between requests (1000-1100ms randomized delay)
        if (continuation) {
          const delay = 1000 + Math.random() * 100;
          await new Promise(resolve => setTimeout(resolve, delay));
        }
      }

      // Check if we hit maxPages limit (incomplete data)
      if (pageCount >= maxPages && continuation) {
        logger.warn(`   ⚠️  Hit maxPages limit (${maxPages}), more data may be available`);
        incomplete = true;
      }

      logger.info(`✅ User activity history complete: ${allActivities.length} activities from ${pageCount} pages${incomplete ? ' (incomplete)' : ''}`);

      return {
        activities: allActivities,
        incomplete,
        pagesFetched: pageCount
      };

    } catch (error: any) {
      logger.error(`❌ Failed to fetch user activity history: ${error.message}`);
      
      // Return partial results if we got any
      return {
        activities: allActivities,
        incomplete: true,  // Mark as incomplete on error
        pagesFetched: pageCount
      };
    }
  }

  /**
   * Get single page of user activity from V4 API with ENS contract filtering (primitive method)
   * Note: limit parameter doesn't work yet (API always returns 20), will be fixed in 1 week
   * 
   * @param walletAddress - Ethereum address (without chain prefix)
   * @param activityTypes - Activity types to fetch (optional, defaults to all)
   * @param cursor - Cursor timestamp for pagination (ISO 8601)
   * @param limit - Requested limit (note: API currently ignores this and returns 20)
   * @param retryCount - Current retry attempt (internal use only)
   * @returns Filtered ENS activities and next cursor
   */
  private async getUserActivityPage(
    walletAddress: string,
    activityTypes?: MagicEdenV4ActivityType[],
    cursor?: string,
    limit: number = 20,
    retryCount: number = 0
  ): Promise<{ activities: MagicEdenV4Activity[]; continuation?: string }> {
    const maxRetries = 3;
    const isTimeout = (error: any) => 
      error.code === 'ECONNABORTED' || 
      error.message?.includes('timeout');
    
    try {
      // Format wallet address with chain prefix
      const formattedAddress = `ethereum:${walletAddress.toLowerCase()}`;
      
      logger.info(`🔍 Fetching user activity from Magic Eden V4 API`);
      logger.info(`👤 Wallet: ${walletAddress}, Types: ${activityTypes?.join(',') || 'all'}, Cursor: ${cursor || 'none'}, Limit: ${limit}`);

      // Build URL with array parameters (server-side filtering)
      // Magic Eden expects: activityTypes[]=TRADE&activityTypes[]=TRANSFER
      const params = new URLSearchParams({
        walletAddress: formattedAddress,
        sortBy: 'timestamp',
        sortDir: 'desc',
        limit: limit.toString()
      });

      // Add activity types as array parameters
      if (activityTypes && activityTypes.length > 0) {
        activityTypes.forEach(type => params.append('activityTypes[]', type));
      }

      // Add cursor for pagination if provided
      if (cursor) {
        params.append('cursorTimestamp', cursor);
      }

      const response: AxiosResponse<MagicEdenV4ActivityResponse> = await this.axiosInstance.get(
        `/activity/user?${params.toString()}`,
        {
          headers: {
            'Accept': '*/*',
            'User-Agent': 'ENS-TwitterBot/2.0'
          },
          timeout: 30000 // 30 seconds
        }
      );

      const allActivities = response.data.activities || [];
      const nextCursor = response.data.pagination?.cursorTimestamp;
      
      // Filter to only ENS contracts (local filtering until API adds this feature)
      const ensActivities = allActivities.filter(activity => {
        const contractAddress = activity.asset?.contractAddress?.toLowerCase();
        return this.ensContracts.includes(contractAddress || '');
      });
      
      logger.info(`✅ Magic Eden V4 API: Retrieved ${allActivities.length} activities, ${ensActivities.length} ENS activities`);
      
      if (nextCursor) {
        logger.debug(`📄 Next cursor: ${nextCursor}`);
      }

      return {
        activities: ensActivities,
        continuation: nextCursor
      };

    } catch (error: any) {
      const isTimeoutError = isTimeout(error);
      
      // Log error details
      logger.error(`❌ Magic Eden V4 User Activity Error (attempt ${retryCount + 1}/${maxRetries + 1}):`, {
        message: error.message,
        status: error.response?.status,
        code: error.code,
        isTimeout: isTimeoutError
      });

      // Retry logic
      if (retryCount < maxRetries) {
        const waitTime = Math.min(1000 * Math.pow(2, retryCount), 5000); // Exponential backoff, max 5s
        
        // If timeout and first retry, reduce limit (though it doesn't work yet)
        let newLimit = limit;
        if (isTimeoutError && retryCount === 0 && limit > 10) {
          newLimit = 10;
          logger.warn(`⚠️  Timeout detected, reducing limit from ${limit} to ${newLimit} and retrying...`);
        } else {
          logger.warn(`⚠️  Retrying in ${waitTime}ms...`);
        }
        
        await new Promise(resolve => setTimeout(resolve, waitTime));
        
        // Recursive retry with potentially reduced limit
        return this.getUserActivityPage(walletAddress, activityTypes, cursor, newLimit, retryCount + 1);
      }

      // Max retries exceeded - return empty result
      logger.error(`❌ Max retries (${maxRetries}) exceeded for Magic Eden V4 User Activity API`);
      return {
        activities: [],
        continuation: undefined
      };
    }
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
   * @param cursors - Optional cursors for pagination
   * @param limit - Number of sales to fetch
   * @returns Trade activities and next cursors
   */
  async getRecentSales(
    cursors?: { contract1?: string; contract2?: string },
    limit: number = 100
  ): Promise<{ activities: MagicEdenV4Activity[]; continuation?: { contract1?: string; contract2?: string } }> {
    logger.info(`📊 Fetching recent ENS sales from V4 API`);
    return this.getActivities(['TRADE'], cursors, limit);
  }

  /**
   * Get active listings (ASK_CREATED activities)
   * Useful for showing what's available for sale
   * 
   * @param cursors - Optional cursors for pagination
   * @param limit - Number of listings to fetch
   * @returns Ask activities and next cursors
   */
  async getActiveListings(
    cursors?: { contract1?: string; contract2?: string },
    limit: number = 100
  ): Promise<{ activities: MagicEdenV4Activity[]; continuation?: { contract1?: string; contract2?: string } }> {
    logger.info(`📋 Fetching active ENS listings from V4 API`);
    return this.getActivities(['ASK_CREATED'], cursors, limit);
  }

  /**
   * Get complete token activity history (all types)
   * Useful for comprehensive market analysis
   * 
   * @param cursors - Optional cursors for pagination
   * @param limit - Number of activities to fetch
   * @returns All activities and next cursors
   */
  async getAllActivities(
    cursors?: { contract1?: string; contract2?: string },
    limit: number = 100
  ): Promise<{ activities: MagicEdenV4Activity[]; continuation?: { contract1?: string; contract2?: string } }> {
    logger.info(`📈 Fetching all ENS activities from V4 API`);
    return this.getActivities(
      ['ASK_CREATED', 'ASK_CANCELLED', 'BID_CREATED', 'BID_CANCELLED', 'BURN', 'MINT', 'TRANSFER', 'TRADE'],
      cursors,
      limit
    );
  }

  /**
   * Get bid cancellations
   * Useful for tracking expired/cancelled bids
   * 
   * @param cursors - Optional cursors for pagination
   * @param limit - Number of cancellations to fetch
   * @returns Bid cancellation activities
   */
  async getBidCancellations(
    cursors?: { contract1?: string; contract2?: string },
    limit: number = 100
  ): Promise<{ activities: MagicEdenV4Activity[]; continuation?: { contract1?: string; contract2?: string } }> {
    logger.info(`❌ Fetching bid cancellations from V4 API`);
    return this.getActivities(['BID_CANCELLED'], cursors, limit);
  }

  /**
   * Get active asks (listings) for a specific asset
   * Uses the /v4/asks endpoint which only returns active, valid listings
   * No validation needed - API filters out expired/cancelled listings
   * 
   * @param contract - Contract address
   * @param tokenId - Token ID
   * @returns Active asks sorted by USD value (lowest first)
   */
  async getActiveAsks(
    contract: string,
    tokenId: string
  ): Promise<MagicEdenV4Ask[]> {
    try {
      const assetId = `${contract.toLowerCase()}:${tokenId}`;
      
      logger.info(`🔍 Fetching active asks for ${assetId} from V4 API`);

      // Build URL with array parameters for assetIds
      const params = new URLSearchParams({
        chain: 'ethereum',
        sortDir: 'asc' // Sort by price ascending (native currency)
      });
      
      params.append('assetIds[]', assetId);

      const response: AxiosResponse<MagicEdenV4AsksResponse> = await this.axiosInstance.get(
        `/asks?${params.toString()}`,
        {
          headers: {
            'Accept': '*/*',
            'User-Agent': 'ENS-TwitterBot/2.0'
          },
          timeout: 10000 // 10s timeout
        }
      );

      const asks = response.data.asks || [];
      
      logger.info(`✅ Found ${asks.length} active asks for ${assetId}`);
      
      if (asks.length === 0) {
        return [];
      }

      // Sort by USD value (lowest first) in case API sorting isn't by USD
      const sortedAsks = asks.sort((a, b) => {
        const usdA = parseFloat(a.priceV2.amount.fiat?.usd || '0');
        const usdB = parseFloat(b.priceV2.amount.fiat?.usd || '0');
        return usdA - usdB;
      });

      const lowestAsk = sortedAsks[0];
      const usdValue = lowestAsk.priceV2.amount.fiat?.usd || '0';
      logger.debug(`   Lowest USD ask: $${usdValue} (${lowestAsk.priceV2.amount.native} ${lowestAsk.priceV2.currency.symbol})`);

      return sortedAsks;

    } catch (error: any) {
      logger.error(`❌ Error fetching active asks: ${error.message}`);
      return [];
    }
  }

  /**
   * Get last sale or registration (mint) for historical context
   * Fetches token activity and finds most recent sale/mint above threshold
   * 
   * @param contract - Contract address
   * @param tokenId - Token ID
   * @param currentTxHash - Current transaction hash to exclude
   * @param thresholdEth - Minimum ETH equivalent price to show (default: 0.01)
   * @returns Historical event or null
   */
  async getLastSaleOrRegistration(
    contract: string,
    tokenId: string,
    currentTxHash?: string,
    thresholdEth: number = 0.01
  ): Promise<{ type: 'sale' | 'mint'; priceEth: string; priceUsd: string; timestamp: number; daysAgo: number; currencySymbol: string; currencyContract: string; priceDecimal: number } | null> {
    try {
      logger.info(`🔍 Fetching historical sales for ${contract}:${tokenId} (V4 API)`);
      
      // Fetch token activity (TRADE and MINT only)
      const result = await this.getTokenActivityHistory(
        contract,
        tokenId,
        { limit: 100, types: ['TRADE', 'MINT'], maxPages: 10 } // Limit to 10 pages for performance
      );
      
      const activities = this.transformV4ToV3Activities(result.activities);
      
      logger.debug(`   Retrieved ${activities.length} trade/mint activities`);
      
      // Find first sale or mint that meets threshold and isn't current transaction
      for (const activity of activities) {
        // Skip if this is the current transaction
        if (currentTxHash && activity.txHash.toLowerCase() === currentTxHash.toLowerCase()) {
          logger.debug(`   ⏭️  Skipping current transaction: ${activity.txHash}`);
          continue;
        }
        
        // Check if activity has valid price
        if (!activity.price?.amount?.decimal || activity.price.amount.decimal <= 0) {
          continue;
        }
        
        const priceDecimal = activity.price.amount.decimal;
        const currencyContract = activity.price.currency.contract;
        const currencySymbol = activity.price.currency.symbol;
        
        // For threshold comparison, use ETH equivalent for non-ETH currencies
        const isEth = currencyContract === '0x0000000000000000000000000000000000000000' || 
                      currencyContract === '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2'; // ETH or WETH
        const thresholdPrice = isEth ? priceDecimal : (activity.price.amount.native || 0);
        
        // Check if meets threshold
        if (thresholdPrice >= thresholdEth) {
          const daysAgo = Math.floor((Date.now() / 1000 - activity.timestamp) / 86400);
          const type = activity.type === 'mint' ? 'mint' : 'sale';
          
          logger.info(`   📈 Found historical ${type}: ${priceDecimal} ${currencySymbol}, ${daysAgo} days ago`);
          
          return {
            type,
            priceEth: priceDecimal.toFixed(2),
            priceUsd: activity.price.amount.usd?.toFixed(2) || '',
            timestamp: activity.timestamp,
            daysAgo,
            currencySymbol,
            currencyContract: currencyContract || '',
            priceDecimal
          };
        } else {
          logger.debug(`   🔽 Historical event below threshold: ${thresholdPrice} ETH-equivalent < ${thresholdEth} ETH`);
          return null; // Hard cutoff - don't look for older events
        }
      }
      
      logger.debug(`   📭 No historical data found meeting threshold`);
      return null;
      
    } catch (error: any) {
      logger.warn(`   ⚠️  Error getting historical data: ${error.message}`);
      return null;
    }
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
      await this.getActiveBids(0, 1);
      return true;
    } catch (error) {
      logger.error('❌ Magic Eden V4 API health check failed:', error);
      return false;
    }
  }

  /**
   * Transform V4 activity to V3 TokenActivity format
   * Allows V4 data to work with existing processing logic
   * 
   * @param v4Activity - Activity from V4 API
   * @returns V3-compatible TokenActivity
   */
  transformV4ToV3Activity(v4Activity: MagicEdenV4Activity): TokenActivity {
    // Map V4 activity types to V3 types
    const typeMap: Record<string, string> = {
      'TRADE': 'sale',
      'MINT': 'mint',
      'TRANSFER': 'transfer',
      'ASK_CREATED': 'ask',
      'BID_CREATED': 'bid',
      'ASK_CANCELLED': 'ask_cancel',
      'BID_CANCELLED': 'bid_cancel',
      'BURN': 'transfer' // Map burn to transfer for compatibility
    };

    const v3Type = typeMap[v4Activity.activityType] || 'transfer';
    
    // Extract price data (TRADE and MINT activities have unitPrice, others default to 0)
    const hasPrice = !!v4Activity.unitPrice;
    const priceRaw = v4Activity.unitPrice?.amount.raw || '0';
    const priceDecimal = v4Activity.unitPrice ? parseFloat(v4Activity.unitPrice.amount.native) : 0;
    const currencyContract = v4Activity.unitPrice?.currency.contract || '0x0000000000000000000000000000000000000000';
    const currencySymbol = v4Activity.unitPrice?.currency.symbol || 'ETH';
    const currencyDecimals = v4Activity.unitPrice?.currency.decimals || 18;
    
    // Fix USD conversion for stablecoins (USDC, USDT, DAI)
    let priceUsd = 0;
    if (v4Activity.unitPrice) {
      const isStablecoin = ['USDC', 'USDT', 'DAI'].includes(currencySymbol);
      if (isStablecoin) {
        // For stablecoins, the native value IS the USD value (1 USDC = $1)
        priceUsd = priceDecimal;
      } else {
        // For ETH/WETH, use the V4 API's USD conversion
        priceUsd = parseFloat(v4Activity.unitPrice.amount.fiat?.usd || '0');
      }
    }

    // Convert ISO timestamp to Unix timestamp
    const timestamp = Math.floor(new Date(v4Activity.timestamp).getTime() / 1000);
    
    // Debug logging for TRADE activities
    if (v4Activity.activityType === 'TRADE' || v4Activity.activityType === 'MINT') {
      logger.debug(`   🔄 Transforming ${v4Activity.activityType}: ${v4Activity.asset.name}, price: ${priceDecimal} ${currencySymbol} ($${priceUsd})`);
    }

    return {
      type: v3Type as any,
      fromAddress: v4Activity.fromAddress || '0x0000000000000000000000000000000000000000',
      toAddress: v4Activity.toAddress || '0x0000000000000000000000000000000000000000',
      price: {
        currency: {
          contract: currencyContract,
          name: hasPrice ? v4Activity.unitPrice!.currency.displayName : 'Ether',
          symbol: currencySymbol,
          decimals: currencyDecimals
        },
        amount: {
          raw: priceRaw,
          decimal: priceDecimal,
          usd: priceUsd,
          native: priceDecimal // For V3 compatibility
        }
      },
      amount: parseInt(v4Activity.assetAmount || '1', 10),
      timestamp: timestamp,
      createdAt: v4Activity.timestamp,
      contract: v4Activity.asset.contractAddress,
      token: {
        tokenId: v4Activity.asset.tokenId,
        isSpam: false,
        isNsfw: false,
        tokenName: v4Activity.asset.name,
        tokenImage: v4Activity.asset.mediaV2?.main?.uri || null,
        rarityScore: null,
        rarityRank: null
      },
      collection: {
        collectionId: v4Activity.collection.id,
        isSpam: false,
        isNsfw: false,
        collectionName: v4Activity.collection.name,
        collectionImage: '' // V4 doesn't provide collection images in activity
      },
      txHash: v4Activity.transactionInfo?.transactionId || '',
      logIndex: v4Activity.transactionInfo?.logIndex || 0,
      batchIndex: v4Activity.transactionInfo?.batchTransferIndex || 1,
      fillSource: v4Activity.fillSource ? {
        domain: v4Activity.fillSource.domain,
        name: v4Activity.fillSource.domain,
        icon: ''
      } : undefined,
      comment: null
    };
  }

  /**
   * Transform V4 activities to V3 format (batch)
   * 
   * @param v4Activities - Array of V4 activities
   * @returns Array of V3-compatible TokenActivities
   */
  transformV4ToV3Activities(v4Activities: MagicEdenV4Activity[]): TokenActivity[] {
    return v4Activities.map(activity => this.transformV4ToV3Activity(activity));
  }
}

