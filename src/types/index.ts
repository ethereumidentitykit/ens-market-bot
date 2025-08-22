// NFT Sales API Response Types
export interface NFTSale {
  marketplace: string;
  contractAddress: string;
  tokenId: string;
  quantity: string;
  buyerAddress: string;
  sellerAddress: string;
  taker: 'BUYER' | 'SELLER';
  sellerFee: {
    amount: string;
    symbol: string;
    decimals: number;
  };
  protocolFee: {
    amount: string;
    symbol: string;
    decimals: number;
  };
  royaltyFee: {
    amount: string;
    symbol: string;
    decimals: number;
  };
  blockNumber: number;
  blockTime: string;
  logIndex: number;
  bundleIndex: number;
  transactionHash: string;
}

export interface AlchemyNFTSalesResponse {
  nftSales: NFTSale[];
  pageKey?: string;
  validAt: {
    blockNumber: number;
    blockHash: string;
    blockTimestamp: string;
  };
}

export interface AlchemyPriceResponse {
  data: Array<{
    symbol: string;
    prices: Array<{
      currency: string;
      value: string;
      lastUpdatedAt: string;
    }>;
  }>;
}

// Price Tier Configuration
export interface PriceTier {
  id?: number;
  transactionType?: string;
  tierLevel: number;
  minUsd: number;
  maxUsd: number | null;
  description?: string;
  createdAt?: Date;
  updatedAt?: Date;
}

// Database Models
export interface ProcessedSale {
  id?: number;
  transactionHash: string;
  contractAddress: string;
  tokenId: string;
  marketplace: string;
  buyerAddress: string;
  sellerAddress: string;
  priceEth: string;
  priceUsd?: string;
  blockNumber: number;
  blockTimestamp: string;
  processedAt: string;
  tweetId?: string;
  posted: boolean;
  // Enhanced metadata fields
  collectionName?: string;
  collectionLogo?: string;
  nftName?: string;
  nftImage?: string;
  nftDescription?: string;
  marketplaceLogo?: string;
  currentUsdValue?: string;
  verifiedCollection?: boolean;
}

// ENS Registration Record
export interface ENSRegistration {
  id?: number;
  transactionHash: string;
  contractAddress: string;  // ENS ETH Registrar Controller address
  tokenId: string;         // keccak256 hash of ENS name
  ensName: string;         // The ENS name (e.g., "hsueh")
  fullName: string;        // Full ENS name (e.g., "hsueh.eth")
  ownerAddress: string;    // Address that registered the ENS
  costWei: string;         // Cost in wei
  costEth?: string;        // Cost in ETH (calculated)
  costUsd?: string;        // Cost in USD (if available)
  blockNumber: number;
  blockTimestamp: string;
  processedAt: string;
  // ENS Metadata
  image?: string;          // ENS NFT image URL
  description?: string;    // ENS description
  // Tweet tracking
  tweetId?: string;
  posted: boolean;
  // Timestamps
  expiresAt?: string;      // When the registration expires
  createdAt?: string;
  updatedAt?: string;
}

// Configuration
export interface Config {
  alchemy: {
    apiKey: string;
    baseUrl: string;
  };
  bitquery?: {
    token: string;
    baseUrl: string;
  };
  moralis?: {
    apiKey: string;
    baseUrl: string;
  };
  twitter: {
    apiKey: string;
    apiSecret: string;
    accessToken: string;
    accessTokenSecret: string;
  };

  contracts: string[];
  port: number;
  nodeEnv: string;
  logLevel: string;
  wethPriceMultiplier: number;
}

// Twitter Post Record
export interface TwitterPost {
  id?: number;
  saleId?: number;
  tweetId: string;
  tweetContent: string;
  postedAt: string;
  success: boolean;
  errorMessage?: string;
}

// Database Interface
export interface IDatabaseService {
  initialize(): Promise<void>;
  insertSale(sale: Omit<ProcessedSale, 'id'>): Promise<number>;
  isSaleProcessed(tokenId: string): Promise<boolean>;
  getRecentSales(limit?: number): Promise<ProcessedSale[]>;
  getUnpostedSales(limit?: number): Promise<ProcessedSale[]>;
  markAsPosted(id: number, tweetId: string): Promise<void>;
  getSystemState(key: string): Promise<string | null>;
  setSystemState(key: string, value: string): Promise<void>;
  getStats(): Promise<{
    totalSales: number;
    postedSales: number;
    unpostedSales: number;
    lastProcessedBlock: string | null;
  }>;
  // Twitter rate limiting methods
  recordTweetPost(post: Omit<TwitterPost, 'id'>): Promise<number>;
  getRecentTweetPosts(hoursBack?: number): Promise<TwitterPost[]>;
  getTweetPostsInLast24Hours(): Promise<number>;
  // Database management methods
  resetDatabase(): Promise<void>;
  migrateSchema(): Promise<void>;
  clearSalesTable(): Promise<void>;
  close(): Promise<void>;
  // Image storage methods
  storeGeneratedImage(filename: string, imageBuffer: Buffer, contentType?: string): Promise<void>;
  getGeneratedImage(filename: string): Promise<{ buffer: Buffer; contentType: string } | null>;
  cleanupOldImages(): Promise<void>;
  // ENS registration methods
  insertRegistration(registration: Omit<ENSRegistration, 'id'>): Promise<number>;
  isRegistrationProcessed(tokenId: string): Promise<boolean>;
  getRecentRegistrations(limit?: number): Promise<ENSRegistration[]>;
  getUnpostedRegistrations(limit?: number): Promise<ENSRegistration[]>;
  markRegistrationAsPosted(id: number, tweetId: string): Promise<void>;
  
  // ENS bids methods
  insertBid(bid: Omit<ENSBid, 'id'>): Promise<number>;
  isBidProcessed(bidId: string): Promise<boolean>;
  getRecentBids(limit?: number): Promise<ENSBid[]>;
  getUnpostedBids(limit?: number): Promise<ENSBid[]>;
  markBidAsPosted(id: number, tweetId: string): Promise<void>;
  
  // Price tier methods
  getPriceTiers(transactionType?: string): Promise<PriceTier[]>;
  updatePriceTier(transactionType: string, tierLevel: number, minUsd: number, maxUsd: number | null): Promise<void>;
  getPriceTierForAmount(transactionType: string, usdAmount: number): Promise<PriceTier | null>;
  getLastProcessedBidTimestamp(): Promise<number>;
  setLastProcessedBidTimestamp(timestamp: number): Promise<void>;
}

// ENS Bids Types
export interface ENSBid {
  id?: number;
  bidId: string;           // Magic Eden order ID
  contractAddress: string; // ENS contract address
  tokenId?: string;        // ENS token ID (extracted from tokenSetId)
  
  // Bid Details  
  makerAddress: string;    // Bidder address (hex only)
  takerAddress?: string;   // Usually 0x000... for active bids
  status: string;          // active, filled, cancelled, expired
  
  // Pricing  
  priceRaw: string;        // Raw wei/token amount
  priceDecimal: string;    // Decimal amount (e.g., "0.05")
  priceUsd?: string;       // USD value
  currencyContract: string; // Token contract address
  currencySymbol: string;  // WETH, USDC, etc.
  
  // Marketplace
  sourceDomain?: string;   // e.g., "opensea.io"
  sourceName?: string;     // e.g., "OpenSea"
  marketplaceFee?: number; // Fee basis points
  
  // Timestamps & Duration
  createdAtApi: string;    // API createdAt
  updatedAtApi: string;    // API updatedAt  
  validFrom: number;       // Unix timestamp bid becomes valid
  validUntil: number;      // Unix timestamp bid expires
  processedAt: string;     // When we processed this bid
  
  // ENS Metadata (from ENS service - stored during processing)
  ensName?: string;        // Resolved ENS name (e.g., "317.eth")
  nftImage?: string;
  nftDescription?: string;
  
  // Tweet Tracking
  tweetId?: string;
  posted: boolean;
  
  // Audit
  createdAt?: string;
  updatedAt?: string;
}

// Magic Eden API Response Types
export interface MagicEdenBidResponse {
  orders: MagicEdenBid[];
  continuation?: string;
}

export interface MagicEdenBid {
  id: string;
  kind: string;
  side: string;
  status: string;
  tokenSetId: string;
  tokenSetSchemaHash: string;
  contract: string;
  maker: string;
  taker: string;
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
  validFrom: number;
  validUntil: number;
  quantityFilled: string;
  quantityRemaining: string;
  criteria: {
    kind: string;
    data: {
      token: {
        tokenId: string;
        name?: string;
        image?: string;
      };
    };
  };
  source: {
    id: string;
    domain: string;
    name: string;
    icon: string;
    url: string;
  };
  feeBps: number;
  feeBreakdown: Array<{
    kind: string;
    recipient: string;
    bps: number;
  }>;
  expiration: number;
  isReservoir: boolean;
  createdAt: string;
  updatedAt: string;
}

// Bid Processing Stats
export interface BidProcessingStats {
  newBids: number;
  duplicates: number;
  filtered: number;
  errors: number;
  processedCount: number;
}

// API Response Types
export interface ApiResponse<T = any> {
  success: boolean;
  data?: T;
  error?: string;
  message?: string;
}
