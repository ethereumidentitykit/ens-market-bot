/**
 * Bid + Grails marketplace DTOs.
 *
 * These types live in the types/ directory rather than alongside service code
 * so that any service can consume them without creating reverse dependencies
 * (e.g., GrailsApiService → BidsProcessingService for TransformedBid).
 */

/**
 * Internal bid format produced by GrailsApiService and consumed by BidsProcessingService.
 * Single normalized shape for any bid source — keep this stable.
 */
export interface TransformedBid {
  bidId: string;
  contractAddress: string;
  tokenId: string | null;
  makerAddress: string;
  takerAddress: string;
  status: string;
  priceRaw: string;
  priceDecimal: string;
  priceUsd: string | null;
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
}

/**
 * Single record from Grails activity API.
 * Used for both offer_made and listed event types.
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

/**
 * Active listing returned by GrailsApiService.getListingsForName()
 */
export interface GrailsActiveListing {
  price: number;          // Decimal price (e.g. 0.5)
  priceWei: string;
  currencySymbol: string; // ETH, WETH, USDC, etc.
  source: string;         // e.g. "grails", "opensea"
}

/**
 * Simplified activity entry for club/category context in LLM prompts
 */
export interface ClubActivityEntry {
  name: string;
  eventType: 'sold' | 'bought' | 'mint';
  priceEth: number;
  priceToken: number;
  currencySymbol: string;
  timestamp: number;
  daysAgo: number;
}

/**
 * Stats tracking for GrailsApiService instance
 */
export interface GrailsServiceStats {
  totalFetched: number;
  totalStored: number;
  duplicates: number;
  errors: number;
  lastFetchTime: Date | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Grails analytics / charts / search response shapes (used by weekly-summary)
// ─────────────────────────────────────────────────────────────────────────────

/** GET /analytics/market — overview + volume + activity for the period */
export interface GrailsMarketAnalytics {
  period: string;
  overview: {
    total_names: number;
    active_listings: number;
    active_offers: number;
    total_watchers: number;
    total_views: number;
  };
  volume: {
    sales_count: number;
    total_volume_wei: string;
    avg_sale_price_wei: string;
    max_sale_price_wei: string;
    min_sale_price_wei: string;
    unique_names_sold: number;
    unique_buyers: number;
    unique_sellers: number;
  };
  activity: {
    views: number;
    watchlist_adds: number;
    votes: number;
    offers: number;
    listings: number;
  };
}

/** A single row in /analytics/registrations `by_length` */
export interface GrailsRegistrationLengthBucket {
  name_length: number;
  count: number;
  total_cost_wei: string;
  avg_cost_wei: string;
  avg_base_cost_wei: string;
  avg_premium_wei: string;
}

/** A single top-N record in /analytics/registrations `results` (page=1 required) */
export interface GrailsTopRegistration {
  id: number;
  name: string;
  registrant_address: string;
  owner_address: string;
  base_cost_wei: string;
  premium_wei: string;
  total_cost_wei: string;
  name_length: number;
  registration_date: string;
  clubs: string[] | null;
  source: string | null;
}

/** GET /analytics/registrations — summary + by_length (+ optional results when page=1) */
export interface GrailsRegistrationAnalytics {
  period: string;
  summary: {
    registration_count: number;
    total_base_cost_wei: string;
    total_premium_wei: string;
    total_cost_wei: string;
    avg_base_cost_wei: string;
    avg_premium_wei: string;
    avg_cost_wei: string;
    premium_registrations: number;
    unique_registrants: number;
  };
  by_length: GrailsRegistrationLengthBucket[];
  /** Top-N records sorted per query — only present when page=1 was provided */
  results?: GrailsTopRegistration[];
}

/** A single top-N record in /analytics/sales `results` */
export interface GrailsTopSale {
  id: number;
  ens_name_id: number;
  seller_address: string;
  buyer_address: string;
  sale_price_wei: string;
  currency_address: string;
  transaction_hash: string;
  block_number: string;
  source: string | null;
  sale_date: string;
  created_at: string;
  name: string;
  token_id: string;
  clubs: string[] | null;
  // listing_id, offer_id, order_hash, order_data, platform_fee_wei,
  // creator_fee_wei, metadata are present on the wire but not currently consumed.
}

/** A single top-N record in /analytics/offers `results` */
export interface GrailsTopOffer {
  id: number;
  ens_name_id: number;
  buyer_address: string;
  offer_amount_wei: string;
  currency_address: string;
  order_hash: string;
  status: string;
  created_at: string;
  expires_at: string;
  source: string | null;
  last_validated_at: string | null;
  unfunded_at: string | null;
  unfunded_reason: string | null;
  name: string;
  token_id: string;
  clubs: string[] | null;
  // order_data is present on the wire (full Seaport order) but not currently consumed.
}

/** GET /charts/volume and /charts/sales — daily-bucketed series for the period */
export interface GrailsChartPoint {
  date: string;          // ISO 8601 day boundary (UTC)
  total: string | number; // string for volume (wei), number for counts
  grails: string | number;
  opensea: string | number;
}

export interface GrailsVolumeChart {
  period: string;
  club: string | null;
  clubs: string[] | null;
  /** Each `total` is a wei string. */
  points: Array<{ date: string; total: string; grails: string; opensea: string }>;
}

export interface GrailsSalesChart {
  period: string;
  club: string | null;
  clubs: string[] | null;
  /** Each `total` is a sales count (number). */
  points: Array<{ date: string; total: number; grails: number; opensea: number }>;
}

/** GET /analytics/volume — distribution by price bucket */
export interface GrailsVolumeDistribution {
  period: string;
  distribution: Array<{
    price_range: string;       // e.g. "< 0.01 ETH", "0.1-0.5 ETH"
    sales_count: number;
    total_volume_wei: string;
  }>;
}

/** A single record in /search `results` (used for premium / grace lookups) */
export interface GrailsSearchName {
  id: number;
  name: string;
  token_id: string;
  owner: string;
  expiry_date: string;
  registration_date: string;
  creation_date: string;
  last_sale_date: string | null;
  last_sale_price: string | null;
  last_sale_currency: string | null;
  last_sale_price_usd: number | null;
  metadata: Record<string, any>;
  metadata_updated_at: string | null;
  clubs: string[] | null;
  club_ranks: Array<{ club: string; rank: number }> | null;
  has_numbers: boolean;
  has_emoji: boolean;
  listings: any[];
  upvotes: number;
  downvotes: number;
  net_score: number;
  watchers_count: number;
  is_user_watching: boolean;
  watchlist_record_id: number | null;
  highest_offer_wei: string | null;
  highest_offer_currency: string;
  highest_offer_id: number | null;
  view_count: number;
}

export interface GrailsSearchResponse {
  results: GrailsSearchName[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
    hasNext: boolean;
    hasPrev: boolean;
  };
}
