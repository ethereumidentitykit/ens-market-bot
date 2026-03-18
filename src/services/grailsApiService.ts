import axios from 'axios';
import { IDatabaseService } from '../types';
import { logger } from '../utils/logger';
import { TransformedBid } from './bidsProcessingService';
import { AlchemyService } from './alchemyService';
import { TokenActivity } from './magicEdenV4Service';

/**
 * Grails API Response Types
 */
export interface GrailsActivityRecord {
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
  block_number: string | null;
  metadata: Record<string, any>;
  created_at: string;
  name: string;
  token_id: string;
  clubs?: string[];
}

export type GrailsOffer = GrailsActivityRecord;

export interface GrailsApiResponse {
  success: boolean;
  data: {
    results: GrailsActivityRecord[];
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

const CURRENCY_DECIMALS: Record<string, number> = {
  'USDC': 6,
  'USDT': 6,
  'DAI': 18,
};

const CURRENCY_NAMES: Record<string, string> = {
  'ETH': 'Ether',
  'WETH': 'Wrapped Ether',
  'USDC': 'USD Coin',
  'USDT': 'Tether',
  'DAI': 'Dai Stablecoin',
};

/**
 * Currency address to symbol mapping
 */
const CURRENCY_MAP: Record<string, string> = {
  '0x0000000000000000000000000000000000000000': 'ETH',
  '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2': 'ETH',
  '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48': 'USDC',
  '0xdac17f958d2ee523a2206206994597c13d831ec7': 'USDT',
  '0x6b175474e89094c44da98b954eedeac495271d0f': 'DAI',
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
    
    const currencySymbol = this.getCurrencySymbol(offer.currency_address);
    const decimals = this.getCurrencyDecimals(currencySymbol);
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
      priceUsd: null, // Will be enriched by BidsProcessingService
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

  private static getApiBase(): string {
    return process.env.GRAILS_API_URL
      ? process.env.GRAILS_API_URL.replace(/\/activity$/, '')
      : 'https://grails-api.ethid.org/api/v1';
  }

  /**
   * Fetch activity history for an ENS name (sales + mints).
   * Uses event_type=bought (not sold) to naturally deduplicate — each sale
   * appears once with actor=buyer, counterparty=seller.
   */
  static async getNameActivity(
    name: string,
    options: { limit?: number; maxPages?: number } = {}
  ): Promise<{ activities: TokenActivity[]; incomplete: boolean; pagesFetched: number }> {
    const cleanName = name.endsWith('.eth') ? name : `${name}.eth`;
    const limit = options.limit || 50;
    const maxPages = options.maxPages || 10;
    const apiBase = GrailsApiService.getApiBase();

    logger.info(`🍷 Fetching Grails name activity for: ${cleanName}`);

    const allActivities: TokenActivity[] = [];
    let page = 1;
    let incomplete = false;

    try {
      while (page <= maxPages) {
        const url = `${apiBase}/activity/${encodeURIComponent(cleanName)}?limit=${limit}&page=${page}&event_type=bought&event_type=mint`;
        logger.debug(`   Page ${page}: ${url}`);

        const response = await axios.get<GrailsApiResponse>(url, {
          timeout: 15000,
          headers: { 'Accept': 'application/json', 'User-Agent': 'ENS-TwitterBot/2.0' },
        });

        if (!response.data.success || !response.data.data?.results) {
          logger.warn(`   Grails API returned unsuccessful response on page ${page}`);
          break;
        }

        const records = response.data.data.results;
        allActivities.push(...records.map(r => GrailsApiService.toTokenActivity(r)));

        if (!response.data.data.pagination.hasNext) break;
        page++;

        await new Promise(resolve => setTimeout(resolve, 300));
      }

      if (page > maxPages) incomplete = true;

      logger.info(`🍷 Name activity complete: ${allActivities.length} activities from ${page} page(s)${incomplete ? ' (incomplete)' : ''}`);
      return { activities: allActivities, incomplete, pagesFetched: page };
    } catch (error: any) {
      logger.error(`🍷 Failed to fetch name activity for ${cleanName}:`, error.message);
      return { activities: allActivities, incomplete: true, pagesFetched: page };
    }
  }

  /**
   * Fetch activity history for an Ethereum address.
   * Fetches sold, bought, and mint events; deduplicates sold+bought pairs by transaction hash.
   */
  static async getAddressActivity(
    address: string,
    options: { limit?: number; maxPages?: number } = {}
  ): Promise<{ activities: TokenActivity[]; incomplete: boolean; pagesFetched: number }> {
    const limit = options.limit || 50;
    const maxPages = options.maxPages || 10;
    const apiBase = GrailsApiService.getApiBase();

    logger.info(`🍷 Fetching Grails address activity for: ${address}`);

    const allActivities: TokenActivity[] = [];
    const seen = new Set<string>();
    let page = 1;
    let incomplete = false;

    try {
      while (page <= maxPages) {
        const url = `${apiBase}/activity/address/${address}?limit=${limit}&page=${page}&event_type=sold&event_type=bought&event_type=mint`;
        logger.debug(`   Page ${page}: ${url}`);

        const response = await axios.get<GrailsApiResponse>(url, {
          timeout: 15000,
          headers: { 'Accept': 'application/json', 'User-Agent': 'ENS-TwitterBot/2.0' },
        });

        if (!response.data.success || !response.data.data?.results) {
          logger.warn(`   Grails API returned unsuccessful response on page ${page}`);
          break;
        }

        const records = response.data.data.results;
        const transformed = GrailsApiService.deduplicateAndTransform(records, seen);
        allActivities.push(...transformed);

        if (!response.data.data.pagination.hasNext) break;
        page++;

        await new Promise(resolve => setTimeout(resolve, 300));
      }

      const pagesFetched = page > maxPages ? maxPages : page;
      if (page > maxPages) incomplete = true;

      logger.info(`🍷 Address activity complete: ${allActivities.length} activities from ${pagesFetched} page(s)${incomplete ? ' (incomplete)' : ''}`);
      return { activities: allActivities, incomplete, pagesFetched };
    } catch (error: any) {
      logger.error(`🍷 Failed to fetch address activity for ${address}:`, error.message);
      return { activities: allActivities, incomplete: true, pagesFetched: page };
    }
  }

  /**
   * Deduplicate sold+bought pairs by transaction_hash, keeping one TokenActivity per sale.
   * For address queries we get both "sold" and "bought" for each sale the address is involved in.
   */
  private static deduplicateAndTransform(records: GrailsActivityRecord[], seen: Set<string> = new Set()): TokenActivity[] {
    const results: TokenActivity[] = [];

    for (const record of records) {
      const dedupeKey = record.transaction_hash || `${record.id}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);

      if (record.event_type === 'mint' || record.event_type === 'bought' || record.event_type === 'sold') {
        results.push(GrailsApiService.toTokenActivity(record));
      }
    }

    return results;
  }

  /**
   * Transform a Grails activity record into the shared TokenActivity format.
   * Grails already resolves proxy contracts — addresses are truth.
   *
   * "bought": actor=buyer, counterparty=seller → fromAddress=seller, toAddress=buyer
   * "sold":   actor=seller, counterparty=buyer → fromAddress=seller, toAddress=buyer
   * "mint":   actor=minter → fromAddress=0x0, toAddress=minter
   */
  static toTokenActivity(record: GrailsActivityRecord): TokenActivity {
    const currencySymbol = CURRENCY_MAP[record.currency_address?.toLowerCase()] || 'UNKNOWN';
    const decimals = CURRENCY_DECIMALS[currencySymbol] || 18;
    const priceDecimal = Number(record.price_wei) / Math.pow(10, decimals);

    const isEthLike = currencySymbol === 'ETH';

    let fromAddress: string;
    let toAddress: string;
    let activityType: TokenActivity['type'];

    if (record.event_type === 'mint') {
      fromAddress = '0x0000000000000000000000000000000000000000';
      toAddress = record.actor_address;
      activityType = 'mint';
    } else if (record.event_type === 'bought') {
      fromAddress = record.counterparty_address || '0x0000000000000000000000000000000000000000';
      toAddress = record.actor_address;
      activityType = 'sale';
    } else {
      // "sold": actor is the seller
      fromAddress = record.actor_address;
      toAddress = record.counterparty_address || '0x0000000000000000000000000000000000000000';
      activityType = 'sale';
    }

    return {
      type: activityType,
      fromAddress,
      toAddress,
      price: {
        currency: {
          contract: record.currency_address || '0x0000000000000000000000000000000000000000',
          name: CURRENCY_NAMES[currencySymbol] || currencySymbol,
          symbol: currencySymbol,
          decimals,
        },
        amount: {
          raw: record.price_wei,
          decimal: priceDecimal,
          usd: 0,
          native: isEthLike ? priceDecimal : 0,
        },
      },
      amount: 1,
      timestamp: Math.floor(new Date(record.created_at).getTime() / 1000),
      createdAt: record.created_at,
      contract: ENS_NAMEWRAPPER,
      token: {
        tokenId: record.token_id,
        isSpam: false,
        isNsfw: false,
        tokenName: record.name,
        tokenImage: null,
        rarityScore: null,
        rarityRank: null,
      },
      collection: {
        collectionId: 'ens',
        isSpam: false,
        isNsfw: false,
        collectionName: 'ENS: Ethereum Name Service',
        collectionImage: '',
      },
      txHash: record.transaction_hash || '',
      logIndex: 0,
      batchIndex: 0,
      fillSource: record.platform ? { domain: record.platform, name: record.platform, icon: '' } : undefined,
      comment: null,
    };
  }

  /**
   * Get last sale or mint for an ENS name via Grails API.
   * Replaces Magic Eden's getLastSaleOrRegistration — lookup by name, not contract+tokenId.
   */
  static async getLastSaleOrMint(
    ensName: string,
    currentTxHash?: string,
    thresholdEth: number = 0.01
  ): Promise<{ type: 'sale' | 'mint'; priceAmount: string; priceUsd: string; timestamp: number; daysAgo: number; currencySymbol: string; currencyContract: string; priceDecimal: number } | null> {
    try {
      const result = await GrailsApiService.getNameActivity(ensName, { limit: 50, maxPages: 2 });

      for (const activity of result.activities) {
        if (currentTxHash && activity.txHash.toLowerCase() === currentTxHash.toLowerCase()) continue;
        if (!activity.price?.amount?.decimal || activity.price.amount.decimal <= 0) continue;

        const priceDecimal = activity.price.amount.decimal;
        if (priceDecimal < thresholdEth) return null;

        const daysAgo = Math.floor((Date.now() / 1000 - activity.timestamp) / 86400);
        return {
          type: activity.type === 'mint' ? 'mint' : 'sale',
          priceAmount: priceDecimal.toFixed(2),
          priceUsd: '',
          timestamp: activity.timestamp,
          daysAgo,
          currencySymbol: activity.price.currency.symbol,
          currencyContract: activity.price.currency.contract,
          priceDecimal,
        };
      }

      return null;
    } catch (error: any) {
      logger.warn(`🍷 Failed to get last sale/mint for ${ensName}:`, error.message);
      return null;
    }
  }

  /**
   * Fetch ENS names currently held by an address via Grails search API.
   * Replaces OpenSea getENSHoldings — no API key needed, no rate limiting.
   * Returns name + clubs for each holding (clubs come free in the search response).
   */
  static async getENSHoldings(
    address: string,
    options: { limit?: number; maxPages?: number } = {}
  ): Promise<{ names: { name: string; clubs: string[] }[]; incomplete: boolean; totalFetched: number }> {
    const limit = Math.min(options.limit || 50, 50);
    const maxPages = options.maxPages || 20;
    const apiBase = GrailsApiService.getApiBase();

    logger.info(`📚 Fetching ENS holdings for ${address} (limit: ${limit}, maxPages: ${maxPages})`);

    const allNames: { name: string; clubs: string[] }[] = [];
    let page = 1;
    let incomplete = false;

    try {
      while (page <= maxPages) {
        const url = `${apiBase}/search?limit=${limit}&page=${page}&filters[owner]=${address.toLowerCase()}`;
        logger.debug(`   Page ${page}: Fetching from Grails...`);

        const response = await axios.get<GrailsApiResponse>(url, {
          timeout: 15000,
          headers: { 'Accept': 'application/json', 'User-Agent': 'ENS-TwitterBot/2.0' },
        });

        if (!response.data.success || !response.data.data?.results) {
          logger.warn(`   Grails search returned unsuccessful response on page ${page}`);
          break;
        }

        const results = response.data.data.results;
        if (results.length === 0) {
          logger.debug(`   Page ${page}: No more names, stopping pagination`);
          break;
        }

        const holdings = results
          .filter((r: any) => r.name && r.name.endsWith('.eth'))
          .map((r: any) => ({ name: r.name as string, clubs: (r.clubs as string[]) || [] }));
        allNames.push(...holdings);

        logger.debug(`   Page ${page}: Fetched ${holdings.length} ENS names (total: ${allNames.length})`);

        if (!response.data.data.pagination.hasNext) break;
        page++;

        await new Promise(resolve => setTimeout(resolve, 200));
      }

      if (page > maxPages) incomplete = true;

      const pagesFetched = page > maxPages ? maxPages : page;
      logger.info(`✅ ENS holdings fetch complete: ${allNames.length} names across ${pagesFetched} pages${incomplete ? ' (incomplete)' : ''}`);
      return { names: allNames, incomplete, totalFetched: allNames.length };

    } catch (error: any) {
      logger.error(`❌ Error fetching ENS holdings for ${address}: ${error.message}`);
      return { names: allNames, incomplete: true, totalFetched: allNames.length };
    }
  }

  /**
   * Fetch active listings for an ENS name from Grails API
   * Uses the /names/{name} endpoint (same as grails-app frontend)
   * Static method — no service instance needed, just an HTTP call
   */
  static async getListingsForName(name: string): Promise<GrailsActiveListing[]> {
    try {
      const cleanName = name.endsWith('.eth') ? name : `${name}.eth`;
      const apiBase = GrailsApiService.getApiBase();
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
        .map((l: any) => {
          const currencySymbol = CURRENCY_MAP[l.currency_address?.toLowerCase()] || 'UNKNOWN';
          const decimals = CURRENCY_DECIMALS[currencySymbol] || 18;
          const priceDecimal = parseFloat(l.price) / Math.pow(10, decimals);
          return {
            price: priceDecimal,
            priceWei: l.price, // l.price IS the wei value (no separate price_wei on listings)
            currencySymbol,
            source: l.source || 'grails',
          };
        });

      logger.info(`🍷 Found ${activeListings.length} active Grails listing(s) for ${cleanName}`);
      return activeListings;

    } catch (error: any) {
      logger.warn(`🍷 Failed to fetch Grails listings for ${name}:`, error.message);
      return [];
    }
  }
}

