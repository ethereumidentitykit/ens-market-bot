import axios, { AxiosResponse, AxiosInstance } from 'axios';
import { logger } from '../utils/logger';
import { MagicEdenBidResponse, MagicEdenBid, BidProcessingStats } from '../types';
import { APIToggleService } from './apiToggleService';
import { CurrencyUtils } from '../utils/currencyUtils';

// Token Activity Interfaces
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

export interface HistoricalEvent {
  type: 'sale' | 'mint';
  priceEth: string; // For backwards compatibility - now represents price in native currency
  priceUsd: string;
  timestamp: number;
  daysAgo: number;
  // New currency fields
  currencySymbol: string; // USDC, ETH, USDT, etc.
  currencyContract?: string; // Contract address (empty for native ETH)
  priceDecimal: number; // Raw decimal amount
}

export interface ListingPrice {
  priceEth: string; // For backwards compatibility - now represents price in native currency
  priceUsd?: string;
  timestamp: number;
  // New currency fields
  currencySymbol: string; // USDC, ETH, USDT, etc.
  currencyContract?: string; // Contract address (empty for native ETH)
  priceDecimal: number; // Raw decimal amount
}

export interface ContextualData {
  historical?: HistoricalEvent;
  listing?: ListingPrice;
}

/**
 * Magic Eden API Service
 * Handles fetching ENS bid data and token activity from Magic Eden's API
 */
export class MagicEdenService {
  private readonly baseUrl: string;
  private readonly ensContracts: string[];
  private readonly axiosInstance: AxiosInstance;
  private readonly apiToggleService: APIToggleService;
  
  // Configurable thresholds
  private readonly historicalThresholdEth: number = 0.1; // Only show historical data if >= 0.1 ETH
  // Note: Bid proximity threshold removed - now always show listing price if available
  
  constructor() {
    this.baseUrl = 'https://api-mainnet.magiceden.dev/v3/rtp/ethereum';
    this.apiToggleService = APIToggleService.getInstance();
    
    // ENS Contract Addresses (lowercase for consistent matching)
    this.ensContracts = [
      '0xd4416b13d2b3a9abae7acd5d6c2bbdbe25686401', // ENS Names (new)
      '0x57f1887a8bf19b14fc0df6fd9b2acc9af147ea85'  // ENS Base Registrar (old)
    ];
    
    // Create axios instance with interceptor for API toggle protection
    this.axiosInstance = axios.create({
      baseURL: this.baseUrl
    });
    
    // Intercept ALL Magic Eden API requests automatically  
    this.axiosInstance.interceptors.request.use((config) => {
      if (!this.apiToggleService.isMagicEdenEnabled()) {
        logger.warn('Magic Eden API call blocked - API disabled via admin toggle');
        throw new Error('Magic Eden API disabled via admin toggle');
      }
      return config;
    });
  }

  /**
   * Clean ENS name by removing any data after .eth and normalizing emoji
   * Magic Eden may provide non-normalized names with warnings and FE0F selectors
   * Follows ENSIP-15 normalization: strips FE0F variation selectors from emoji
   */
  private cleanEnsName(ensName: string): string {
    if (!ensName) return ensName;
    
    // Step 1: Remove content after .eth (warning labels)
    const ethIndex = ensName.toLowerCase().indexOf('.eth');
    let cleanName = ethIndex !== -1 ? ensName.substring(0, ethIndex + 4) : ensName;
    
    // Step 2: Apply ENSIP-15 emoji normalization - strip FE0F variation selectors
    // These are not part of normalized ENS names according to ENS protocol
    cleanName = cleanName.replace(/\uFE0F/g, '');
    
    return cleanName;
  }

  /**
   * Get active bids using cursor-based pagination
   * Always fetches newest first - doesn't rely on API filtering
   */
  async getActiveBids(
    cursor?: string,
    limit: number = 100
  ): Promise<{ bids: MagicEdenBid[]; continuation?: string }> {
    try {
      logger.info(`🔍 Fetching ENS bids from Magic Eden API`);
      logger.info(`📊 Cursor: ${cursor || 'none'}, limit: ${limit}`);

      const params: any = {
        contracts: this.ensContracts,
        status: 'active',
        includeCriteriaMetadata: true, // Enable metadata to get ENS names and images
        includeRawData: false,
        includeDepth: false,
        excludeEOA: false,
        normalizeRoyalties: false,
        sortBy: 'createdAt',
        limit
      };

      // Add cursor for pagination if provided
      if (cursor) {
        params.continuation = cursor;
      }

      const response: AxiosResponse<MagicEdenBidResponse> = await this.axiosInstance.get(
        '/orders/bids/v6',
        {
          params,
          headers: {
            'Authorization': 'Bearer YOUR_API_KEY', // Magic Eden API key
            'Accept': '*/*',
            'User-Agent': 'ENS-TwitterBot/1.0'
          }
        }
      );

      const orders = response.data.orders || [];
      const continuation = response.data.continuation;
      
      logger.info(`✅ Magic Eden API: Retrieved ${orders.length} bids`);
      
      // Filter ENS-specific bids (API should pre-filter by contracts, but double-check)
      const ensBids = orders.filter(bid => {
        const contractLower = bid.contract.toLowerCase();
        return this.ensContracts.includes(contractLower);
      });

      logger.info(`🎯 ENS-specific bids: ${ensBids.length}/${orders.length}`);
      if (continuation) {
        logger.debug(`📄 Continuation cursor available for next page`);
      }

      return {
        bids: ensBids,
        continuation
      };

    } catch (error: any) {
      logger.error('❌ Magic Eden API Error:', {
        message: error.message,
        status: error.response?.status,
        data: error.response?.data
      });

      // Return empty result on error rather than throwing
      return {
        bids: [],
        continuation: undefined
      };
    }
  }

  /**
   * Get all new bids by cursoring until we hit the boundary timestamp
   * Robust approach that doesn't rely on API timestamp filtering
   */
  async getNewBidsSince(boundaryTimestamp: number): Promise<MagicEdenBid[]> {
    logger.info(`📈 Cursoring for bids newer than: ${boundaryTimestamp} (${new Date(boundaryTimestamp).toISOString()})`);
    
    const startTime = Date.now();
    let cursor: string | undefined;
    let allNewBids: MagicEdenBid[] = [];
    let totalPages = 0;
    const maxPages = 10; // Increased limit for better coverage (1000 bids max)
    
    do {
      totalPages++;
      const { bids, continuation } = await this.getActiveBids(cursor);
      
      if (bids.length === 0) break;
      
      // Filter bids to only those newer than our boundary AND with >30min validity remaining
      const newBids = bids.filter(bid => {
        const bidTimestamp = new Date(bid.createdAt).getTime();
        const validUntil = bid.validUntil * 1000; // Convert to milliseconds
        const now = Date.now();
        const thirtyMinutes = 30 * 60 * 1000; // 30 minutes in milliseconds
        
        const isNewerThanBoundary = bidTimestamp > boundaryTimestamp;
        const hasValidityRemaining = validUntil > (now + thirtyMinutes);
        
        return isNewerThanBoundary && hasValidityRemaining;
      });
      
      allNewBids.push(...newBids);
      logger.debug(`📄 Page ${totalPages}/${maxPages}: ${bids.length} total, ${newBids.length} new, ${allNewBids.length} collected`);
      
      // Check if oldest bid in this batch is older than boundary - if so, we're done
      const oldestInBatch = Math.min(...bids.map(bid => new Date(bid.createdAt).getTime()));
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
      
      // Rate limiting: 1 call per second to be respectful to Magic Eden API
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
    
    return allNewBids;
  }

  /**
   * Extract ENS token ID from Magic Eden tokenSetId
   * tokenSetId format: "token:0x57f1887a8bf19b14fc0df6fd9b2acc9af147ea85:123456789"
   */
  extractTokenId(tokenSetId: string): string | null {
    try {
      const parts = tokenSetId.split(':');
      
      // Handle both "token:" and "list:" formats
      if (parts.length >= 3 && (parts[0] === 'token' || parts[0] === 'list')) {
        const tokenId = parts[2];
        logger.debug(`🔍 Extracted token ID: ${tokenId} from ${tokenSetId} (format: ${parts[0]})`);
        return tokenId;
      }

      logger.warn(`⚠️  Unknown tokenSetId format: ${tokenSetId}`);
      return null;
    } catch (error: any) {
      logger.error(`❌ Error extracting token ID from ${tokenSetId}:`, error.message);
      return null;
    }
  }

  /**
   * Transform Magic Eden bid response to our internal format
   * Handles currency normalization and duration calculation
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
    // Magic Eden metadata (when includeCriteriaMetadata=true)
    ensName?: string;
    nftImage?: string;
  } {
    return {
      bidId: magicEdenBid.id,
      contractAddress: magicEdenBid.contract,
      tokenId: this.extractTokenId(magicEdenBid.tokenSetId),
      makerAddress: magicEdenBid.maker,
      takerAddress: magicEdenBid.taker,
      status: 'unposted', // Always use 'unposted' for internal status - Magic Eden status validated separately
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
      // Extract Magic Eden metadata when available (handle null values and clean trailing warnings)
      ensName: (magicEdenBid.criteria?.data?.token?.name && magicEdenBid.criteria.data.token.name !== 'null') ? this.cleanEnsName(magicEdenBid.criteria.data.token.name) : undefined,
      nftImage: (magicEdenBid.criteria?.data?.token?.image && magicEdenBid.criteria.data.token.image !== 'null') ? magicEdenBid.criteria.data.token.image : undefined
    };
  }

  /**
   * Calculate human-readable duration from timestamps
   * Returns formatted duration like "24 hours", "2 days", "1 month", etc.
   */
  calculateBidDuration(validFrom: number, validUntil: number): string {
    const durationMs = (validUntil - validFrom) * 1000; // Convert to milliseconds
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
   * WETH -> ETH, USDC -> USDC, etc.
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
   * Validate that a listing is still valid by checking for ownership changes after listing timestamp
   * Returns validation result with reason for invalidation
   */
  private async validateListingOwnership(
    contractAddress: string, 
    tokenId: string, 
    listingTimestamp: number
  ): Promise<{ isValid: boolean; invalidationReason?: 'ownership_change' | 'ask_cancel' | 'error' }> {
    try {
      // Check for ownership changes (sales/transfers) and cancellations  
      const response = await this.getTokenActivity(contractAddress, tokenId, 20, undefined, ['sale', 'transfer', 'ask_cancel']);
      
      // Find the most recent ownership change
      let mostRecentOwnershipChange: number = 0;
      for (const activity of response.activities) {
        if (activity.type === 'sale' || activity.type === 'transfer') {
          if (activity.timestamp > mostRecentOwnershipChange) {
            mostRecentOwnershipChange = activity.timestamp;
          }
        }
      }
      
      // If listing was created before the most recent ownership change, it's invalid
      if (mostRecentOwnershipChange > 0 && listingTimestamp < mostRecentOwnershipChange) {
        logger.debug(`🔍 Listing invalidated: created at ${listingTimestamp} but ownership changed at ${mostRecentOwnershipChange}`);
        return { isValid: false, invalidationReason: 'ownership_change' };
      }
      
      // Check for ask cancellations after the listing (these only affect this specific listing)
      for (const activity of response.activities) {
        if (activity.type === 'ask_cancel' && activity.timestamp > listingTimestamp) {
          logger.debug(`🔍 Listing cancelled at ${activity.timestamp} > ${listingTimestamp}`);
          return { isValid: false, invalidationReason: 'ask_cancel' };
        }
      }
      
      // Listing is still valid
      logger.debug(`✅ Listing still valid - created at ${listingTimestamp}, last ownership change: ${mostRecentOwnershipChange || 'never'}`);
      return { isValid: true };
      
    } catch (error: any) {
      logger.warn(`⚠️ Error validating listing ownership: ${error.message}`);
      // If we can't validate, assume it's invalid to be safe
      return { isValid: false, invalidationReason: 'error' };
    }
  }

  /**
   * Convert hex token ID to numeric format for Magic Eden API
   */
  private convertTokenIdToNumeric(tokenId: string): string {
    // Check if token ID is in hex format (with 0x prefix or contains hex letters a-f)
    const hasHexPrefix = tokenId.startsWith('0x');
    const hasHexLetters = /[a-fA-F]/.test(tokenId);
    const isHex = hasHexPrefix || hasHexLetters;
    
    if (isHex) {
      // Ensure 0x prefix for BigInt conversion
      const hexWithPrefix = tokenId.startsWith('0x') ? tokenId : `0x${tokenId}`;
      const numericId = BigInt(hexWithPrefix).toString();
      logger.debug(`🔄 Converting hex token ID ${tokenId} to numeric: ${numericId}`);
      return numericId;
    }
    
    // Already numeric - no conversion needed
    logger.debug(`✅ Token ID ${tokenId} is already numeric, no conversion needed`);
    return tokenId;
  }

  /**
   * Get token activity from Magic Eden API with pagination (single page)
   */
  async getTokenActivity(
    contractAddress: string,
    tokenId: string,
    limit: number = 20,
    continuation?: string,
    types?: string[]
  ): Promise<TokenActivityResponse> {
    try {
      // Convert hex token IDs to numeric format for Magic Eden
      const numericTokenId = this.convertTokenIdToNumeric(tokenId);
      const tokenIdentifier = `${contractAddress}:${numericTokenId}`;
      logger.debug(`🔍 Fetching activity for token: ${tokenIdentifier}`);

      // Magic Eden expects multiple separate 'types=' parameters, not an array
      let urlParams = new URLSearchParams();
      urlParams.set('limit', limit.toString());
      urlParams.set('sortBy', 'eventTimestamp');
      urlParams.set('includeMetadata', 'true');
      
      if (continuation) {
        urlParams.set('continuation', continuation);
      }
      
      if (types && types.length > 0) {
        types.forEach(type => urlParams.append('types', type));
        logger.debug(`🎯 Filtering by types: ${types.join(', ')}`);
      }

      const fullUrl = `/tokens/${encodeURIComponent(tokenIdentifier)}/activity/v5?${urlParams.toString()}`;
      logger.debug(`🌐 Full API URL: ${fullUrl}`);

      const response: AxiosResponse<TokenActivityResponse> = await this.axiosInstance.get(
        fullUrl,
        {
          headers: {
            'Accept': '*/*',
            'User-Agent': 'ENS-TwitterBot/1.0'
          },
          timeout: 10000
        }
      );

      logger.debug(`✅ Retrieved ${response.data.activities?.length || 0} activities`);
      return response.data;

    } catch (error: any) {
      logger.warn(`⚠️ Failed to fetch activity for ${contractAddress}:${tokenId}:`, error.message);
      return {
        activities: [],
        continuation: null
      };
    }
  }

  /**
   * Get complete token activity history with automatic pagination
   * Aggregates multiple pages of token activity into a single array
   * 
   * @param contract - ENS contract address
   * @param tokenId - Token ID
   * @param options - Optional pagination settings
   * @returns Array of token activities (aggregated from all pages)
   */
  async getTokenActivityHistory(
    contract: string,
    tokenId: string,
    options: {
      limit?: number;  // Items per request (default: 20, Magic Eden max)
      types?: ('sale' | 'mint' | 'transfer' | 'ask' | 'bid' | 'ask_cancel' | 'bid_cancel')[];
      maxPages?: number;  // Maximum pages to fetch (default: 10)
    } = {}
  ): Promise<TokenActivity[]> {
    // Set defaults
    const limit = options.limit || 20;  // Magic Eden max is 20
    const types = options.types || ['sale', 'mint'];
    const maxPages = options.maxPages || 10;

    logger.info(`📚 Fetching token activity history for ${contract}:${tokenId}`);
    logger.debug(`   Settings: limit=${limit}, types=[${types.join(',')}], maxPages=${maxPages}`);

    const allActivities: TokenActivity[] = [];
    let continuation: string | undefined;
    let pageCount = 0;

    try {
      // Loop through pages until we hit maxPages or run out of data
      while (pageCount < maxPages) {
        pageCount++;
        
        // Fetch single page using existing method
        const response = await this.getTokenActivity(
          contract,
          tokenId,
          limit,
          continuation,
          types as string[]
        );

        // Break if no activities returned
        if (!response.activities || response.activities.length === 0) {
          logger.debug(`   Page ${pageCount}: No more activities, stopping pagination`);
          break;
        }

        // Add activities to aggregated array
        allActivities.push(...response.activities);
        logger.debug(`   Page ${pageCount}: Fetched ${response.activities.length} activities (total: ${allActivities.length})`);

        // Check for continuation cursor
        continuation = response.continuation || undefined;
        if (!continuation) {
          logger.debug(`   Page ${pageCount}: No continuation cursor, reached end of data`);
          break;
        }

        // Rate limiting between requests (200ms delay)
        if (continuation) {
          await new Promise(resolve => setTimeout(resolve, 200));
        }
      }

      logger.info(`✅ Token activity history complete: ${allActivities.length} activities across ${pageCount} pages`);
      return allActivities;

    } catch (error: any) {
      logger.error(`❌ Error fetching token activity history: ${error.message}`);
      // Return whatever we collected before the error
      return allActivities;
    }
  }

  /**
   * Get complete user activity history with automatic pagination
   * Fetches user's ENS activities across BOTH ENS contracts
   * 
   * NOTE: Defaults to 'sale' and 'mint' only. Excludes 'bid' types due to excessive
   * bot activity that creates noise in the data. Bids can generate hundreds of activities
   * per user, making it difficult to extract meaningful trading patterns.
   * 
   * @param address - User wallet address
   * @param options - Optional pagination settings
   * @returns Array of user activities (aggregated from all pages)
   */
  async getUserActivityHistory(
    address: string,
    options: {
      limit?: number;  // Items per request (default: 20, Magic Eden max)
      types?: ('sale' | 'mint' | 'transfer' | 'ask' | 'bid' | 'ask_cancel' | 'bid_cancel')[];
      maxPages?: number;  // Maximum pages to fetch (default: 10)
    } = {}
  ): Promise<TokenActivity[]> {
    // Set defaults - NOTE: Excludes 'bid' types to avoid bot noise
    const limit = options.limit || 20;  // Magic Eden max is 20
    const types = options.types || ['sale', 'mint'];  // Only real transactions, not bid spam
    const maxPages = options.maxPages || 10;

    logger.info(`👤 Fetching user activity history for ${address}`);
    logger.debug(`   Settings: limit=${limit}, types=[${types.join(',')}], maxPages=${maxPages}`);

    const allActivities: TokenActivity[] = [];
    let continuation: string | undefined;
    let pageCount = 0;

    try {
      // Loop through pages until we hit maxPages or run out of data
      while (pageCount < maxPages) {
        pageCount++;
        
        // Build query params - must include BOTH ENS contracts
        const params: any = {
          users: address,
          limit: limit,
          sortBy: 'eventTimestamp',
          includeMetadata: true
        };

        // Add both ENS contracts
        params.collection = this.ensContracts;

        // Add types filter
        if (types && types.length > 0) {
          params.types = types;
        }

        // Add continuation cursor if available
        if (continuation) {
          params.continuation = continuation;
        }

        // Fetch single page
        const response: AxiosResponse<TokenActivityResponse> = await this.axiosInstance.get(
          '/users/activity/v6',
          {
            params,
            headers: {
              'Accept': '*/*',
              'User-Agent': 'ENS-TwitterBot/1.0'
            },
            timeout: 10000
          }
        );

        // Break if no activities returned
        if (!response.data.activities || response.data.activities.length === 0) {
          logger.debug(`   Page ${pageCount}: No more activities, stopping pagination`);
          break;
        }

        // Add activities to aggregated array
        allActivities.push(...response.data.activities);
        logger.debug(`   Page ${pageCount}: Fetched ${response.data.activities.length} activities (total: ${allActivities.length})`);

        // Check for continuation cursor
        continuation = response.data.continuation || undefined;
        if (!continuation) {
          logger.debug(`   Page ${pageCount}: No continuation cursor, reached end of data`);
          break;
        }

        // Rate limiting between requests (200ms delay)
        if (continuation) {
          await new Promise(resolve => setTimeout(resolve, 200));
        }
      }

      logger.info(`✅ User activity history complete: ${allActivities.length} activities across ${pageCount} pages`);
      return allActivities;

    } catch (error: any) {
      logger.error(`❌ Error fetching user activity history: ${error.message}`);
      // Return whatever we collected before the error
      return allActivities;
    }
  }

  /**
   * Find most recent sale or mint event with pagination
   */
  async getLastSaleOrRegistration(
    contractAddress: string,
    tokenId: string,
    currentTxHash?: string
  ): Promise<HistoricalEvent | null> {
    try {
      let continuation: string | undefined;
      let attempts = 0;
      const maxAttempts = 10; // Prevent infinite pagination

      while (attempts < maxAttempts) {
        const response = await this.getTokenActivity(contractAddress, tokenId, 20, continuation, ['sale', 'mint']);
        
        if (!response.activities || response.activities.length === 0) {
          break;
        }

        // Look for sale or mint events with price > 0 (already filtered by API)
        for (const activity of response.activities) {
          const activityCurrencySymbol = CurrencyUtils.getCurrencySymbol(activity.price.currency.contract, activity.price.currency.symbol);
          logger.debug(`🔍 Checking activity: type=${activity.type}, price=${activity.price.amount.decimal} ${activityCurrencySymbol}, txHash=${activity.txHash}`);
          
          // Skip if this is the current transaction (not historical)
          if (currentTxHash && activity.txHash.toLowerCase() === currentTxHash.toLowerCase()) {
            logger.debug(`⏭️ Skipping current transaction: ${activity.txHash} (matches ${currentTxHash})`);
            continue;
          }
          
          // API already filtered to sale/mint types, just check price > 0
          if (activity.price.amount.decimal > 0) {
            
            const priceDecimal = activity.price.amount.decimal;
            const currencyContract = activity.price.currency.contract;
            const currencySymbol = CurrencyUtils.getCurrencySymbol(currencyContract, activity.price.currency.symbol);
            
            // For threshold comparison, use ETH equivalent for non-ETH currencies
            const thresholdPrice = CurrencyUtils.isETHEquivalent(currencyContract) 
              ? priceDecimal 
              : activity.price.amount.native; // Use native ETH equivalent for threshold
            
            // Hard cutoff: only show if the MOST RECENT event meets threshold
            if (thresholdPrice >= this.historicalThresholdEth) {
              const daysAgo = this.calculateDaysSince(activity.timestamp);
              
              logger.info(`📈 Found historical event: ${activity.type} for ${priceDecimal} ${currencySymbol}, ${daysAgo} days ago`);
              
              return {
                type: activity.type as 'sale' | 'mint',
                priceEth: priceDecimal.toFixed(2), // Now represents price in native currency
                priceUsd: activity.price.amount.usd?.toFixed(2) || '',
                timestamp: activity.timestamp,
                daysAgo,
                currencySymbol,
                currencyContract: currencyContract || '',
                priceDecimal
              };
            } else {
              logger.debug(`🔽 Most recent historical event below threshold: ${thresholdPrice} ETH-equivalent < ${this.historicalThresholdEth} ETH - not showing any historical data`);
              return null; // Hard cutoff - don't look for older events
            }
          } else {
            const activityCurrencySymbol = CurrencyUtils.getCurrencySymbol(activity.price.currency.contract, activity.price.currency.symbol);
            logger.debug(`❌ Activity filtered out: zero price (${activity.price.amount.decimal} ${activityCurrencySymbol})`);
          }
        }

        continuation = response.continuation || undefined;
        if (!continuation) break;
        
        attempts++;
        
        // Rate limiting
        await new Promise(resolve => setTimeout(resolve, 200));
      }

      logger.debug(`📭 No historical data found meeting threshold for ${contractAddress}:${tokenId}`);
      return null;

    } catch (error: any) {
      logger.warn(`⚠️ Error getting historical data for ${contractAddress}:${tokenId}:`, error.message);
      return null;
    }
  }

  /**
   * Get current active listing price for comparison with bids
   */
  async getCurrentListingPrice(
    contractAddress: string,
    tokenId: string,
    bidAmount: number
  ): Promise<ListingPrice | null> {
    try {
      let continuation: string | undefined;
      let attempts = 0;
      const maxAttempts = 5; // Less attempts for listing lookup

      while (attempts < maxAttempts) {
        const response = await this.getTokenActivity(contractAddress, tokenId, 20, continuation, ['ask']);
        
        if (!response.activities || response.activities.length === 0) {
          break;
        }

        // Look for most recent active ask (listing) - already filtered by API
        let activeAsk: TokenActivity | null = null;
        
        for (const activity of response.activities) {
          // API already filtered to 'ask' type, just check price > 0
          if (activity.price.amount.decimal > 0) {
            activeAsk = activity;
            break;
          }
        }

        if (activeAsk) {
          // Validate that the listing is still valid (no ownership changes after it was created)
          const validation = await this.validateListingOwnership(contractAddress, tokenId, activeAsk.timestamp);
          
          if (!validation.isValid) {
            if (validation.invalidationReason === 'ownership_change') {
              // Ownership changed - ALL listings are invalid, stop searching immediately
              logger.debug(`❌ Ownership changed after listing ${activeAsk.timestamp} - all listings invalid, stopping search`);
              break;
            } else if (validation.invalidationReason === 'error') {
              // Validation API failed - stop immediately for safety (don't show potentially invalid listings)
              logger.debug(`❌ Failed to validate listing ${activeAsk.timestamp} - stopping search for safety`);
              break;
            } else {
              // Just this specific listing was cancelled - continue searching for older valid listings
              logger.debug(`❌ Listing invalidated by ${validation.invalidationReason} after ${activeAsk.timestamp} - continuing search`);
              continuation = response.continuation || undefined;
              attempts++;
              continue;
            }
          }
          
          const listingPriceDecimal = activeAsk.price.amount.decimal;
          const listingCurrencyContract = activeAsk.price.currency.contract;
          const listingCurrencySymbol = CurrencyUtils.getCurrencySymbol(listingCurrencyContract, activeAsk.price.currency.symbol);
          
          // Always show listing price if available (proximity threshold removed)
          logger.info(`📊 Found valid active listing: ${listingPriceDecimal} ${listingCurrencySymbol}`);
          
          return {
            priceEth: listingPriceDecimal.toFixed(2), // Now represents price in native currency
            priceUsd: activeAsk.price.amount.usd?.toFixed(2),
            timestamp: activeAsk.timestamp,
            currencySymbol: listingCurrencySymbol,
            currencyContract: listingCurrencyContract || '',
            priceDecimal: listingPriceDecimal
          };
        }

        continuation = response.continuation || undefined;
        if (!continuation) break;
        
        attempts++;
        
        // Rate limiting
        await new Promise(resolve => setTimeout(resolve, 200));
      }

      logger.debug(`📭 No suitable active listing found for ${contractAddress}:${tokenId}`);
      return null;

    } catch (error: any) {
      logger.warn(`⚠️ Error getting listing price for ${contractAddress}:${tokenId}:`, error.message);
      return null;
    }
  }

  /**
   * Get contextual data for tweet enhancement
   */
  async getContextualData(
    contractAddress: string,
    tokenId: string,
    currentTransactionTimestamp: number,
    bidAmount?: number
  ): Promise<ContextualData> {
    const contextual: ContextualData = {};

    try {
      // Get historical context for sales and registrations
      const historical = await this.getLastSaleOrRegistration(
        contractAddress,
        tokenId
      );
      
      if (historical) {
        contextual.historical = historical;
      }

      // Get current listing price for bids
      if (bidAmount !== undefined) {
        const listing = await this.getCurrentListingPrice(contractAddress, tokenId, bidAmount);
        if (listing) {
          contextual.listing = listing;
        }
      }

      return contextual;

    } catch (error: any) {
      logger.warn(`⚠️ Error getting contextual data:`, error.message);
      return {};
    }
  }

  /**
   * Calculate days since timestamp
   */
  private calculateDaysSince(timestamp: number): number {
    const now = Math.floor(Date.now() / 1000);
    const diffSeconds = now - timestamp;
    return Math.floor(diffSeconds / (24 * 60 * 60));
  }

  /**
   * Format time period for human readability
   */
  formatTimePeriod(days: number): string {
    if (days === 0) return 'today';
    if (days === 1) return '1 day ago';
    if (days < 30) return `${days} days ago`;
    if (days < 60) return '1 month ago';
    if (days < 365) {
      const months = Math.floor(days / 30);
      return `${months} month${months > 1 ? 's' : ''} ago`;
    }
    const years = Math.floor(days / 365);
    return `${years} year${years > 1 ? 's' : ''} ago`;
  }

  /**
   * Check if Magic Eden API is responding
   */
  async healthCheck(): Promise<boolean> {
    try {
      const response = await this.axiosInstance.get('/orders/bids/v6', {
        params: {
          contracts: this.ensContracts,
          status: 'active',
          limit: 1
        },
        headers: {
          'Authorization': 'Bearer YOUR_API_KEY',
          'Accept': '*/*'
        },
        timeout: 5000
      });

      return response.status === 200;
    } catch (error) {
      logger.error('❌ Magic Eden API health check failed:', error);
      return false;
    }
  }

  /**
   * Get API stats and rate limit info
   */
  async getApiStats(): Promise<{ 
    healthy: boolean;
    rateLimitRemaining?: number; 
    rateLimitReset?: number 
  }> {
    const healthy = await this.healthCheck();
    
    return {
      healthy,
      // Magic Eden/Reservoir API rate limits (if available in headers)
      rateLimitRemaining: undefined,
      rateLimitReset: undefined
    };
  }
}
