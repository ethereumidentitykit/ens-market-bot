/**
 * WeeklySummaryService — orchestrator for the Friday-cadence market recap.
 *
 * Three public actions, each invocable from the scheduler OR the admin dashboard:
 *
 *   generate(weekStart?, weekEnd?)  →  collects data, calls the LLM,
 *                                      stores the row as 'pending'.
 *   post(summaryId)                 →  posts the pending row as a Twitter
 *                                      thread, updating DB after every tweet
 *                                      so partial failures don't lose state.
 *                                      Idempotent — re-runs safely; resumes
 *                                      from where a partial run left off.
 *   discard(summaryId)              →  marks the row as 'discarded' (admin
 *                                      flow when the generated thread is bad).
 *
 * This layer is pure orchestration — all the real work lives in:
 *   WeeklySummaryDataService  (data collection)
 *   OpenAIService             (generation)
 *   TwitterService            (posting)
 *   DatabaseService           (persistence)
 */

import { logger } from '../utils/logger';
import {
  IDatabaseService,
  WeeklySummary,
  WeeklySummaryData,
  WeeklySummaryTweet,
  WeeklySnapshotData,
} from '../types';
import { WeeklySummaryDataService } from './weeklySummaryDataService';
import { OpenAIService } from './openaiService';
import { TwitterService } from './twitterService';

const ONE_WEEK_MS = 7 * 24 * 60 * 60 * 1000;

export class WeeklySummaryService {
  /**
   * Per-process in-flight set keyed by summary id. Prevents two concurrent
   * `post()` calls for the same summary from racing and double-posting tweets.
   * Single-instance deploys (which is production) only need an in-memory lock
   * — multi-instance would require a DB advisory lock, deferred to whenever
   * we're horizontally scaled.
   */
  private readonly inflightPostIds = new Set<number>();

  constructor(
    private readonly databaseService: IDatabaseService,
    private readonly weeklyDataService: WeeklySummaryDataService,
    private readonly openaiService: OpenAIService,
    private readonly twitterService: TwitterService,
  ) {}

  // ───────────────────────────────────────────────────────────────────────────
  // Public actions
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Collect data for the window, generate the thread via the LLM, persist as
   * 'pending'. Returns the new row id.
   *
   * If a pending row already exists for the SAME `week_start`, it's marked
   * 'discarded' first (the unique constraint on `week_start` would otherwise
   * reject the new insert; this is also the right behaviour from the admin's
   * perspective — clicking "Generate now" replaces any stale pending take).
   *
   * @param weekStart Window start (inclusive). Defaults to `weekEnd - 7d`.
   * @param weekEnd Window end (exclusive). Defaults to "now".
   * @throws on any unrecoverable error (LLM call fails, DB insert fails, etc.)
   */
  async generate(weekStart?: Date, weekEnd?: Date): Promise<number> {
    const end = weekEnd ?? new Date();
    const start = weekStart ?? new Date(end.getTime() - ONE_WEEK_MS);
    const startIso = start.toISOString();
    const endIso = end.toISOString();

    logger.info(`📰 [WeeklySummaryService] generate() window ${startIso} → ${endIso}`);
    const startedAt = Date.now();

    // Step 1: aggregate everything in parallel.
    const data = await this.weeklyDataService.collectWeeklyData(start, end);

    // Step 2: generate the 5-tweet thread via the LLM.
    const generated = await this.openaiService.generateWeeklySummary(data);

    // Step 3: build the snapshot we'll persist for next week's comparison.
    const snapshot = this.buildSnapshot(data);

    // Step 4: shape the tweets[] JSONB column. Each tweet starts unposted
    // (postedTweetId: null) and gets filled in by post().
    const tweets: WeeklySummaryTweet[] = generated.tweets.map(t => ({
      section: t.section,
      text: t.text,
      postedTweetId: null,
    }));

    // Step 5: discard any stale pending row for the same week_start so the
    // unique constraint doesn't reject our insert. Idempotent — no-op if
    // there isn't one. We only discard pending rows of the SAME week, never
    // touch a posted/partial_posted/failed/discarded row for some other week.
    await this.discardStalePendingForWeek(startIso);

    // Step 6: combined cost = LLM tokens + Twitter API cost from the
    // aggregator. Persisted as a single number; the breakdown isn't worth
    // splitting into separate columns at v1.
    const totalCostUsd = generated.costUsd + data.twitterCostUsd;

    // Step 7: persist as 'pending'.
    const id = await this.databaseService.insertWeeklySummary({
      weekStart: startIso,
      weekEnd: endIso,
      status: 'pending',
      generatedAt: new Date().toISOString(),
      postedAt: null,
      snapshotData: snapshot,
      llmContextText: generated.fullPrompt,
      tweets,
      errorMessage: null,
      modelUsed: generated.modelUsed,
      promptTokens: generated.promptTokens,
      completionTokens: generated.completionTokens,
      costUsd: totalCostUsd,
    });

    const elapsedMs = Date.now() - startedAt;
    logger.info(
      `📰 [WeeklySummaryService] Generated summary id=${id} in ${elapsedMs}ms — ` +
        `${tweets.length} tweet(s), LLM ~$${generated.costUsd.toFixed(3)} + ` +
        `Twitter ~$${data.twitterCostUsd.toFixed(3)} = ~$${totalCostUsd.toFixed(3)} total`,
    );
    return id;
  }

  /**
   * Post the pending summary as a Twitter thread. Idempotent and partial-
   * failure-tolerant:
   *
   *   - If status is 'posted' → no-op, returns immediately
   *   - If status is 'pending' OR 'partial_posted' → resumes from the first
   *     tweet without a postedTweetId, chaining off the previous one
   *   - If status is 'discarded' or 'failed' → throws (refuses to post)
   *
   * After EVERY successful tweet post, the row is updated immediately so a
   * mid-thread crash leaves the DB in a resumable state.
   *
   * @throws on validation errors or unrecoverable post failures.
   */
  async post(summaryId: number): Promise<void> {
    if (this.inflightPostIds.has(summaryId)) {
      logger.warn(`📰 [WeeklySummaryService] post(${summaryId}) skipped — another post is already in flight for this summary`);
      return;
    }
    this.inflightPostIds.add(summaryId);

    try {
      const summary = await this.fetchSummaryOrThrow(summaryId);

      if (summary.status === 'posted') {
        logger.info(`📰 [WeeklySummaryService] post(${summaryId}) is already 'posted' — no-op`);
        return;
      }
      if (summary.status === 'discarded' || summary.status === 'failed') {
        throw new Error(
          `Cannot post summary ${summaryId}: status is '${summary.status}' (must be 'pending' or 'partial_posted')`,
        );
      }
      if (summary.tweets.length === 0) {
        throw new Error(`Summary ${summaryId} has no tweets to post`);
      }

      // Resume point: the first tweet without a postedTweetId.
      // If status is 'pending', this is index 0. If 'partial_posted', it's
      // wherever the previous attempt got stuck.
      const tweetsCopy: WeeklySummaryTweet[] = summary.tweets.map(t => ({ ...t }));
      const startIdx = tweetsCopy.findIndex(t => !t.postedTweetId);
      if (startIdx === -1) {
        // All tweets have ids but status wasn't 'posted' — fix the status.
        logger.warn(`📰 [WeeklySummaryService] Summary ${summaryId}: all tweets posted but status was '${summary.status}'. Marking as posted.`);
        await this.databaseService.updateWeeklySummary(summaryId, {
          status: 'posted',
          postedAt: new Date().toISOString(),
          errorMessage: null,
        });
        return;
      }

      logger.info(
        `📰 [WeeklySummaryService] Posting summary ${summaryId}: ${summary.tweets.length} tweet(s), ` +
          `starting at index ${startIdx} (${startIdx === 0 ? 'fresh post' : 'resume after partial failure'})`,
      );

      // Determine the in-reply-to id for the first tweet we're posting.
      // - If startIdx === 0: first tweet is a top-level post (no reply).
      // - If startIdx > 0: chain off the previous tweet's postedTweetId.
      let replyToId: string | null = startIdx > 0 ? tweetsCopy[startIdx - 1].postedTweetId ?? null : null;

      for (let i = startIdx; i < tweetsCopy.length; i++) {
        const tweet = tweetsCopy[i];
        const sectionTag = `[${i + 1}/${tweetsCopy.length} ${tweet.section}]`;

        let result;
        try {
          if (replyToId === null) {
            logger.info(`📰 [WeeklySummaryService] ${sectionTag} posting as top-level tweet…`);
            result = await this.twitterService.postTweet(tweet.text);
          } else {
            logger.info(`📰 [WeeklySummaryService] ${sectionTag} posting as reply to ${replyToId}…`);
            result = await this.twitterService.postReply(tweet.text, replyToId);
          }
        } catch (err: any) {
          // Hard error from twitterService (network, OAuth, etc.) — not a
          // returned `{ success: false }` response. Treat as partial failure.
          await this.markPartialPosted(summaryId, tweetsCopy, `tweet ${i + 1} (${tweet.section}) threw: ${err.message}`);
          throw err;
        }

        if (!result.success || !result.tweetId) {
          // Twitter rejected the tweet (rate-limit, content issue, etc.).
          await this.markPartialPosted(summaryId, tweetsCopy, `tweet ${i + 1} (${tweet.section}) rejected: ${result.error ?? 'unknown'}`);
          throw new Error(
            `Failed to post tweet ${i + 1} (${tweet.section}) of summary ${summaryId}: ${result.error ?? 'unknown error'}`,
          );
        }

        // Persist the new tweet id IMMEDIATELY so a crash on the very next
        // line leaves the DB pointing at exactly what's on Twitter.
        tweetsCopy[i] = { ...tweet, postedTweetId: result.tweetId };
        await this.databaseService.updateWeeklySummary(summaryId, { tweets: tweetsCopy });
        logger.info(`📰 [WeeklySummaryService] ${sectionTag} posted: ${result.tweetId}`);

        // Chain the next tweet off this one.
        replyToId = result.tweetId;
      }

      // All tweets posted successfully. Promote to 'posted'.
      await this.databaseService.updateWeeklySummary(summaryId, {
        status: 'posted',
        postedAt: new Date().toISOString(),
        errorMessage: null,
      });
      logger.info(`📰 [WeeklySummaryService] Summary ${summaryId} fully posted (${tweetsCopy.length} tweet(s))`);
    } finally {
      this.inflightPostIds.delete(summaryId);
    }
  }

  /**
   * Mark a pending or partial_posted summary as discarded. Idempotent —
   * no-op if it's already 'discarded'. Throws if the status doesn't allow
   * discarding (already posted, in flight, etc.).
   */
  async discard(summaryId: number): Promise<void> {
    const summary = await this.fetchSummaryOrThrow(summaryId);

    if (summary.status === 'discarded') {
      logger.info(`📰 [WeeklySummaryService] discard(${summaryId}) is already 'discarded' — no-op`);
      return;
    }
    if (summary.status === 'posted') {
      throw new Error(`Cannot discard summary ${summaryId}: already posted`);
    }
    if (this.inflightPostIds.has(summaryId)) {
      throw new Error(`Cannot discard summary ${summaryId}: a post is currently in flight`);
    }

    await this.databaseService.updateWeeklySummary(summaryId, {
      status: 'discarded',
      errorMessage: null,
    });
    logger.info(`📰 [WeeklySummaryService] Discarded summary ${summaryId}`);
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Internal helpers
  // ───────────────────────────────────────────────────────────────────────────

  private async fetchSummaryOrThrow(summaryId: number): Promise<WeeklySummary> {
    // The DB layer doesn't expose a direct "get by id" yet — we use the
    // history list (limited to 50 to bound the query) and look up by id.
    // Cheap because the table will only ever have ~52 rows/year.
    const history = await this.databaseService.getWeeklySummariesHistory(200);
    const found = history.find(s => s.id === summaryId);
    if (!found) {
      throw new Error(`Weekly summary ${summaryId} not found`);
    }
    return found;
  }

  /**
   * Discard any stale pending row for the SAME week_start so the unique
   * constraint doesn't reject the new insert. We compare on the ISO string —
   * `generate()` always uses the same window math so this is exact.
   */
  private async discardStalePendingForWeek(weekStartIso: string): Promise<void> {
    const pending = await this.databaseService.getCurrentPendingWeeklySummary();
    if (pending && pending.weekStart === weekStartIso && pending.id !== undefined) {
      logger.info(
        `📰 [WeeklySummaryService] Discarding stale pending summary ${pending.id} for week ${weekStartIso} before regenerating`,
      );
      await this.databaseService.updateWeeklySummary(pending.id, {
        status: 'discarded',
        errorMessage: 'Replaced by manual regenerate',
      });
    }
  }

  private async markPartialPosted(
    summaryId: number,
    tweets: WeeklySummaryTweet[],
    errorMessage: string,
  ): Promise<void> {
    try {
      await this.databaseService.updateWeeklySummary(summaryId, {
        status: 'partial_posted',
        tweets,
        errorMessage,
      });
      logger.warn(`📰 [WeeklySummaryService] Summary ${summaryId} marked partial_posted: ${errorMessage}`);
    } catch (dbErr: any) {
      // If even the DB update fails, log loudly — we can't recover the state
      // from the dashboard but the actual posted tweets are still on Twitter.
      logger.error(
        `📰 [WeeklySummaryService] CRITICAL: failed to mark summary ${summaryId} as partial_posted in DB: ${dbErr.message}. Original error: ${errorMessage}`,
      );
    }
  }

  /**
   * Derive the snapshot we persist for next week's comparison. Pulls the
   * headline numbers out of `WeeklySummaryData` and converts wei → ETH/USD
   * using the current ETH price. Missing-source defaults are 0 (stored
   * cleanly so the next week's diff math doesn't NaN).
   */
  private buildSnapshot(data: WeeklySummaryData): WeeklySnapshotData {
    const ethPrice = data.ethPriceNow ?? null;
    const m = data.marketAnalytics;
    const r = data.registrationAnalytics?.summary;

    const weiToEth = (wei: string | null | undefined): number => {
      if (!wei) return 0;
      try {
        return Number(BigInt(String(wei).split('.')[0])) / 1e18;
      } catch {
        return 0;
      }
    };
    const ethToUsd = (eth: number): number => (ethPrice ? eth * ethPrice : 0);

    const salesVolumeEth = m ? weiToEth(m.volume.total_volume_wei) : 0;
    const registrationCostEth = r ? weiToEth(r.total_cost_wei) : 0;

    return {
      weekStart: data.weekStart,
      weekEnd: data.weekEnd,

      salesCount: m?.volume.sales_count ?? 0,
      salesVolumeEth,
      salesVolumeUsd: ethToUsd(salesVolumeEth),
      uniqueBuyers: m?.volume.unique_buyers ?? 0,
      uniqueSellers: m?.volume.unique_sellers ?? 0,
      uniqueNamesSold: m?.volume.unique_names_sold ?? 0,

      registrationCount: r?.registration_count ?? 0,
      registrationCostEth,
      registrationCostUsd: ethToUsd(registrationCostEth),
      premiumRegistrations: r?.premium_registrations ?? 0,
      uniqueRegistrants: r?.unique_registrants ?? 0,

      renewalCount: data.renewalsStats.count,
      renewalTxCount: data.renewalsStats.txCount,
      renewalVolumeEth: data.renewalsStats.totalVolumeEth,
      renewalVolumeUsd: data.renewalsStats.totalVolumeUsd,

      offersCount: m?.activity.offers ?? 0,
      activeListings: m?.overview.active_listings ?? 0,
      activeOffers: m?.overview.active_offers ?? 0,

      ethPriceUsd: ethPrice,
    };
  }
}
