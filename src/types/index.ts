import { Pool } from 'pg';

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
  logIndex?: number; // Event index within transaction (for unique identification)
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
  // Fee recipient tracking (broker/referral)
  feeRecipientAddress?: string;
  feeAmountWei?: string;
  feePercent?: number;
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

// Name Research Record (cached research for ENS names)
export interface NameResearch {
  id?: number;
  ensName: string;                    // The ENS name (e.g., "vitalik.eth")
  researchText: string;               // Research content from web search
  researchedAt: string;               // When research was last performed
  updatedAt: string;                  // Last update timestamp
  source: string;                     // 'web_search', 'migrated', 'manual'
  createdAt?: string;
}

// AI Reply Record
export interface AIReply {
  id?: number;
  saleId?: number;                    // Reference to processed_sales
  registrationId?: number;            // Reference to ens_registrations
  bidId?: number;                     // Reference to ens_bids
  originalTweetId: string;            // The tweet we're replying to
  replyTweetId?: string;              // The AI-generated reply tweet ID
  transactionType: 'sale' | 'registration' | 'bid';
  transactionHash?: string;           // Optional: bids don't have txHash until accepted
  modelUsed: string;                  // e.g., "gpt-4o", "gpt-4o-mini"
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  costUsd: number;
  replyText: string;                  // The generated reply content
  nameResearchId?: number;            // Reference to name_research table
  nameResearch?: string;              // DEPRECATED: Legacy field, use nameResearchId
  status: 'pending' | 'posted' | 'failed' | 'skipped';
  errorMessage?: string;
  createdAt?: string;
  postedAt?: string;
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
  siwe: {
    adminWhitelist: string[];
    sessionSecret: string;
    domain: string;
  };
  quicknode: {
    salesWebhookSecret: string;
    registrationsWebhookSecret: string;
  };
  opensea?: {
    apiKey: string;
  };
  ensSubgraph: {
    primaryUrl: string;
  };
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

// SIWE Session Record
export interface SiweSession {
  id?: number;
  address: string;
  sessionId: string;
  createdAt: string;
  expiresAt: string;
}

// Database Interface
export interface IDatabaseService {
  pgPool: Pool; // Connection pool for external libraries like connect-pg-simple
  initialize(): Promise<void>;
  insertSale(sale: Omit<ProcessedSale, 'id'>): Promise<number>;
  isSaleProcessed(transactionHash: string, logIndex: number): Promise<boolean>;
  getRecentSales(limit?: number): Promise<ProcessedSale[]>;
  getSaleById(id: number): Promise<ProcessedSale | null>;
  getUnpostedSales(limit?: number, maxAgeHours?: number): Promise<ProcessedSale[]>;
  markAsPosted(id: number, tweetId: string): Promise<void>;
  getSystemState(key: string): Promise<string | null>;
  setSystemState(key: string, value: string): Promise<void>;
  // AI Configuration methods
  isAIRepliesEnabled(): Promise<boolean>;
  setAIRepliesEnabled(enabled: boolean): Promise<void>;
  getAIModel(): Promise<string>;
  setAIModel(model: string): Promise<void>;
  getAITemperature(): Promise<number>;
  setAITemperature(temperature: number): Promise<void>;
  getAIMaxTokens(): Promise<number>;
  setAIMaxTokens(maxTokens: number): Promise<void>;
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
  insertRegistrationWithSourceTracking(registration: Omit<ENSRegistration, 'id'>, source: 'quicknode' | 'moralis'): Promise<number>;
  isRegistrationProcessed(tokenId: string): Promise<boolean>;
  getRecentRegistrations(limit?: number): Promise<ENSRegistration[]>;
  getRegistrationById(id: number): Promise<ENSRegistration | null>;
  getUnpostedRegistrations(limit?: number, maxAgeHours?: number): Promise<ENSRegistration[]>;
  markRegistrationAsPosted(id: number, tweetId: string): Promise<void>;
  
  // ENS bids methods
  insertBid(bid: Omit<ENSBid, 'id'>): Promise<number>;
  isBidProcessed(bidId: string): Promise<boolean>;
  getRecentBids(limit?: number): Promise<ENSBid[]>;
  getUnpostedBids(limit?: number, maxAgeHours?: number): Promise<ENSBid[]>;
  markBidAsPosted(id: number, tweetId: string): Promise<void>;
  markBidAsFailed(id: number, reason: string): Promise<void>;
  getBidById(id: number): Promise<ENSBid | null>;
  
  // Bid blacklist methods (name-based)
  getBidBlacklist(): Promise<string[]>;
  setBidBlacklist(names: string[]): Promise<void>;
  addToBidBlacklist(name: string): Promise<void>;
  removeFromBidBlacklist(name: string): Promise<void>;
  isNameBlacklisted(name: string): Promise<boolean>;
  
  // Address blacklist methods (wallet-based, for wash trade filtering)
  getAddressBlacklist(): Promise<string[]>;
  setAddressBlacklist(addresses: string[]): Promise<void>;
  addToAddressBlacklist(address: string): Promise<void>;
  removeFromAddressBlacklist(address: string): Promise<void>;
  isAddressBlacklisted(address: string): Promise<boolean>;
  
  // Price tier methods
  getPriceTiers(transactionType?: string): Promise<PriceTier[]>;
  updatePriceTier(transactionType: string, tierLevel: number, minUsd: number, maxUsd: number | null): Promise<void>;
  getPriceTierForAmount(transactionType: string, usdAmount: number): Promise<PriceTier | null>;
  getLastProcessedBidTimestamp(): Promise<number>;
  setLastProcessedBidTimestamp(timestamp: number): Promise<void>;
  
  // SIWE admin session methods
  createAdminSession(session: Omit<SiweSession, 'id'>): Promise<void>;
  getAdminSession(sessionId: string): Promise<SiweSession | null>;
  deleteAdminSession(sessionId: string): Promise<void>;
  cleanupExpiredSessions(): Promise<void>;
  
  // Name Research methods
  getNameResearch(ensName: string): Promise<NameResearch | null>;
  insertNameResearch(research: Omit<NameResearch, 'id' | 'createdAt' | 'updatedAt'>): Promise<number>;
  updateNameResearch(ensName: string, researchText: string): Promise<void>;
  
  // AI Reply methods
  insertAIReply(reply: Omit<AIReply, 'id' | 'createdAt' | 'postedAt'>): Promise<number>;
  getAIReplyBySaleId(saleId: number): Promise<AIReply | null>;
  getAIReplyByRegistrationId(registrationId: number): Promise<AIReply | null>;
  getAIReplyByBidId(bidId: number): Promise<AIReply | null>;
  getAIReplyById(replyId: number): Promise<AIReply | null>;
  getRecentAIReplies(limit?: number): Promise<AIReply[]>;
  updateAIReplyTweetId(id: number, replyTweetId: string): Promise<void>;
  updateAIReplyStatus(id: number, status: AIReply['status'], errorMessage?: string): Promise<void>;
  
  // Real-time notification trigger methods
  setupSaleNotificationTriggers(): Promise<void>;
  setupRegistrationNotificationTriggers(): Promise<void>;
  setupBidNotificationTriggers(): Promise<void>;
  setupAIReplyNotificationTriggers(): Promise<void>; // Phase 3.4
  checkSaleNotificationTriggers(): Promise<boolean>;
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
  sourceDomain?: string;   // e.g., "grails.app"
  sourceName?: string;     // e.g., "Grails"
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
