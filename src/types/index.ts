import { Pool } from 'pg';
import {
  GrailsMarketAnalytics,
  GrailsRegistrationAnalytics,
  GrailsTopSale,
  GrailsTopRegistration,
  GrailsTopOffer,
  GrailsVolumeChart,
  GrailsSalesChart,
  GrailsVolumeDistribution,
  GrailsSearchName,
} from './bids';
import { TwitterV2Tweet, TwitterPublicMetrics } from './twitter';

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
  priceAmount: string;
  priceUsd?: string;
  currencySymbol?: string;
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
  ownerAddress: string;    // Address that received the ENS name
  executorAddress?: string; // Transaction executor (may differ from owner for gifted registrations)
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

// ENS Renewal Record
// Renewals follow the same pattern as sales (dedup on transaction_hash + log_index)
// rather than registrations (dedup on token_id), because the same name can be
// renewed many times. A single bulk-renewal transaction emits many NameRenewed
// events; we store one row per name and aggregate at the tx level for tweets.
export interface ENSRenewal {
  id?: number;
  transactionHash: string;
  contractAddress: string;  // ENS ETH Registrar Controller address
  tokenId: string;          // keccak256 hash of ENS name
  logIndex: number;         // Event index within transaction (for unique identification)
  ensName: string;          // The ENS name (e.g., "hsueh")
  fullName: string;         // Full ENS name (e.g., "hsueh.eth")
  ownerAddress?: string;    // Current owner at time of renewal (lookup may fail → null)
  renewerAddress: string;   // Address that paid for the renewal (= tx.from); may differ from owner for gift renewals
  costWei: string;          // Cost in wei
  costEth?: string;         // Cost in ETH (calculated)
  costUsd?: string;         // Cost in USD (if available)
  durationSeconds?: number; // Renewal length added (nullable — derived from new vs. previous expires if available)
  blockNumber: number;
  blockTimestamp: string;
  processedAt: string;
  // ENS Metadata
  image?: string;           // ENS NFT image URL
  description?: string;     // ENS description
  // Tweet tracking — set on ALL rows for a tx when the tx is tweeted, sharing the same tweet_id
  tweetId?: string;
  posted: boolean;
  // Timestamps
  expiresAt?: string;       // When the renewal expires (new expiry after this renewal)
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
//
// Renewals are tx-keyed (renewalTxHash) instead of row-keyed because a single
// bulk-renewal tx may contain 100+ rows in ens_renewals, but only one AI reply
// is generated per tx (matching the per-tx tweet model).
//
// Exactly one of: saleId, registrationId, bidId, renewalTxHash must be non-null.
// This is enforced at the DB layer by the check_transaction_ref CHECK constraint.
export interface AIReply {
  id?: number;
  saleId?: number;                    // Reference to processed_sales
  registrationId?: number;            // Reference to ens_registrations
  bidId?: number;                     // Reference to ens_bids
  renewalTxHash?: string;             // Tx hash for renewals (per-tx, not per-row)
  originalTweetId: string;            // The tweet we're replying to
  replyTweetId?: string;              // The AI-generated reply tweet ID
  transactionType: 'sale' | 'registration' | 'bid' | 'renewal';
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

export interface PreviousReply {
  replyText: string;
  transactionType: 'sale' | 'registration' | 'bid' | 'renewal';
  tokenName: string | null;
  createdAt: string;
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
  siwe: {
    adminWhitelist: string[];
    sessionSecret: string;
    domain: string;
  };
  quicknode: {
    salesWebhookSecret: string;
    registrationsWebhookSecret: string;
    renewalsWebhookSecret: string;
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
  insertRegistrationWithSourceTracking(registration: Omit<ENSRegistration, 'id'>, source: string): Promise<number>;
  isRegistrationProcessed(tokenId: string): Promise<boolean>;
  getRecentRegistrations(limit?: number): Promise<ENSRegistration[]>;
  getRegistrationById(id: number): Promise<ENSRegistration | null>;
  getUnpostedRegistrations(limit?: number, maxAgeHours?: number): Promise<ENSRegistration[]>;
  markRegistrationAsPosted(id: number, tweetId: string): Promise<void>;

  // ENS renewal methods
  // Tx-aware: a single bulk-renewal tx contains many rows (one per name renewed),
  // and the unit-of-work for tweets/AI replies is the tx, not the row.
  insertRenewal(renewal: Omit<ENSRenewal, 'id'>): Promise<number>;
  insertRenewalsBatch(renewals: Omit<ENSRenewal, 'id'>[]): Promise<number[]>; // Batched per-tx; fires statement-level trigger once
  isRenewalProcessed(transactionHash: string, logIndex: number): Promise<boolean>;
  getRenewalById(id: number): Promise<ENSRenewal | null>;
  getRenewalsByTxHash(txHash: string): Promise<ENSRenewal[]>;       // All rows for a tx
  getRecentRenewals(limit?: number): Promise<ENSRenewal[]>;
  getUnpostedRenewalTxHashes(limit?: number, maxAgeHours?: number): Promise<string[]>; // Distinct tx_hashes with at least one unposted row in window
  markRenewalTxAsPosted(txHash: string, tweetId: string): Promise<void>;            // Updates ALL rows for the tx in one statement

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
  getAIReplyByRenewalTxHash(txHash: string): Promise<AIReply | null>;
  getAIReplyById(replyId: number): Promise<AIReply | null>;
  getRecentAIReplies(limit?: number): Promise<AIReply[]>;
  getRecentPostedReplies(limit?: number): Promise<PreviousReply[]>;
  getRepliesByAddress(address: string, limit?: number): Promise<PreviousReply[]>;
  updateAIReplyTweetId(id: number, replyTweetId: string): Promise<void>;
  updateAIReplyStatus(id: number, status: AIReply['status'], errorMessage?: string): Promise<void>;
  
  // Real-time notification trigger methods
  setupSaleNotificationTriggers(): Promise<void>;
  setupRegistrationNotificationTriggers(): Promise<void>;
  setupBidNotificationTriggers(): Promise<void>;
  setupRenewalNotificationTriggers(): Promise<void>; // Statement-level triggers; one notify per tx_hash
  setupAIReplyNotificationTriggers(): Promise<void>; // Phase 3.4
  checkSaleNotificationTriggers(): Promise<boolean>;

  // Weekly summary methods (Friday market recap thread)
  insertWeeklySummary(summary: Omit<WeeklySummary, 'id' | 'createdAt' | 'updatedAt'>): Promise<number>;
  /** Partial update — only the provided fields are written. `tweets` and
   *  `snapshotData` are JSONB and will be replaced wholesale when present. */
  updateWeeklySummary(id: number, updates: Partial<WeeklySummary>): Promise<void>;
  /** The single in-flight pending row for the current week, or null. Returns
   *  null if there's no pending row at all (regardless of week). */
  getCurrentPendingWeeklySummary(): Promise<WeeklySummary | null>;
  /** The most recent posted (or partial_posted) summary whose week_start is
   *  strictly before `beforeDate`. Used to load the previous-week snapshot
   *  for week-over-week deltas. */
  getLastPostedWeeklySummary(beforeDate: Date): Promise<WeeklySummary | null>;
  getWeeklySummariesHistory(limit?: number): Promise<WeeklySummary[]>;

  // Weekly summary aggregation helpers (Phase 3.1)
  // ─────────────────────────────────────────────────
  /**
   * All bot-posted items in the window — posted transactions (one per row,
   * except renewals which aggregate per-tx) plus posted AI replies. Each item
   * includes the full constructed text content. Renewals are aggregated by
   * tx_hash because the unit-of-work for tweets is the tx, not the row (a
   * single bulk-renewal tx becomes one tweet). Window filter uses `updated_at`
   * for transactions (= when we marked posted) and `posted_at` for AI replies.
   * Returned newest-first.
   */
  getWeeklyTweetsAndReplies(start: Date, end: Date): Promise<WeeklyBotPost[]>;

  /**
   * Aggregated renewal stats for the window, plus the top-N renewal rows by
   * per-name cost. Window filter uses `block_timestamp` (the on-chain renewal
   * time, not when/whether we tweeted it).
   */
  getWeeklyRenewalsStats(start: Date, end: Date, topN?: number): Promise<WeeklyRenewalsStats>;

  /**
   * Top-N addresses by combined ETH volume across buys + sells + registrations
   * + renewals in the window. Bids are intentionally NOT included (per plan).
   * For registrations, attribute cost to the EXECUTOR (the wallet that paid),
   * which equals owner_address when no separate executor was set. `ensName` is
   * left null — the caller (aggregator) enriches via ENSWorkerService.
   * Window filter uses `block_timestamp`.
   *
   * @param excludeRenewals (TEMP) When true, omits the renewals UNION from
   *   the activity CTE entirely so renewals don't contribute to ranking.
   *   Used by the weekly summary feature while we have a known data gap on
   *   the renewals side. Defaults false.
   */
  getWeeklyTopParticipants(
    start: Date,
    end: Date,
    topN?: number,
    excludeRenewals?: boolean,
  ): Promise<WeeklyTopParticipant[]>;

  /**
   * Wash-trade signals for the window — pulled raw, the LLM decides whether
   * and how to surface them in the thread. Two sources:
   *   - `blacklistMatches`: sales where buyer OR seller is in the address
   *     blacklist (filter window: `block_timestamp`). Returns full count + sum
   *     across the window, plus the first `salesLimit` sales for LLM context.
   *   - `aiReplyWashMentions`: AI replies whose `reply_text` matches a
   *     word-boundary `wash` (case-insensitive; PG `~*` with `\m...\M`). Filter
   *     window: `posted_at`. Returns full count plus the first `repliesLimit`
   *     replies for LLM context.
   */
  getWeeklyWashSignals(
    start: Date,
    end: Date,
    salesLimit?: number,
    repliesLimit?: number,
  ): Promise<WeeklyWashSignals>;
}

// ENS Bids Types
export interface ENSBid {
  id?: number;
  bidId: string;           // Marketplace order ID
  contractAddress: string; // ENS contract address
  tokenId?: string;        // ENS token ID (extracted from tokenSetId)
  
  // Bid Details  
  makerAddress: string;    // Bidder address (hex only)
  takerAddress?: string;   // Usually 0x000... for active bids
  status: string;          // active, filled, cancelled, expired
  
  // Pricing  
  priceRaw: string;        // Raw wei/token amount
  priceDecimal: string;    // Decimal amount (e.g., "0.05")
  priceUsd?: string | null; // USD value
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

// ─────────────────────────────────────────────────────────────────────────────
// Weekly Market Summary types
// ─────────────────────────────────────────────────────────────────────────────
//
// Lifecycle:
//   pending  → row inserted by the 19:00 generation job (Friday Madrid time)
//   posted   → all tweets in the thread posted successfully
//   failed   → generation itself failed (no tweets exist on Twitter for this row)
//   discarded → admin discarded the pending summary via the dashboard
//   partial_posted → some thread tweets posted, some failed mid-stream; the
//                    `tweets[]` array carries `postedTweetId` for the ones that
//                    landed and `null` for the ones that didn't
export type WeeklySummaryStatus =
  | 'pending'
  | 'posted'
  | 'failed'
  | 'discarded'
  | 'partial_posted';

/**
 * The five lanes of the weekly summary thread. Each lane has a dedicated job
 * so the thread reads predictably each week. Order matters — the LLM must
 * return tweets in this exact order, enforced by the JSON schema and by the
 * post-parse validator in `OpenAIService.validateWeeklyTweets`.
 */
export type WeeklyTweetSection =
  | 'headline'         // T1: punchy lead-in, ideally <280 chars, GrailsAI Weekly ✨ header
  | 'by_the_numbers'   // T2: sales/regs/bids volumes + counts, premiums paid, ETH context, WoW delta
  | 'spotlight'        // T3: dynamic — names to watch (default), engaging bot tweet, hot category, etc.
  | 'community_pulse'  // T4: broad sentiment from ENS chatter + average bot engagement
  | 'top_player';      // T5: climactic actor reveal — picks from top-3 candidates by combined volume

/**
 * One LLM-generated tweet in the weekly thread, before posting. Returned by
 * `OpenAIService.generateWeeklySummary`. The `section` tag both validates
 * order and lets the dashboard / image template label each preview tweet.
 */
export interface WeeklyThreadTweet {
  section: WeeklyTweetSection;
  text: string;
}

/**
 * One tweet in the stored thread — extends the generated shape with the
 * posted Twitter ID once published. `postedTweetId` is set by the posting
 * service after each successful post (immediately, so a partial failure
 * mid-thread doesn't lose state).
 */
export interface WeeklySummaryTweet extends WeeklyThreadTweet {
  postedTweetId?: string | null;
}

/**
 * Row in the `weekly_summaries` table — 1:1 with the schema (snake_case ↔
 * camelCase). `snapshotData` is stored as JSONB; `tweets` is JSONB; everything
 * else is a scalar column.
 */
export interface WeeklySummary {
  id?: number;
  weekStart: string;                   // ISO 8601, UTC
  weekEnd: string;                     // ISO 8601, UTC
  status: WeeklySummaryStatus;
  generatedAt: string;
  postedAt?: string | null;
  snapshotData: WeeklySnapshotData;    // JSONB column
  llmContextText?: string | null;      // Full prompt sent to the LLM (debug)
  tweets: WeeklySummaryTweet[];        // JSONB column; ordered top → bottom of thread
  errorMessage?: string | null;
  modelUsed?: string | null;
  promptTokens?: number | null;
  completionTokens?: number | null;
  /** Combined LLM + Twitter cost for the run. Twitter component is the
   *  upper-bound cost (24h dedup may make actual bill smaller). */
  costUsd?: number | null;
  createdAt?: string;
  updatedAt?: string;
}

/**
 * The headline numbers we persist to `snapshot_data` after a successful post.
 * Loaded by next week's run to compute deltas. Keep this lean — anything not
 * needed for week-over-week comparison should NOT live here.
 *
 * If you add a field, the first run after deployment will see `undefined` for
 * it on the previous-week snapshot. Treat all fields as optional from the
 * comparison consumer's perspective.
 */
export interface WeeklySnapshotData {
  weekStart: string;
  weekEnd: string;

  // Sales (from analytics/market.volume)
  salesCount: number;
  salesVolumeEth: number;
  salesVolumeUsd: number;
  uniqueBuyers: number;
  uniqueSellers: number;
  uniqueNamesSold: number;

  // Registrations (from analytics/registrations.summary)
  registrationCount: number;
  registrationCostEth: number;
  registrationCostUsd: number;
  premiumRegistrations: number;
  uniqueRegistrants: number;

  // Renewals (from self DB; Grails has no renewals endpoints)
  renewalCount: number;       // Distinct ens_renewals rows (= names renewed)
  renewalTxCount: number;     // Distinct transactions
  renewalVolumeEth: number;
  renewalVolumeUsd: number;

  // Offers + market state (from analytics/market)
  offersCount: number;
  activeListings: number;
  activeOffers: number;

  // ETH price at week end (Alchemy historical)
  ethPriceUsd: number | null;
}

// ─── Self-DB sub-shapes (populated by Phase 3 helpers) ───────────────────────

/**
 * Aggregated renewal stats for the week. Returned by
 * `DatabaseService.getWeeklyRenewalsStats`.
 */
export interface WeeklyRenewalsStats {
  count: number;             // Total ens_renewals rows in window
  txCount: number;           // Distinct tx_hashes
  totalVolumeEth: number;
  totalVolumeUsd: number;
  topByVolume: ENSRenewal[]; // Top N rows by per-name cost (limit set by caller)
}

/**
 * One participant in the weekly top-N list. We compute combined per-address
 * volume across buys / sells / registrations / renewals, then surface the
 * breakdown so the LLM can pick the most interesting story (not necessarily
 * the highest total).
 */
export interface WeeklyTopParticipant {
  address: string;
  ensName: string | null;        // Resolved at aggregation time when known
  /** Twitter handle from ENS records (`com.twitter`), no `@` prefix. Null if
   *  the address has no ENS twitter record OR resolution failed. Used by the
   *  Top Player tweet (T5) so the lead-in can `@`-mention the actual person. */
  twitterHandle: string | null;
  buys: { count: number; volumeEth: number; volumeUsd: number };
  sells: { count: number; volumeEth: number; volumeUsd: number };
  registrations: { count: number; costEth: number; costUsd: number };
  renewals: { count: number; costEth: number; costUsd: number };
  totalEth: number;              // Ranking key
  totalUsd: number;
}

/**
 * Wash-trade detection signals for the week. Pulled raw — the LLM decides if
 * and how to surface them in the thread.
 */
export interface WeeklyWashSignals {
  blacklistMatches: {
    count: number;
    volumeEth: number;
    volumeUsd: number;
    sales: ProcessedSale[];   // First N sales for context (limit set by caller)
  };
  aiReplyWashMentions: {
    count: number;
    replies: AIReply[];       // First N AI replies that mentioned 'wash'
  };
}

/**
 * One bot-posted item in the weekly self-tweet feed. RAW text, no compression.
 *
 * `type` distinguishes between transaction tweets (sale/registration/bid/renewal)
 * and AI replies (which are threaded children of transaction tweets). For
 * transactions, `tweetId` is the bot's own tweet id; for AI replies it's the
 * `reply_tweet_id`. `text` is the actual text we posted (or generated for
 * ai_replies).
 *
 * `metrics` is filled in for own tweets when we batch-fetch via
 * `getTweetsWithMetrics`. Not all rows will have metrics (e.g. ai_replies
 * within the bot's own thread cost the same to fetch — we DO fetch metrics on
 * those — but if the API call fails for a batch we leave `metrics` undefined).
 */
export interface WeeklyBotPost {
  type: 'sale' | 'registration' | 'bid' | 'renewal' | 'ai_reply';
  postedAt: string;             // ISO 8601
  tweetId: string;              // Always non-null in the feed (we filter rows without it)
  text: string;                 // The exact tweet text (or generated reply text for ai_replies)
  conversationId?: string | null;
  // Cross-references for joining back to source rows:
  sourceId?: number;            // Numeric row id for sale/registration/bid/ai_reply
  sourceTxHash?: string;        // Tx hash for renewals (per-tx, not per-row)
  metrics?: TwitterPublicMetrics; // Filled by batch hydrate; undefined on failure
}

/**
 * The canonical aggregated data shape consumed by the LLM (Phase 4) and the
 * future weekly-summary image template (v2). Built by `WeeklySummaryDataService`
 * (Phase 3) from Grails + self-DB + Twitter + Alchemy sources.
 *
 * Each Grails source is `null` on transport failure; each list source returns
 * `[]` rather than `null` so the consumer doesn't need a separate "empty vs
 * unavailable" check for those. The `partialSourceFailures` array lists the
 * names of any source that returned null/threw, so the prompt can be honest
 * with the LLM about what's missing.
 */
export interface WeeklySummaryData {
  // Time window
  weekStart: string;
  weekEnd: string;

  // ── Grails sources ────────────────────────────────────────────────────────
  marketAnalytics: GrailsMarketAnalytics | null;
  registrationAnalytics: GrailsRegistrationAnalytics | null;
  topSales: GrailsTopSale[];
  topRegistrations: GrailsTopRegistration[];
  topOffers: GrailsTopOffer[];
  volumeChart: GrailsVolumeChart | null;
  salesChart: GrailsSalesChart | null;
  volumeDistribution: GrailsVolumeDistribution | null;
  premiumByWatchers: GrailsSearchName[];
  graceByWatchers: GrailsSearchName[];

  // ── Self-DB sources ───────────────────────────────────────────────────────
  renewalsStats: WeeklyRenewalsStats;
  topParticipants: WeeklyTopParticipant[];
  washSignals: WeeklyWashSignals;
  botPosts: WeeklyBotPost[];

  // ── Twitter sources ───────────────────────────────────────────────────────
  /**
   * Bot's own tweets posted in the window WITH freshly fetched engagement
   * metrics. May overlap with `botPosts` rows for transaction tweets (we
   * include in both: `botPosts` for the LLM to read raw text and reference
   * cross-types, this list specifically for engagement-by-tweet analysis).
   */
  ownTweetsWithFreshMetrics: TwitterV2Tweet[];
  /**
   * Up to 100 third-party replies for each conversation (= each bot tweet)
   * that had reply_count > 0. The 100/conv cap is enforced upstream in
   * `TwitterService.getRepliesToTweet` to bound per-week cost.
   */
  thirdPartyReplies: Array<{ conversationId: string; replies: TwitterV2Tweet[] }>;
  ensTwitterChatter: TwitterV2Tweet[];

  // ── Alchemy ───────────────────────────────────────────────────────────────
  ethPriceNow: number | null;
  ethPrice7dAgo: number | null;

  // ── Comparison ────────────────────────────────────────────────────────────
  /** Snapshot of the previous week's posted summary; null on first run. */
  previousSnapshot: WeeklySnapshotData | null;

  // ── Aggregator metadata (for prompt + cost tracking) ─────────────────────
  /** Sum of TwitterReadResult.costUsd from all Twitter calls during this run. */
  twitterCostUsd: number;
  /** Names of sources whose fetch failed (so the prompt can be honest with the LLM). */
  partialSourceFailures: string[];
}
