import axios, { AxiosResponse, AxiosInstance } from 'axios';
import { logger } from '../utils/logger';
import { MagicEdenBidResponse, MagicEdenBid, BidProcessingStats } from '../types';
import { APIToggleService } from './apiToggleService';

/**
 * Magic Eden API Service
 * Handles fetching ENS bid data from Magic Eden's API
 */
export class MagicEdenService {
  private readonly baseUrl: string;
  private readonly ensContracts: string[];
  private readonly axiosInstance: AxiosInstance;
  private readonly apiToggleService: APIToggleService;
  
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
   * Clean ENS name by removing any data after .eth
   * Magic Eden/OpenSea append normalization warnings after the .eth suffix
   */
  private cleanEnsName(ensName: string): string {
    if (!ensName) return ensName;
    
    const ethIndex = ensName.toLowerCase().indexOf('.eth');
    if (ethIndex !== -1) {
      return ensName.substring(0, ethIndex + 4); // Include ".eth"
    }
    
    return ensName; // Return as-is if no .eth found
  }

  /**
   * Get active bids using cursor-based pagination
   * Always fetches newest first - doesn't rely on API filtering
   */
  async getActiveBids(
    cursor?: string,
    limit: number = 200
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
    const maxPages = 5; // Reduced limit to prevent scheduler overlap (1000 bids max)
    
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
      status: magicEdenBid.status,
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
