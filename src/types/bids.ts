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
