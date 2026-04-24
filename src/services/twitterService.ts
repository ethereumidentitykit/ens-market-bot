import OAuth from 'oauth-1.0a';
import * as crypto from 'crypto-js';
import https from 'https';
import { config } from '../utils/config';
import { logger } from '../utils/logger';
import { APIToggleService } from './apiToggleService';
import { TwitterV2Tweet, TwitterReadResult } from '../types/twitter';

// Re-export for any existing consumers that still import from this module.
export type { TwitterV2Tweet, TwitterReadResult, TwitterPublicMetrics } from '../types/twitter';

export interface TwitterPostResult {
  success: boolean;
  tweetId?: string;
  postedText?: string;
  error?: string;
}

export interface TwitterUser {
  id: string;
  username: string;
  name: string;
}

export class TwitterService {
  private oauth: OAuth;
  private apiToggleService: APIToggleService;

  constructor() {
    this.apiToggleService = APIToggleService.getInstance();
    this.oauth = new OAuth({
      consumer: { 
        key: config.twitter.apiKey, 
        secret: config.twitter.apiSecret 
      },
      signature_method: 'HMAC-SHA1',
      hash_function(base_string: string, key: string): string {
        return crypto.HmacSHA1(base_string, key).toString(crypto.enc.Base64);
      },
    });
  }

  /**
   * Check if Twitter API is enabled via admin toggle
   */
  private checkApiEnabled(): boolean {
    if (!this.apiToggleService.isTwitterEnabled()) {
      logger.warn('Twitter API call blocked - API disabled via admin toggle');
      return false;
    }
    return true;
  }

  /**
   * Test Twitter API connection by verifying credentials
   */
  async testConnection(): Promise<{ success: boolean; user?: TwitterUser; error?: string }> {
    if (!this.checkApiEnabled()) {
      return { 
        success: false, 
        error: 'Twitter API is disabled via admin toggle' 
      };
    }

    try {
      logger.info('Testing Twitter API connection...');
      
      const requestData = {
        url: 'https://api.twitter.com/2/users/me',
        method: 'GET',
      };

      const token = {
        key: config.twitter.accessToken,
        secret: config.twitter.accessTokenSecret,
      };

      const authHeader = this.oauth.toHeader(this.oauth.authorize(requestData, token));
      
      const response = await this.makeRequest(requestData.url, 'GET', authHeader.Authorization);
      
      if (response.success && response.data) {
        const responseData = JSON.parse(response.data);
        if (responseData.data) {
          const user: TwitterUser = {
            id: responseData.data.id,
            username: responseData.data.username,
            name: responseData.data.name,
          };
          
          logger.info(`Twitter API connection successful - authenticated as @${user.username}`);
          return { success: true, user };
        } else {
          logger.error('Unexpected Twitter API response format:', response.data);
          return { success: false, error: 'Unexpected API response format' };
        }
      } else {
        logger.error('Twitter API connection failed:', response.error);
        return { success: false, error: response.error };
      }
    } catch (error: any) {
      logger.error('Error testing Twitter connection:', error.message);
      return { success: false, error: error.message };
    }
  }

  /**
   * Strip @mentions from tweet text, preserving the surrounding content.
   * Handles patterns like "name.eth @handle" → "name.eth" and standalone "@handle" → removed.
   */
  private stripMentions(text: string): string {
    return text
      .replace(/\s@\w+/g, '')   // " @handle" after other text
      .replace(/^@\w+\s?/gm, '') // "@handle" at start of a line
      .replace(/\n{3,}/g, '\n\n') // collapse excessive blank lines
      .trim();
  }

  /**
   * Post a tweet to Twitter.
   * If the tweet contains @mentions and the API rejects it, automatically
   * retries once with mentions stripped (Twitter spam crackdown workaround).
   */
  async postTweet(content: string, imageBuffer?: Buffer): Promise<TwitterPostResult> {
    if (!this.checkApiEnabled()) {
      return { 
        success: false, 
        error: 'Twitter API is disabled via admin toggle' 
      };
    }

    try {
      // Validate content is not empty
      if (content.trim().length === 0) {
        const error = 'Tweet content cannot be empty';
        logger.error(error);
        return { success: false, error };
      }

      logger.info(`Posting tweet: "${content.substring(0, 50)}..."${imageBuffer ? ' with image' : ''}`);

      // If image is provided, upload it first
      let mediaId: string | undefined;
      if (imageBuffer) {
        const uploadedMediaId = await this.uploadMedia(imageBuffer);
        if (!uploadedMediaId) {
          return { success: false, error: 'Failed to upload image' };
        }
        mediaId = uploadedMediaId;
      }

      const result = await this.postTweetRequest(content, mediaId);

      if (result.success) {
        return { ...result, postedText: content };
      }

      // If the tweet contained @mentions, retry without them
      const hasMentions = /@\w/.test(content);
      if (hasMentions) {
        const strippedContent = this.stripMentions(content);
        logger.warn(`Tweet with @mentions was rejected, retrying without mentions: "${strippedContent.substring(0, 50)}..."`);
        const retryResult = await this.postTweetRequest(strippedContent, mediaId);
        return retryResult.success ? { ...retryResult, postedText: strippedContent } : retryResult;
      }

      return result;
    } catch (error: any) {
      logger.error('Error posting tweet:', error.message);
      return { success: false, error: error.message };
    }
  }

  /**
   * Internal: send a single tweet POST request
   */
  private async postTweetRequest(content: string, mediaId?: string): Promise<TwitterPostResult> {
    const requestData = {
      url: 'https://api.twitter.com/2/tweets',
      method: 'POST',
    };

    const token = {
      key: config.twitter.accessToken,
      secret: config.twitter.accessTokenSecret,
    };

    const authHeader = this.oauth.toHeader(this.oauth.authorize(requestData, token));
    
    const tweetData: any = { text: content };
    if (mediaId) {
      tweetData.media = { media_ids: [mediaId] };
    }
    
    const postData = JSON.stringify(tweetData);
    
    const response = await this.makeRequest(
      requestData.url, 
      'POST', 
      authHeader.Authorization,
      postData,
      { 'Content-Type': 'application/json' }
    );
    
    if (response.success && response.data) {
      const responseData = JSON.parse(response.data);
      
      if (responseData.data && responseData.data.id) {
        const tweetId = responseData.data.id;
        logger.info(`Tweet posted successfully - ID: ${tweetId}`);
        return { success: true, tweetId };
      } else {
        logger.error('Unexpected Twitter API response format:', response.data);
        return { success: false, error: 'Unexpected API response format' };
      }
    } else {
      logger.error('Failed to post tweet:', response.error);
      return { success: false, error: response.error };
    }
  }

  /**
   * Post a threaded reply to an existing tweet.
   * If the reply contains @mentions and the API rejects it, automatically
   * retries once with mentions stripped.
   */
  async postReply(content: string, inReplyToTweetId: string): Promise<TwitterPostResult> {
    if (!this.checkApiEnabled()) {
      return { 
        success: false, 
        error: 'Twitter API is disabled via admin toggle' 
      };
    }

    try {
      // Validate content is not empty
      if (content.trim().length === 0) {
        const error = 'Reply content cannot be empty';
        logger.error(error);
        return { success: false, error };
      }

      // Validate reply-to tweet ID
      if (!inReplyToTweetId || inReplyToTweetId.trim().length === 0) {
        const error = 'Reply-to tweet ID cannot be empty';
        logger.error(error);
        return { success: false, error };
      }

      logger.info(`Posting reply to tweet ${inReplyToTweetId}: "${content.substring(0, 50)}..."`);

      const result = await this.postReplyRequest(content, inReplyToTweetId);

      if (result.success) {
        return { ...result, postedText: content };
      }

      // If the reply contained @mentions, retry without them
      const hasMentions = /@\w/.test(content);
      if (hasMentions) {
        const strippedContent = this.stripMentions(content);
        logger.warn(`Reply with @mentions was rejected, retrying without mentions: "${strippedContent.substring(0, 50)}..."`);
        const retryResult = await this.postReplyRequest(strippedContent, inReplyToTweetId);
        return retryResult.success ? { ...retryResult, postedText: strippedContent } : retryResult;
      }

      return result;
    } catch (error: any) {
      logger.error('Error posting reply:', error.message);
      return { success: false, error: error.message };
    }
  }

  /**
   * Internal: send a single reply POST request
   */
  private async postReplyRequest(content: string, inReplyToTweetId: string): Promise<TwitterPostResult> {
    const requestData = {
      url: 'https://api.twitter.com/2/tweets',
      method: 'POST',
    };

    const token = {
      key: config.twitter.accessToken,
      secret: config.twitter.accessTokenSecret,
    };

    const authHeader = this.oauth.toHeader(this.oauth.authorize(requestData, token));
    
    const tweetData: any = {
      text: content,
      reply: {
        in_reply_to_tweet_id: inReplyToTweetId
      }
    };
    
    const postData = JSON.stringify(tweetData);
    
    const response = await this.makeRequest(
      requestData.url, 
      'POST', 
      authHeader.Authorization,
      postData,
      { 'Content-Type': 'application/json' }
    );
    
    if (response.success && response.data) {
      const responseData = JSON.parse(response.data);
      
      if (responseData.data && responseData.data.id) {
        const tweetId = responseData.data.id;
        logger.info(`Reply posted successfully - ID: ${tweetId} (in reply to: ${inReplyToTweetId})`);
        return { success: true, tweetId };
      } else {
        logger.error('Unexpected Twitter API response format:', response.data);
        return { success: false, error: 'Unexpected API response format' };
      }
    } else {
      logger.error('Failed to post reply:', response.error);
      return { success: false, error: response.error };
    }
  }

  /**
   * Upload media to Twitter
   */
  private async uploadMedia(imageBuffer: Buffer): Promise<string | null> {
    try {
      logger.info('Uploading media to Twitter...');
      
      const requestData = {
        url: 'https://upload.twitter.com/1.1/media/upload.json',
        method: 'POST',
      };

      const token = {
        key: config.twitter.accessToken,
        secret: config.twitter.accessTokenSecret,
      };

      const authHeader = this.oauth.toHeader(this.oauth.authorize(requestData, token));
      
      const response = await this.uploadMediaRequest(
        requestData.url,
        authHeader.Authorization,
        imageBuffer
      );
      
      if (response.success && response.data) {
        const responseData = JSON.parse(response.data);
        
        if (responseData.media_id_string) {
          const mediaId = responseData.media_id_string;
          logger.info(`Media uploaded successfully - ID: ${mediaId}`);
          return mediaId;
        } else {
          logger.error('Unexpected media upload response format:', response.data);
          return null;
        }
      } else {
        logger.error('Failed to upload media:', response.error);
        return null;
      }
    } catch (error: any) {
      logger.error('Error uploading media:', error.message);
      return null;
    }
  }

  /**
   * Make multipart form request for media upload
   */
  private uploadMediaRequest(
    url: string,
    authHeader: string,
    imageBuffer: Buffer
  ): Promise<{ success: boolean; data?: string; error?: string }> {
    return new Promise((resolve) => {
      const urlObj = new URL(url);
      const boundary = `----formdata-twitter-${Date.now()}`;
      
      // Create multipart form data
      const formData = Buffer.concat([
        Buffer.from(`--${boundary}\r\n`),
        Buffer.from('Content-Disposition: form-data; name="media"; filename="image.png"\r\n'),
        Buffer.from('Content-Type: image/png\r\n\r\n'),
        imageBuffer,
        Buffer.from(`\r\n--${boundary}--\r\n`)
      ]);
      
      const options = {
        hostname: urlObj.hostname,
        path: urlObj.pathname + urlObj.search,
        method: 'POST',
        headers: {
          'Authorization': authHeader,
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
          'Content-Length': formData.length.toString(),
          'User-Agent': 'NFT-Sales-Bot/1.0',
        },
      };

      const req = https.request(options, (res) => {
        let data = '';
        
        res.on('data', (chunk) => {
          data += chunk;
        });
        
        res.on('end', () => {
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
            resolve({ success: true, data });
          } else {
            const error = `HTTP ${res.statusCode}: ${data}`;
            logger.error(`Twitter media upload error: ${error}`);
            resolve({ success: false, error });
          }
        });
      });

      req.on('error', (err) => {
        const error = `Request error: ${err.message}`;
        logger.error(`Twitter media upload request error: ${error}`);
        resolve({ success: false, error });
      });

      req.write(formData);
      req.end();
    });
  }

  /**
   * Make HTTP request with OAuth authentication
   */
  private makeRequest(
    url: string, 
    method: 'GET' | 'POST', 
    authHeader: string,
    postData?: string,
    additionalHeaders?: Record<string, string>
  ): Promise<{ success: boolean; data?: string; error?: string }> {
    return new Promise((resolve) => {
      const urlObj = new URL(url);
      
      const options = {
        hostname: urlObj.hostname,
        path: urlObj.pathname + urlObj.search,
        method,
        headers: {
          'Authorization': authHeader,
          'User-Agent': 'NFT-Sales-Bot/1.0',
          ...additionalHeaders,
        } as Record<string, string>,
      };

      if (postData) {
        options.headers['Content-Length'] = Buffer.byteLength(postData).toString();
      }

      const req = https.request(options, (res) => {
        let data = '';
        
        res.on('data', (chunk) => {
          data += chunk;
        });
        
        res.on('end', () => {
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
            resolve({ success: true, data });
          } else {
            const error = `HTTP ${res.statusCode}: ${data}`;
            logger.error(`Twitter API error: ${error}`);
            resolve({ success: false, error });
          }
        });
      });

      req.on('error', (err) => {
        const error = `Request error: ${err.message}`;
        logger.error(`Twitter API request error: ${error}`);
        resolve({ success: false, error });
      });

      if (postData) {
        req.write(postData);
      }
      
      req.end();
    });
  }

  // ───────────────────────────────────────────────────────────────────────────
  // v2 read methods (used by weekly-summary).
  //
  // Cost model (per Twitter pay-per-use, Apr 2026):
  //   - owned reads (own tweets, hydrate own metrics, /users/me): $0.001 / tweet
  //   - third-party reads (search results, replies): $0.005 / tweet
  //
  // All methods log the upper-bound cost on success. The 24h dedup window can
  // bring the actual bill lower; we always log the upper bound. Each method
  // returns `{ data, costUsd }` so the weekly aggregator can sum spend.
  //
  // Failures degrade to `{ data: emptyShape, costUsd: 0 }` rather than throwing —
  // weekly-summary uses Promise.allSettled and a single API outage shouldn't
  // crash the run. Errors are logged at warn level.
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Cached own-user lookup. Cleared only on process restart. Stores both id
   * AND username — username is needed by the weekly summary's prompt builder
   * to strip self-mentions from third-party reply text. The /2/users/me
   * endpoint returns both in one call so caching together is free.
   */
  private ownUserCache: { id: string; username: string; name: string } | null = null;

  /**
   * GET helper that signs the URL+query with OAuth 1.0a (user context) and
   * sends the request. The OAuth signature MUST include the query params
   * (oauth-1.0a does this when `data` is passed alongside the bare base URL),
   * and the actual HTTP request MUST go to the URL WITH the query string.
   */
  private async signedGet(
    baseUrl: string,
    params: Record<string, string | number | undefined> = {},
  ): Promise<{ success: boolean; json?: any; error?: string }> {
    // Strip undefined params and stringify the rest.
    const cleanParams: Record<string, string> = {};
    for (const [k, v] of Object.entries(params)) {
      if (v === undefined || v === null) continue;
      cleanParams[k] = String(v);
    }

    const qs = new URLSearchParams(cleanParams).toString();
    const fullUrl = qs ? `${baseUrl}?${qs}` : baseUrl;

    const token = {
      key: config.twitter.accessToken,
      secret: config.twitter.accessTokenSecret,
    };

    // For OAuth 1.0a, sign against the bare base URL + the params dict.
    const authHeader = this.oauth.toHeader(
      this.oauth.authorize({ url: baseUrl, method: 'GET', data: cleanParams }, token),
    );

    const response = await this.makeRequest(fullUrl, 'GET', authHeader.Authorization);
    if (!response.success || !response.data) {
      return { success: false, error: response.error };
    }

    try {
      return { success: true, json: JSON.parse(response.data) };
    } catch (err: any) {
      return { success: false, error: `JSON parse failed: ${err.message}` };
    }
  }

  /**
   * Get the bot's own Twitter user info (id + username + display name) via
   * /2/users/me. Cached for the lifetime of the process — the bot is a
   * single account; these values never change.
   *
   * Cost: $0.001 on first call, $0 on cached subsequent calls.
   */
  async getOwnUser(): Promise<{ id: string; username: string; name: string } | null> {
    if (this.ownUserCache) {
      return this.ownUserCache;
    }
    if (!this.checkApiEnabled()) return null;

    const result = await this.signedGet('https://api.twitter.com/2/users/me');
    if (!result.success || !result.json?.data?.id) {
      logger.warn(`[Twitter] getOwnUser failed: ${result.error || 'no data.id in response'}`);
      return null;
    }

    const data = result.json.data;
    this.ownUserCache = {
      id: data.id as string,
      username: (data.username as string) ?? '',
      name: (data.name as string) ?? '',
    };
    logger.info(
      `[Twitter] Own user resolved: id=${this.ownUserCache.id} @${this.ownUserCache.username} ("${this.ownUserCache.name}") (cost ~$0.001)`,
    );
    return this.ownUserCache;
  }

  /**
   * Convenience wrapper — same data as `getOwnUser` but returns just the id.
   * Kept for backward compatibility with existing call sites.
   */
  async getOwnUserId(): Promise<string | null> {
    return (await this.getOwnUser())?.id ?? null;
  }

  /**
   * Helper: given a search/recent or quote_tweets response with `expansions=author_id`,
   * builds a Map of author_id → {username, name} from the `includes.users`
   * array, then enriches each tweet's `authorUsername` + `authorDisplayName`
   * fields. Returns a new array (does not mutate input). Tweets whose author
   * isn't in `includes.users` (rare — deleted/protected accounts) keep
   * undefined author fields.
   */
  private enrichTweetsWithAuthors(json: any, tweets: TwitterV2Tweet[]): TwitterV2Tweet[] {
    const usersArr = json?.includes?.users;
    if (!Array.isArray(usersArr)) return tweets;
    const userById = new Map<string, { username: string; name: string }>();
    for (const u of usersArr) {
      if (u?.id && u.username) {
        userById.set(u.id, { username: u.username, name: u.name ?? '' });
      }
    }
    return tweets.map(t => {
      if (!t.author_id) return t;
      const author = userById.get(t.author_id);
      if (!author) return t;
      return { ...t, authorUsername: author.username, authorDisplayName: author.name };
    });
  }

  /**
   * Fetch the bot's own tweets posted at or after `startTime` (ISO 8601, Z),
   * up to `limit` total tweets. Paginates internally via `pagination_token`
   * with `max_results=100` per page (the v2 cap).
   *
   * Each tweet includes `public_metrics`, `created_at`, and `conversation_id`.
   *
   * Cost: $0.001 per returned tweet (owned-read rate).
   */
  async getOwnTweetsSince(
    startTime: string,
    limit: number = 100,
  ): Promise<TwitterReadResult<TwitterV2Tweet[]>> {
    if (!this.checkApiEnabled()) return { data: [], costUsd: 0 };

    const userId = await this.getOwnUserId();
    if (!userId) return { data: [], costUsd: 0 };

    const all: TwitterV2Tweet[] = [];
    let paginationToken: string | undefined;
    let pageCount = 0;
    const maxPages = 20; // Hard safety cap; 20 pages × 100 = 2000 tweets max

    while (all.length < limit && pageCount < maxPages) {
      const remaining = limit - all.length;
      const pageSize = Math.min(100, Math.max(remaining, 5)); // v2 requires max_results in [5, 100]

      const result = await this.signedGet(
        `https://api.twitter.com/2/users/${userId}/tweets`,
        {
          start_time: startTime,
          max_results: pageSize,
          'tweet.fields': 'public_metrics,created_at,conversation_id',
          pagination_token: paginationToken,
        },
      );

      if (!result.success) {
        logger.warn(`[Twitter] getOwnTweetsSince page ${pageCount + 1} failed: ${result.error}`);
        break;
      }

      const pageTweets: TwitterV2Tweet[] = result.json?.data ?? [];
      all.push(...pageTweets);
      pageCount++;

      paginationToken = result.json?.meta?.next_token;
      if (!paginationToken || pageTweets.length === 0) break;
    }

    const trimmed = all.slice(0, limit);
    const costUsd = trimmed.length * 0.001;
    logger.info(
      `[Twitter] getOwnTweetsSince fetched ${trimmed.length} own tweet(s) ` +
        `from ${pageCount} page(s) since ${startTime} (cost ~$${costUsd.toFixed(3)})`,
    );
    return { data: trimmed, costUsd };
  }

  /**
   * Hydrate `public_metrics` (and other fields) for an arbitrary list of tweet
   * IDs. Batched at 100 per request (v2 cap on the `ids` parameter). Used when
   * we need fresh engagement numbers for tweets we already know about (e.g.,
   * the bot's own historical tweets pulled from our DB).
   *
   * Cost: logged at the OWNED-read rate ($0.001/tweet). If the caller passes
   * IDs the authenticated account does NOT own, Twitter actually charges the
   * THIRD-PARTY rate ($0.005/tweet). This happens in dev where the auth token
   * belongs to a testing account but the DB tweet IDs are from production —
   * actual bill will be ~5x our logged estimate. Acceptable for v1 since the
   * dollar diff at our volume is ~$0.20/wk; revisit if it becomes material.
   */
  async getTweetsWithMetrics(tweetIds: string[]): Promise<TwitterReadResult<TwitterV2Tweet[]>> {
    if (!this.checkApiEnabled()) return { data: [], costUsd: 0 };
    if (tweetIds.length === 0) return { data: [], costUsd: 0 };

    const all: TwitterV2Tweet[] = [];
    for (let i = 0; i < tweetIds.length; i += 100) {
      const batch = tweetIds.slice(i, i + 100);

      const result = await this.signedGet('https://api.twitter.com/2/tweets', {
        ids: batch.join(','),
        'tweet.fields': 'public_metrics,created_at,conversation_id',
      });

      if (!result.success) {
        logger.warn(
          `[Twitter] getTweetsWithMetrics batch ${i / 100 + 1} failed: ${result.error}`,
        );
        continue;
      }

      const batchTweets: TwitterV2Tweet[] = result.json?.data ?? [];
      all.push(...batchTweets);
    }

    const costUsd = all.length * 0.001;
    logger.info(
      `[Twitter] getTweetsWithMetrics hydrated ${all.length}/${tweetIds.length} tweet(s) ` +
        `(cost ~$${costUsd.toFixed(3)})`,
    );
    return { data: all, costUsd };
  }

  /**
   * Fetch up to `maxResults` (max 100) third-party replies in a conversation,
   * via /2/tweets/search/recent with `query=conversation_id:X`. The cap of 100
   * is by design — one search-recent call per conversation bounds the runtime
   * cost on viral threads.
   *
   * Cost: $0.005 per returned tweet (third-party-read rate).
   */
  async getRepliesToTweet(
    conversationId: string,
    maxResults: number = 100,
  ): Promise<TwitterReadResult<TwitterV2Tweet[]>> {
    if (!this.checkApiEnabled()) return { data: [], costUsd: 0 };

    const capped = Math.min(Math.max(maxResults, 10), 100); // v2 search recent: [10, 100]
    const result = await this.signedGet('https://api.twitter.com/2/tweets/search/recent', {
      query: `conversation_id:${conversationId}`,
      max_results: capped,
      'tweet.fields': 'author_id,created_at,public_metrics,conversation_id',
      expansions: 'author_id',
      'user.fields': 'name,username',
    });

    if (!result.success) {
      logger.warn(`[Twitter] getRepliesToTweet(${conversationId}) failed: ${result.error}`);
      return { data: [], costUsd: 0 };
    }

    const rawReplies: TwitterV2Tweet[] = result.json?.data ?? [];
    const replies = this.enrichTweetsWithAuthors(result.json, rawReplies);
    const costUsd = replies.length * 0.005;
    logger.info(
      `[Twitter] getRepliesToTweet(${conversationId}) fetched ${replies.length} repl(ies) ` +
        `(cost ~$${costUsd.toFixed(3)})`,
    );
    return { data: replies, costUsd };
  }

  /**
   * One short search for general ENS chatter on Twitter — used as broad context
   * for the weekly summary. Excludes retweets and restricts to English. The
   * query is intentionally simple in v1; we'll expand or vary it in a follow-up
   * if the signal turns out to be too noisy or too sparse.
   *
   * Cost: $0.005 per returned tweet (third-party-read rate). With max_results=100
   * the worst-case cost is ~$0.50 per call.
   */
  async searchEnsContent(maxResults: number = 100): Promise<TwitterReadResult<TwitterV2Tweet[]>> {
    if (!this.checkApiEnabled()) return { data: [], costUsd: 0 };

    // Query design notes:
    //   - Twitter search ignores periods, so the old `".eth"` clause was just
    //     matching `eth` (= every Ethereum-related tweet). Useless signal.
    //   - We anchor on @-mentions of @ensdomains and the bare token `ensdomains`
    //     to catch official-account references.
    //   - Phrase queries `"ENS domain"`, `"ENS name"`, `"ENS subname"` catch
    //     organic discussion of the protocol/product without matching the
    //     unrelated ENS acronyms (Eyewear News Service, etc).
    //   - `-is:retweet` so we get original takes, not amplification.
    //   - `-is:reply` filters out reply-spam — we want top-level discussion,
    //     not threading noise. `/search/recent` is already 7-day windowed.
    //   - lang:en for the LLM's prompt budget; broaden later if needed.
    //
    // Spam filtering + engagement sort happen post-fetch (see below) — Twitter
    // v2 search has no `sortBy=engagement` parameter, so we fetch by recency,
    // drop 3+ @-mention spam, and sort client-side by an engagement score.
    const query = '(@ensdomains OR ensdomains OR "ENS domain" OR "ENS domains" OR "ENS name" OR "ENS names" OR "ENS subname" OR "ENS subnames") -is:retweet -is:reply lang:en';

    const capped = Math.min(Math.max(maxResults, 10), 100);
    const result = await this.signedGet('https://api.twitter.com/2/tweets/search/recent', {
      query,
      max_results: capped,
      'tweet.fields': 'author_id,created_at,public_metrics,conversation_id,entities',
      expansions: 'author_id',
      'user.fields': 'name,username',
    });

    if (!result.success) {
      logger.warn(`[Twitter] searchEnsContent failed: ${result.error}`);
      return { data: [], costUsd: 0 };
    }

    const rawTweets: TwitterV2Tweet[] = result.json?.data ?? [];
    const allTweets = this.enrichTweetsWithAuthors(result.json, rawTweets);
    // We pay for what the API returned, not what we keep — log full cost.
    const costUsd = allTweets.length * 0.005;

    // Spam filter: drop tweets that @-mention 3 or more accounts. These are
    // almost always tagging-storm spam (giveaways, mass-shoutouts, etc.) and
    // pollute the sentiment signal. Count by regex (entities.mentions would
    // be more accurate but isn't always populated; regex over text is robust).
    const mentionPattern = /@[A-Za-z0-9_]{1,15}/g;
    const filtered = allTweets.filter(t => {
      const matches = (t.text ?? '').match(mentionPattern);
      return !matches || matches.length < 3;
    });
    const droppedSpam = allTweets.length - filtered.length;

    // Sort by engagement (likes + replies + RTs + quotes), descending. We
    // don't include impressions because they're heavily skewed by virality
    // and would push outlier tweets way up. Best-engaged tweet at index 0.
    const engagement = (t: TwitterV2Tweet): number => {
      const m = t.public_metrics;
      if (!m) return 0;
      return m.like_count + m.reply_count + m.retweet_count + m.quote_count;
    };
    filtered.sort((a, b) => engagement(b) - engagement(a));

    logger.info(
      `[Twitter] searchEnsContent: ${allTweets.length} fetched, ${droppedSpam} dropped as 3+ @-mention spam, ` +
        `${filtered.length} kept and sorted by engagement (cost ~$${costUsd.toFixed(3)})`,
    );
    return { data: filtered, costUsd };
  }

  /**
   * Fetch up to `maxResults` (max 100) third-party QUOTE tweets of a given
   * tweet, via /2/tweets/:id/quote_tweets. Cap of 100 = one page. Used by
   * the weekly summary's thread-group restructure so the LLM sees full
   * conversation tree (parent → our reply → replies + quotes) per bot tweet.
   *
   * Cost: $0.005 per returned quote (third-party-read rate). Caller should
   * gate on `public_metrics.quote_count > 0` to avoid empty calls.
   */
  async getQuoteTweets(
    tweetId: string,
    maxResults: number = 100,
  ): Promise<TwitterReadResult<TwitterV2Tweet[]>> {
    if (!this.checkApiEnabled()) return { data: [], costUsd: 0 };

    const capped = Math.min(Math.max(maxResults, 10), 100);
    const result = await this.signedGet(
      `https://api.twitter.com/2/tweets/${tweetId}/quote_tweets`,
      {
        max_results: capped,
        'tweet.fields': 'author_id,created_at,public_metrics,conversation_id',
        expansions: 'author_id',
        'user.fields': 'name,username',
      },
    );

    if (!result.success) {
      logger.warn(`[Twitter] getQuoteTweets(${tweetId}) failed: ${result.error}`);
      return { data: [], costUsd: 0 };
    }

    const rawQuotes: TwitterV2Tweet[] = result.json?.data ?? [];
    const quotes = this.enrichTweetsWithAuthors(result.json, rawQuotes);
    const costUsd = quotes.length * 0.005;
    logger.info(
      `[Twitter] getQuoteTweets(${tweetId}) fetched ${quotes.length} quote(s) (cost ~$${costUsd.toFixed(3)})`,
    );
    return { data: quotes, costUsd };
  }

  /**
   * Validate Twitter API configuration
   */
  validateConfig(): { valid: boolean; missingFields: string[] } {
    const requiredFields = [
      { field: 'apiKey', value: config.twitter.apiKey },
      { field: 'apiSecret', value: config.twitter.apiSecret },
      { field: 'accessToken', value: config.twitter.accessToken },
      { field: 'accessTokenSecret', value: config.twitter.accessTokenSecret },
    ];

    const missingFields = requiredFields
      .filter(({ value }) => !value || value.trim().length === 0)
      .map(({ field }) => field);

    return {
      valid: missingFields.length === 0,
      missingFields,
    };
  }
}
