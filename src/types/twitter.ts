/**
 * Twitter v2 API DTOs.
 *
 * These types live in the types/ directory rather than alongside `TwitterService`
 * so consumers (e.g. the weekly-summary `WeeklySummaryData` shape) can reference
 * them without importing from a service module.
 */

/**
 * Public-metrics block returned by Twitter v2 `tweet.fields=public_metrics`.
 * Shape is stable across owned-tweet and search endpoints.
 */
export interface TwitterPublicMetrics {
  retweet_count: number;
  reply_count: number;
  like_count: number;
  quote_count: number;
  bookmark_count: number;
  impression_count: number;
}

/**
 * Tweet shape returned by the v2 GET endpoints used by the weekly summary.
 *
 * `public_metrics` is only populated when `tweet.fields=public_metrics` is in
 * the request. `conversation_id` requires the same field flag. `author_id` is
 * always returned when a user-context token is used.
 *
 * `authorUsername` + `authorDisplayName` are NOT raw Twitter v2 fields — they
 * are joined client-side from `expansions=author_id&user.fields=name,username`
 * by the TwitterService methods that fetch tweets (search/recent, replies,
 * quote_tweets). Available on any TwitterV2Tweet returned by those methods;
 * may be undefined if the expansion failed or the tweet pre-dates the join.
 */
export interface TwitterV2Tweet {
  id: string;
  text: string;
  created_at?: string;          // ISO 8601 with Z
  conversation_id?: string;     // Top-of-thread tweet id (=== id for root tweets)
  author_id?: string;
  public_metrics?: TwitterPublicMetrics;
  authorUsername?: string;      // e.g. "vitalikbuterin" — no @ prefix
  authorDisplayName?: string;   // e.g. "vitalik.eth" — display name from profile
}

/**
 * Result wrapper for paid Twitter read methods. `costUsd` is the theoretical
 * billed amount given Twitter's pay-per-resource model — owned reads cost
 * $0.001/tweet, third-party (search/replies) cost $0.005/tweet. The 24h dedup
 * window can make the actual bill smaller; we always log the upper bound.
 */
export interface TwitterReadResult<T> {
  data: T;
  costUsd: number;
}
