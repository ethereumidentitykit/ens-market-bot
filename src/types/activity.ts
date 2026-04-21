/**
 * Shared token activity format used across all data processing services.
 * Represents a single on-chain event (sale, mint, transfer, bid, listing, etc.)
 * with normalized pricing and metadata.
 */
export interface TokenActivity {
  type: 'mint' | 'sale' | 'transfer' | 'ask' | 'bid' | 'ask_cancel' | 'bid_cancel' | 'renewal';
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
