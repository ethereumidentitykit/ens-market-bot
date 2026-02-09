import axios from 'axios';
import { IDatabaseService } from '../types';
import { logger } from '../utils/logger';
import { TransformedBid } from './bidsProcessingService';
import { AlchemyService } from './alchemyService';

/**
 * Grails API Response Types
 */
export interface GrailsOffer {
  id: number;
  ens_name_id: number;
  event_type: string;
  actor_address: string;
  counterparty_address: string | null;
  platform: string;
  chain_id: number;
  price_wei: string;
  currency_address: string;
  transaction_hash: string | null;
  block_number: number | null;
  metadata: {
    offer_id: number;
  };
  created_at: string;
  name: string;
  token_id: string;
}

export interface GrailsApiResponse {
  success: boolean;
  data: {
    results: GrailsOffer[];
    pagination: {
      page: number;
      limit: number;
      total: number;
      totalPages: number;
      hasNext: boolean;
      hasPrev: boolean;
    };
  };
  meta: {
    timestamp: string;
    version: string;
  };
}

/**
 * Currency address to symbol mapping
 */
const CURRENCY_MAP: Record<string, string> = {
  '0x0000000000000000000000000000000000000000': 'ETH',
  '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2': 'WETH',
  '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48': 'USDC',
  '0xdac17f958d2ee523a2206206994597c13d831ec7': 'USDT',
};

/**
 * ENS Contract Addresses
 */
const ENS_NAMEWRAPPER = '0xd4416b13d2b3a9abae7acd5d6c2bbdbe25686401';
const ENS_BASE_REGISTRAR = '0x57f1887a8bf19b14fc0df6fd9b2acc9af147ea85';

/**
 * Active listing returned by getListingsForName()
 */
export interface GrailsActiveListing {
  price: number;          // Decimal price (e.g. 0.5)
  priceWei: string;
  currencySymbol: string; // ETH, WETH, USDC, etc.
  source: string;         // e.g. "grails", "opensea"
}

/**
 * Grails service stats type
 */
export interface GrailsServiceStats {
  totalFetched: number;
  totalStored: number;
  duplicates: number;
  errors: number;
  lastFetchTime: Date | null;
}

/**
 * GrailsApiService
 * Fetches ENS offers from Grails marketplace REST API
 * Runs every 5 minutes to catch offers that Magic Eden doesn't pick up
 */
export class GrailsApiService {
  private databaseService: IDatabaseService;
  private alchemyService: AlchemyService;
  private baseUrl: string;
  
  // Stats tracking
  private stats: GrailsServiceStats = {
    totalFetched: 0,
    totalStored: 0,
    duplicates: 0,
    errors: 0,
    lastFetchTime: null,
  };

  constructor(databaseService: IDatabaseService, alchemyService: AlchemyService) {
    this.databaseService = databaseService;
    this.alchemyService = alchemyService;
    this.baseUrl = process.env.GRAILS_API_URL || 'https://grails-api.ethid.org/api/v1/activity';
    
    logger.info(`🍷 GrailsApiService initialized (endpoint: ${this.baseUrl})`);
  }

  /**
   * Fetch new offers from Grails API with timestamp-based cursor
   * Uses 1-hour lookback cap and max 200 results (4 pages)
   */
  async fetchNewOffers(): Promise<TransformedBid[]> {
    const startTime = Date.now();
    logger.info('🍷 Starting Grails API fetch...');

    try {
      // Get last processed timestamp (with 1-hour lookback cap)
      const lastTimestamp = await this.getLastProcessedTimestamp();
      const fourHoursAgo = Date.now() - (4 * 60 * 60 * 1000);
      const boundaryTimestamp = Math.max(lastTimestamp, fourHoursAgo);
      
      logger.info(`📈 Fetching offers newer than: ${new Date(boundaryTimestamp).toISOString()}`);

      const allOffers: GrailsOffer[] = [];
      let page = 1;
      const maxPages = 4; // Max 200 results (4 × 50)
      const limit = 50;
      let hasMore = true;
      let newestTimestamp = boundaryTimestamp;

      while (hasMore && page <= maxPages) {
        const url = `${this.baseUrl}?limit=${limit}&page=${page}&event_type=offer_made&platform=grails`;
        logger.debug(`🔍 Fetching page ${page}: ${url}`);

        const response = await axios.get<GrailsApiResponse>(url, {
          timeout: 15000,
          headers: {
            'Accept': 'application/json',
            'User-Agent': 'ENS-TwitterBot/2.0',
          },
        });

        if (!response.data.success || !response.data.data?.results) {
          logger.warn(`⚠️ Grails API returned unsuccessful response on page ${page}`);
          break;
        }

        const offers = response.data.data.results;
        logger.debug(`📄 Page ${page}: Retrieved ${offers.length} offers`);

        // Filter to only offers newer than our cursor
        const newOffers = offers.filter(offer => {
          const offerTime = new Date(offer.created_at).getTime();
          
          // Track newest timestamp seen
          if (offerTime > newestTimestamp) {
            newestTimestamp = offerTime;
          }
          
          return offerTime > boundaryTimestamp;
        });

        allOffers.push(...newOffers);

        // Stop if we hit older offers (API returns newest first)
        if (newOffers.length < offers.length) {
          logger.debug(`🛑 Hit boundary timestamp, stopping pagination`);
          hasMore = false;
        } else {
          hasMore = response.data.data.pagination.hasNext;
          page++;
        }

        // Rate limiting between pages
        if (hasMore && page <= maxPages) {
          await new Promise(resolve => setTimeout(resolve, 500));
        }
      }

      // Update cursor timestamp
      if (newestTimestamp > boundaryTimestamp) {
        await this.setLastProcessedTimestamp(newestTimestamp);
        logger.info(`📍 Updated cursor to: ${new Date(newestTimestamp).toISOString()}`);
      }

      // Transform offers to internal format
      const transformedBids = await Promise.all(
        allOffers.map(offer => this.transformOffer(offer))
      );

      const duration = Date.now() - startTime;
      this.stats.totalFetched += allOffers.length;
      this.stats.lastFetchTime = new Date();

      logger.info(`✅ Grails fetch complete in ${duration}ms: ${allOffers.length} new offers from ${page} page(s)`);

      return transformedBids;

    } catch (error: any) {
      this.stats.errors++;
      logger.error('❌ Grails API fetch failed:', error.message);
      return [];
    }
  }

  /**
   * Transform Grails offer to internal TransformedBid format
   */
  private async transformOffer(offer: GrailsOffer): Promise<TransformedBid> {
    const now = Math.floor(Date.now() / 1000);
    
    // Calculate price in decimal (wei to ETH/token)
    const currencySymbol = this.getCurrencySymbol(offer.currency_address);
    const decimals = this.getCurrencyDecimals(currencySymbol);
    const priceDecimal = (BigInt(offer.price_wei) / BigInt(10 ** decimals)).toString();
    const priceDecimalFloat = Number(offer.price_wei) / Math.pow(10, decimals);

    // Resolve contract address (NameWrapper first, Base Registrar fallback)
    const contractAddress = await this.resolveContractAddress(offer.token_id);

    return {
      bidId: `grails-${offer.metadata.offer_id}`, // Prefixed for deduplication
      contractAddress,
      tokenId: offer.token_id,
      makerAddress: offer.actor_address,
      takerAddress: offer.counterparty_address || '0x0000000000000000000000000000000000000000',
      status: 'unposted',
      priceRaw: offer.price_wei,
      priceDecimal: priceDecimalFloat.toFixed(6),
      priceUsd: '', // Will be enriched by BidsProcessingService
      currencyContract: offer.currency_address,
      currencySymbol,
      sourceDomain: 'grails.app',
      sourceName: 'Grails',
      marketplaceFee: 0, // Not provided by API
      createdAtApi: offer.created_at,
      updatedAtApi: offer.created_at, // Same as created (no update info)
      validFrom: now,
      validUntil: now + (7 * 24 * 60 * 60), // Default 7 days
      processedAt: new Date().toISOString(),
      ensName: offer.name, // Already resolved by Grails!
      nftImage: undefined, // Will be enriched if needed
    };
  }

  /**
   * Resolve contract address - try NameWrapper first, fallback to Base Registrar
   */
  private async resolveContractAddress(tokenId: string): Promise<string> {
    try {
      // Try NameWrapper first (most names are wrapped now)
      const nameWrapperUrl = `https://metadata.ens.domains/mainnet/${ENS_NAMEWRAPPER}/${tokenId}`;
      const response = await axios.get(nameWrapperUrl, { timeout: 3000 });
      
      if (response.data?.name) {
        logger.debug(`🎁 Token ${tokenId.slice(-8)}... is wrapped (NameWrapper)`);
        return ENS_NAMEWRAPPER;
      }
    } catch {
      // NameWrapper failed, use Base Registrar
    }
    
    logger.debug(`📦 Token ${tokenId.slice(-8)}... using Base Registrar (not wrapped)`);
    return ENS_BASE_REGISTRAR;
  }

  /**
   * Get currency symbol from contract address
   */
  private getCurrencySymbol(address: string): string {
    return CURRENCY_MAP[address.toLowerCase()] || 'UNKNOWN';
  }

  /**
   * Get currency decimals
   */
  private getCurrencyDecimals(symbol: string): number {
    if (symbol === 'USDC' || symbol === 'USDT') return 6;
    return 18; // ETH, WETH
  }

  /**
   * Get last processed timestamp from database
   */
  private async getLastProcessedTimestamp(): Promise<number> {
    try {
      const value = await this.databaseService.getSystemState('last_grails_offer_timestamp');
      if (value) {
        return parseInt(value, 10);
      }
    } catch (error: any) {
      logger.warn('Failed to get last Grails timestamp:', error.message);
    }
    
    // Default: 1 hour ago
    return Date.now() - (60 * 60 * 1000);
  }

  /**
   * Set last processed timestamp in database
   */
  private async setLastProcessedTimestamp(timestamp: number): Promise<void> {
    try {
      await this.databaseService.setSystemState('last_grails_offer_timestamp', timestamp.toString());
    } catch (error: any) {
      logger.error('Failed to set last Grails timestamp:', error.message);
    }
  }

  /**
   * Get service stats
   */
  getStats(): GrailsServiceStats {
    return { ...this.stats };
  }

  /**
   * Get service status for admin dashboard
   */
  getStatus(): {
    enabled: boolean;
    baseUrl: string;
    lastFetchTime: Date | null;
    stats: GrailsServiceStats;
  } {
    return {
      enabled: !!process.env.GRAILS_API_URL,
      baseUrl: this.baseUrl,
      lastFetchTime: this.stats.lastFetchTime,
      stats: this.getStats(),
    };
  }

  /**
   * Fetch active listings for an ENS name from Grails API
   * Uses the /names/{name} endpoint (same as grails-app frontend)
   * Static method — no service instance needed, just an HTTP call
   */
  static async getListingsForName(name: string): Promise<GrailsActiveListing[]> {
    try {
      const cleanName = name.endsWith('.eth') ? name : `${name}.eth`;
      const apiBase = process.env.GRAILS_API_URL
        ? process.env.GRAILS_API_URL.replace(/\/activity$/, '')
        : 'https://grails-api.ethid.org/api/v1';
      const url = `${apiBase}/names/${encodeURIComponent(cleanName)}`;

      logger.info(`🍷 Fetching Grails listings for: ${cleanName}`);

      const response = await axios.get(url, {
        timeout: 10000,
        headers: {
          'Accept': 'application/json',
          'User-Agent': 'ENS-TwitterBot/2.0',
        },
      });

      if (!response.data?.success || !response.data?.data?.listings) {
        logger.debug(`🍷 No listings data in Grails response for ${cleanName}`);
        return [];
      }

      const activeListings: GrailsActiveListing[] = response.data.data.listings
        .filter((l: any) => l.status === 'active')
        .map((l: any) => ({
          price: parseFloat(l.price),
          priceWei: l.price_wei,
          currencySymbol: CURRENCY_MAP[l.currency_address?.toLowerCase()] || 'ETH',
          source: l.source || 'grails',
        }));

      logger.info(`🍷 Found ${activeListings.length} active Grails listing(s) for ${cleanName}`);
      return activeListings;

    } catch (error: any) {
      logger.warn(`🍷 Failed to fetch Grails listings for ${name}:`, error.message);
      return [];
    }
  }
}

