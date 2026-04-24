import axios from 'axios';
import { IDatabaseService } from '../types';
import { logger } from '../utils/logger';
import { TokenActivity } from '../types/activity';
import {
  TransformedBid,
  GrailsActivityRecord,
  GrailsOffer,
  GrailsApiResponse,
  GrailsActiveListing,
  ClubActivityEntry,
  GrailsServiceStats,
  GrailsMarketAnalytics,
  GrailsRegistrationAnalytics,
  GrailsTopRegistration,
  GrailsTopSale,
  GrailsTopOffer,
  GrailsVolumeChart,
  GrailsSalesChart,
  GrailsVolumeDistribution,
  GrailsSearchResponse,
  GrailsSearchName,
} from '../types/bids';
import {
  CURRENCY_MAP,
  CURRENCY_DECIMALS,
  CURRENCY_NAMES,
  ENS_NAMEWRAPPER,
  ENS_BASE_REGISTRAR,
} from '../utils/currencyConstants';

// Re-export for backward compatibility with any external callers
export type {
  GrailsActivityRecord,
  GrailsOffer,
  GrailsApiResponse,
  GrailsActiveListing,
  ClubActivityEntry,
  GrailsServiceStats,
  GrailsMarketAnalytics,
  GrailsRegistrationAnalytics,
  GrailsTopRegistration,
  GrailsTopSale,
  GrailsTopOffer,
  GrailsVolumeChart,
  GrailsSalesChart,
  GrailsVolumeDistribution,
  GrailsSearchResponse,
  GrailsSearchName,
};

/**
 * GrailsApiService
 * Fetches ENS offers from Grails marketplace REST API
 * Runs every minute to fetch aggregated offers from all marketplaces
 */
export class GrailsApiService {
  private databaseService: IDatabaseService;
  private baseUrl: string;

  private stats: GrailsServiceStats = {
    totalFetched: 0,
    totalStored: 0,
    duplicates: 0,
    errors: 0,
    lastFetchTime: null,
  };

  constructor(databaseService: IDatabaseService) {
    this.databaseService = databaseService;
    this.baseUrl = process.env.GRAILS_API_URL || 'https://api.grails.app/api/v1/activity';
    
    logger.info(`🍷 GrailsApiService initialized (endpoint: ${this.baseUrl})`);
  }

  /**
   * Fetch new offers from Grails API with timestamp-based cursor.
   * Uses 4-hour lookback cap and max 500 results (10 pages × 50).
   *
   * Returns offers plus the newest timestamp seen and a flag indicating whether
   * we hit the page cap. The CALLER is responsible for advancing the cursor
   * (via {@link setLastProcessedTimestamp}) only after offers have been
   * successfully processed — this prevents data loss on crash/processing failure.
   *
   * If the page cap is hit, the caller should advance the cursor only to the
   * OLDEST timestamp among offers actually processed, not the newest, to avoid
   * silently skipping offers that were past the cap.
   */
  async fetchNewOffers(): Promise<{
    offers: TransformedBid[];
    newestTimestamp: number;
    boundaryTimestamp: number;
    hitPageCap: boolean;
    oldestFetchedTimestamp: number | null;
  }> {
    const startTime = Date.now();
    logger.info('🍷 Starting Grails API fetch...');

    const lastTimestamp = await this.getLastProcessedTimestamp();
    const fourHoursAgo = Date.now() - (4 * 60 * 60 * 1000);
    const boundaryTimestamp = Math.max(lastTimestamp, fourHoursAgo);

    logger.info(`📈 Fetching offers newer than: ${new Date(boundaryTimestamp).toISOString()}`);

    const allOffers: GrailsOffer[] = [];
    let page = 1;
    const maxPages = 10; // Max 500 results (10 × 50)
    const limit = 50;
    let hasMore = true;
    let newestTimestamp = boundaryTimestamp;
    let oldestFetchedTimestamp: number | null = null;
    let hitBoundary = false;

    try {
      while (hasMore && page <= maxPages) {
        const url = `${this.baseUrl}?limit=${limit}&page=${page}&event_type=offer_made`;
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

        const newOffers = offers.filter(offer => {
          const offerTime = new Date(offer.created_at).getTime();

          if (offerTime > newestTimestamp) {
            newestTimestamp = offerTime;
          }
          if (oldestFetchedTimestamp === null || offerTime < oldestFetchedTimestamp) {
            oldestFetchedTimestamp = offerTime;
          }

          return offerTime > boundaryTimestamp;
        });

        allOffers.push(...newOffers);

        // Stop if we hit older offers (API returns newest first → reached boundary)
        if (newOffers.length < offers.length) {
          logger.debug(`🛑 Hit boundary timestamp, stopping pagination`);
          hitBoundary = true;
          hasMore = false;
        } else {
          hasMore = response.data.data.pagination?.hasNext ?? false;
          page++;
        }

        if (hasMore && page <= maxPages) {
          await new Promise(resolve => setTimeout(resolve, 500));
        }
      }

      const hitPageCap = !hitBoundary && page > maxPages;
      if (hitPageCap) {
        logger.warn(
          `⚠️  Hit page cap (${maxPages} pages, ${allOffers.length} offers) before reaching boundary timestamp. ` +
          `Cursor will only advance to oldest fetched offer to avoid skipping older data.`
        );
      }

      const transformResults = await Promise.allSettled(
        allOffers.map(offer => this.transformOffer(offer))
      );
      const transformedBids: TransformedBid[] = [];
      let transformFailures = 0;
      for (const result of transformResults) {
        if (result.status === 'fulfilled') {
          transformedBids.push(result.value);
        } else {
          transformFailures++;
          logger.warn(`⚠️ Skipping malformed offer: ${result.reason?.message || result.reason}`);
        }
      }
      if (transformFailures > 0) {
        logger.warn(`⚠️ ${transformFailures} offer(s) skipped due to malformed data`);
      }

      const duration = Date.now() - startTime;
      this.stats.totalFetched += allOffers.length;
      this.stats.lastFetchTime = new Date();

      logger.info(`✅ Grails fetch complete in ${duration}ms: ${allOffers.length} new offers from ${page} page(s)`);

      return {
        offers: transformedBids,
        newestTimestamp,
        boundaryTimestamp,
        hitPageCap,
        oldestFetchedTimestamp,
      };

    } catch (error: any) {
      this.stats.errors++;
      logger.error('❌ Grails API fetch failed:', error.message);
      return {
        offers: [],
        newestTimestamp: boundaryTimestamp,
        boundaryTimestamp,
        hitPageCap: false,
        oldestFetchedTimestamp: null,
      };
    }
  }

  /**
   * Public method for the scheduler to advance the cursor after successful processing.
   */
  async advanceCursor(timestamp: number): Promise<void> {
    await this.setLastProcessedTimestamp(timestamp);
    logger.info(`📍 Cursor advanced to: ${new Date(timestamp).toISOString()}`);
  }

  /**
   * Transform Grails offer to internal TransformedBid format.
   * Throws if the offer lacks a usable identifier — caller should catch
   * and skip the offer rather than store a malformed row.
   *
   * Validation rules for offer_id:
   * - Must be a positive integer (rejects undefined, null, '', 0, NaN, floats, negatives).
   * - Reason: bidId becomes `grails-{offer_id}` and is the dedup key. Loose values
   *   like '' or 0 would collide across distinct offers and silently drop bids.
   */
  private async transformOffer(offer: GrailsOffer): Promise<TransformedBid> {
    const now = Math.floor(Date.now() / 1000);

    const offerIdRaw = offer.metadata?.offer_id;
    const offerIdNum = typeof offerIdRaw === 'number' ? offerIdRaw : Number(offerIdRaw);
    if (!Number.isInteger(offerIdNum) || offerIdNum <= 0) {
      throw new Error(
        `Grails offer has invalid metadata.offer_id (raw=${JSON.stringify(offerIdRaw)}, ` +
        `activity_id=${offer.id}, name=${offer.name}, created_at=${offer.created_at})`
      );
    }
    const offerId = offerIdNum;

    const currencySymbol = this.getCurrencySymbol(offer.currency_address);
    const decimals = this.getCurrencyDecimals(currencySymbol);
    const priceDecimalFloat = Number(offer.price_wei) / Math.pow(10, decimals);

    const contractAddress = await this.resolveContractAddress(offer.token_id);

    return {
      bidId: `grails-${offerId}`, // Prefixed for deduplication
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
   * Get service status for admin dashboard.
   * `enabled` is always true here — if the service was disabled, this instance
   * wouldn't have been constructed (see index.ts startup gate).
   */
  getStatus(): {
    enabled: boolean;
    baseUrl: string;
    lastFetchTime: Date | null;
    stats: GrailsServiceStats;
  } {
    return {
      enabled: true,
      baseUrl: this.baseUrl,
      lastFetchTime: this.stats.lastFetchTime,
      stats: this.getStats(),
    };
  }

  private static getApiBase(): string {
    return process.env.GRAILS_API_URL
      ? process.env.GRAILS_API_URL.replace(/\/activity$/, '')
      : 'https://api.grails.app/api/v1';
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
        const url = `${apiBase}/activity/${encodeURIComponent(cleanName)}?limit=${limit}&page=${page}&event_type=bought&event_type=mint&event_type=renewal`;
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
   *
   * Fetches sold, bought, mint, and offer_made events:
   * - sold/bought: deduplicated by tx hash so each sale appears once
   * - mint:        deduplicated by tx hash (or activity row id fallback)
   * - offer_made:  deduplicated by offer_id (off-chain orders, no tx hash);
   *                used by processBiddingStats to derive bidding behavior signals
   *                (totals, recent bids, theme detection) for LLM context
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
        const url = `${apiBase}/activity/address/${address}?limit=${limit}&page=${page}&event_type=sold&event_type=bought&event_type=mint&event_type=offer_made&event_type=renewal`;
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
   *
   * Bid (offer_made) records are deduplicated by their offer_id (no transaction_hash since
   * offers are off-chain orders, not on-chain transactions).
   */
  private static deduplicateAndTransform(records: GrailsActivityRecord[], seen: Set<string> = new Set()): TokenActivity[] {
    const results: TokenActivity[] = [];

    for (const record of records) {
      // Pick a stable dedupe key based on event type:
      // - sold/bought: tx_hash (same sale appears as both events for involved address)
      // - offer_made: offer_id (off-chain, no tx hash)
      // - mint: tx_hash or activity row id as fallback
      let dedupeKey: string;
      if (record.event_type === 'offer_made') {
        const offerId = record.metadata?.offer_id;
        dedupeKey = offerId !== undefined && offerId !== null ? `offer-${offerId}` : `id-${record.id}`;
      } else {
        dedupeKey = record.transaction_hash || `id-${record.id}`;
      }
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);

      if (
        record.event_type === 'mint' ||
        record.event_type === 'bought' ||
        record.event_type === 'sold' ||
        record.event_type === 'offer_made' ||
        record.event_type === 'renewal'
      ) {
        results.push(GrailsApiService.toTokenActivity(record));
      }
    }

    return results;
  }

  /**
   * Transform a Grails activity record into the shared TokenActivity format.
   * Grails already resolves proxy contracts — addresses are truth.
   *
   * Address conventions per event_type:
   * - "bought":     actor=buyer,    counterparty=seller   → from=seller, to=buyer,   type='sale'
   * - "sold":       actor=seller,   counterparty=buyer    → from=seller, to=buyer,   type='sale'
   * - "mint":       actor=minter                          → from=0x0,    to=minter,  type='mint'
   * - "offer_made": actor=bidder    (no counterparty)     → from=bidder, to=0x0,     type='bid'
   *                 (Off-chain order; no on-chain tx hash. Used for bidding-stats analysis.)
   */
  static toTokenActivity(record: GrailsActivityRecord): TokenActivity {
    // Renewals and mints always use ETH (native payment, no ERC-20 currency address)
    const currencySymbol = (record.event_type === 'mint' || record.event_type === 'renewal')
      ? 'ETH'
      : CURRENCY_MAP[record.currency_address?.toLowerCase()] || 'UNKNOWN';
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
    } else if (record.event_type === 'renewal') {
      // Renewal: actor is the renewer (= tx.from, the wallet that paid).
      // No counterparty — renewals don't transfer ownership.
      fromAddress = record.actor_address;
      toAddress = record.actor_address; // Same address — no transfer
      activityType = 'renewal';
    } else if (record.event_type === 'bought') {
      fromAddress = record.counterparty_address || '0x0000000000000000000000000000000000000000';
      toAddress = record.actor_address;
      activityType = 'sale';
    } else if (record.event_type === 'offer_made') {
      // Bidder is the actor; no recipient (off-chain order)
      fromAddress = record.actor_address;
      toAddress = '0x0000000000000000000000000000000000000000';
      activityType = 'bid';
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
   * Looks up by name directly (no contract+tokenId needed).
   *
   * @param thresholdEth Minimum ETH-equivalent price below which historical events are filtered out.
   *                     For non-ETH currencies (USDC/USDT/DAI), `ethPriceUsd` MUST be provided to
   *                     convert to ETH-equivalent for comparison; otherwise stablecoin events bypass
   *                     the filter (fail-open).
   * @param ethPriceUsd  Current ETH/USD price for converting stablecoin amounts to ETH-equivalent.
   */
  static async getLastSaleOrMint(
    ensName: string,
    currentTxHash?: string,
    thresholdEth: number = 0.01,
    ethPriceUsd?: number
  ): Promise<{ type: 'sale' | 'mint'; priceAmount: string; priceUsd: string; timestamp: number; daysAgo: number; currencySymbol: string; currencyContract: string; priceDecimal: number } | null> {
    try {
      const result = await GrailsApiService.getNameActivity(ensName, { limit: 50, maxPages: 2 });

      for (const activity of result.activities) {
        if (currentTxHash && activity.txHash.toLowerCase() === currentTxHash.toLowerCase()) continue;
        if (!activity.price?.amount?.decimal || activity.price.amount.decimal <= 0) continue;

        const priceDecimal = activity.price.amount.decimal;
        const symbol = activity.price.currency.symbol?.toUpperCase();
        const isEthLike = symbol === 'ETH' || symbol === 'WETH';
        const isStablecoin = symbol === 'USDC' || symbol === 'USDT' || symbol === 'DAI';

        // Convert to ETH-equivalent for threshold comparison.
        // - ETH/WETH: use price directly
        // - Stablecoins: divide by ETH/USD price (if available)
        // - Unknown currencies: skip threshold check (fail-open)
        let ethEquivalent: number | null = priceDecimal;
        if (isStablecoin) {
          ethEquivalent = ethPriceUsd && ethPriceUsd > 0 ? priceDecimal / ethPriceUsd : null;
        } else if (!isEthLike) {
          ethEquivalent = null;
        }

        if (ethEquivalent !== null && ethEquivalent < thresholdEth) return null;

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
   * Fetch recent activity for a specific club/category.
   * Returns deduped sold+bought pairs and mints, limited to the most recent entries.
   */
  static async getClubActivity(
    clubSlug: string,
    options: { limit?: number } = {}
  ): Promise<ClubActivityEntry[]> {
    const limit = options.limit || 10;
    const apiBase = GrailsApiService.getApiBase();
    const url = `${apiBase}/activity?club=${encodeURIComponent(clubSlug)}&limit=${limit}&page=1&event_type=bought&event_type=mint&event_type=sold`;

    try {
      const response = await axios.get<GrailsApiResponse>(url, {
        timeout: 10000,
        headers: { 'Accept': 'application/json', 'User-Agent': 'ENS-TwitterBot/2.0' },
      });

      if (!response.data.success || !response.data.data?.results) {
        return [];
      }

      const seen = new Set<string>();
      const entries: ClubActivityEntry[] = [];

      for (const record of response.data.data.results) {
        const txKey = record.transaction_hash?.toLowerCase();
        if (txKey && seen.has(txKey)) continue;
        if (txKey) seen.add(txKey);

        const currencySymbol = record.event_type === 'mint'
          ? 'ETH'
          : CURRENCY_MAP[record.currency_address?.toLowerCase()] || 'UNKNOWN';
        const isEthLike = currencySymbol === 'ETH';
        const decimals = CURRENCY_DECIMALS[currencySymbol] || 18;
        const priceDecimal = Number(record.price_wei) / Math.pow(10, decimals);

        entries.push({
          name: record.name || 'unknown',
          eventType: record.event_type as 'sold' | 'bought' | 'mint',
          priceEth: isEthLike ? priceDecimal : 0,
          priceToken: !isEthLike ? priceDecimal : 0,
          currencySymbol,
          timestamp: new Date(record.created_at).getTime(),
          daysAgo: Math.floor((Date.now() - new Date(record.created_at).getTime()) / (1000 * 60 * 60 * 24)),
        });
      }

      return entries;
    } catch (error: any) {
      logger.warn(`[GrailsApiService] Failed to fetch club activity for ${clubSlug}: ${error.message}`);
      return [];
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

  /**
   * Fetch an offer's full Seaport order data to extract real validity timestamps.
   * The /activity?event_type=offer_made feed only provides created_at — actual
   * order startTime/endTime live on the /offers/{id} endpoint.
   *
   * @param offerId Numeric Grails offer ID (NOT the prefixed bidId)
   * @returns Unix timestamps in seconds, or null if unavailable
   */
  static async getOfferValidity(
    offerId: number | string
  ): Promise<{ validFrom: number; validUntil: number } | null> {
    try {
      const apiBase = GrailsApiService.getApiBase();
      const url = `${apiBase}/offers/${offerId}`;

      const response = await axios.get(url, {
        timeout: 8000,
        headers: {
          'Accept': 'application/json',
          'User-Agent': 'ENS-TwitterBot/2.0',
        },
      });

      const params = response.data?.data?.order_data?.parameters;
      if (!params?.startTime || !params?.endTime) {
        logger.debug(`🍷 Offer ${offerId} has no order_data.parameters.startTime/endTime`);
        return null;
      }

      const validFrom = parseInt(params.startTime, 10);
      const validUntil = parseInt(params.endTime, 10);

      if (!Number.isFinite(validFrom) || !Number.isFinite(validUntil)) {
        logger.warn(`🍷 Offer ${offerId} has non-numeric startTime/endTime: ${params.startTime}, ${params.endTime}`);
        return null;
      }

      return { validFrom, validUntil };
    } catch (error: any) {
      logger.debug(`🍷 Failed to fetch validity for offer ${offerId}: ${error.message}`);
      return null;
    }
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Analytics / charts / search methods (used by the weekly-summary feature).
  //
  // All return `null` on failure rather than throwing, so the weekly-summary
  // aggregator can `Promise.allSettled` everything and degrade gracefully if
  // any single source goes down. Failures are logged at warn level.
  //
  // GOTCHA: `analytics/registrations` only returns the top-N `results` array
  // when `page=1` is in the query string. Without it, only `summary` and
  // `by_length` come back. `analytics/sales` and `analytics/offers` return
  // `results` either way — registrations is the odd one out. See
  // shared/lessons.md for the full story.
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Shared helper for all analytics calls. 15s timeout, common headers, and
   * a uniform "unwrap `data` or null" path so each method below stays terse.
   */
  private static async fetchAnalytics<T>(path: string, params: Record<string, string | number>): Promise<T | null> {
    const apiBase = GrailsApiService.getApiBase();
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) qs.append(k, String(v));
    const url = `${apiBase}${path}?${qs.toString()}`;

    try {
      const response = await axios.get(url, {
        timeout: 15000,
        headers: { 'Accept': 'application/json', 'User-Agent': 'ENS-TwitterBot/2.0' },
      });

      if (!response.data?.success || !response.data?.data) {
        logger.warn(`🍷 Grails ${path} returned unsuccessful envelope`);
        return null;
      }

      return response.data.data as T;
    } catch (error: any) {
      logger.warn(`🍷 Grails ${path} failed: ${error.message}`);
      return null;
    }
  }

  /** GET /analytics/market — overview + volume + activity for the period. */
  static async getMarketAnalytics(period: '7d' = '7d'): Promise<GrailsMarketAnalytics | null> {
    return GrailsApiService.fetchAnalytics<GrailsMarketAnalytics>('/analytics/market', { period });
  }

  /**
   * GET /analytics/registrations — summary + by-length aggregates for the period.
   * Use {@link getTopRegistrations} when you also need the top-N records list.
   */
  static async getRegistrationAnalyticsSummary(period: '7d' = '7d'): Promise<GrailsRegistrationAnalytics | null> {
    return GrailsApiService.fetchAnalytics<GrailsRegistrationAnalytics>(
      '/analytics/registrations',
      { period },
    );
  }

  /**
   * GET /analytics/sales sorted by price desc — the top-N most expensive sales
   * of the period. Returns `[]` if the API succeeds with no results, `null`
   * only on transport/envelope failure.
   */
  static async getTopSales(period: '7d' = '7d', limit: number = 20): Promise<GrailsTopSale[] | null> {
    const data = await GrailsApiService.fetchAnalytics<{ results?: GrailsTopSale[] }>(
      '/analytics/sales',
      { period, sortBy: 'price', sortOrder: 'desc', limit, page: 1 },
    );
    return data?.results ?? (data ? [] : null);
  }

  /**
   * GET /analytics/registrations sorted by cost desc — the top-N most expensive
   * registrations of the period. Premium drops surface here naturally because
   * the cost includes both base + premium.
   *
   * Note: requires `page=1` to get the `results` array (Grails quirk).
   */
  static async getTopRegistrations(period: '7d' = '7d', limit: number = 20): Promise<GrailsTopRegistration[] | null> {
    const data = await GrailsApiService.fetchAnalytics<GrailsRegistrationAnalytics>(
      '/analytics/registrations',
      { period, sortBy: 'cost', sortOrder: 'desc', limit, page: 1 },
    );
    return data?.results ?? (data ? [] : null);
  }

  /**
   * GET /analytics/offers sorted by price desc — the top-N highest offers of
   * the period.
   */
  static async getTopOffers(period: '7d' = '7d', limit: number = 20): Promise<GrailsTopOffer[] | null> {
    const data = await GrailsApiService.fetchAnalytics<{ results?: GrailsTopOffer[] }>(
      '/analytics/offers',
      { period, sortBy: 'price', sortOrder: 'desc', limit, page: 1 },
    );
    return data?.results ?? (data ? [] : null);
  }

  /** GET /charts/volume — daily-bucketed volume series (each `total` is a wei string). */
  static async getVolumeChart(period: '7d' = '7d'): Promise<GrailsVolumeChart | null> {
    return GrailsApiService.fetchAnalytics<GrailsVolumeChart>('/charts/volume', { period });
  }

  /** GET /charts/sales — daily-bucketed sales-count series (each `total` is a number). */
  static async getSalesChart(period: '7d' = '7d'): Promise<GrailsSalesChart | null> {
    return GrailsApiService.fetchAnalytics<GrailsSalesChart>('/charts/sales', { period });
  }

  /** GET /analytics/volume — distribution of sales by price bucket. */
  static async getVolumeDistribution(period: '7d' = '7d'): Promise<GrailsVolumeDistribution | null> {
    return GrailsApiService.fetchAnalytics<GrailsVolumeDistribution>('/analytics/volume', { period });
  }

  /**
   * GET /search — top-N premium-decay names by watcher count. Used by the
   * weekly summary to surface "what people are watching while it bleeds price."
   */
  static async searchPremiumByWatchers(limit: number = 50): Promise<GrailsSearchName[] | null> {
    const data = await GrailsApiService.fetchAnalytics<GrailsSearchResponse>('/search', {
      'filters[status]': 'premium',
      sortBy: 'watchers_count',
      sortOrder: 'desc',
      limit,
      page: 1,
    });
    return data?.results ?? (data ? [] : null);
  }

  /**
   * GET /search — top-N grace-period names by watcher count. Used by the
   * weekly summary to surface names that are about to expire and are being watched.
   */
  static async searchGraceByWatchers(limit: number = 50): Promise<GrailsSearchName[] | null> {
    const data = await GrailsApiService.fetchAnalytics<GrailsSearchResponse>('/search', {
      'filters[status]': 'grace',
      sortBy: 'watchers_count',
      sortOrder: 'desc',
      limit,
      page: 1,
    });
    return data?.results ?? (data ? [] : null);
  }
}

