/**
 * WeeklySummaryDataService — collects everything the weekly market summary
 * needs into a single typed `WeeklySummaryData` object.
 *
 * Architecture:
 *   - All sources fire in parallel via `Promise.allSettled`. A single source
 *     failure logs at warn level, degrades that field to null/empty/zero, and
 *     adds the source name to `partialSourceFailures` — but DOES NOT break the
 *     run. A weekly summary that's missing one source is much better than one
 *     that fails entirely.
 *   - Twitter calls accumulate cost into `twitterCostUsd` (upper bound; the 24h
 *     dedup window can make actual bill smaller).
 *   - Top participants get an additional ENS-name enrichment pass after the
 *     primary aggregation completes.
 *
 * The output is consumed by the LLM (Phase 4) and, in v2, by the image
 * template. NO rendering logic lives here — this layer is pure data plumbing.
 */

import { logger } from '../utils/logger';
import {
  IDatabaseService,
  WeeklySummaryData,
  WeeklyRenewalsStats,
  WeeklyTopParticipant,
  WeeklyWashSignals,
  WeeklySnapshotData,
  WeeklyBotPost,
} from '../types';
import { GrailsApiService } from './grailsApiService';
import { AlchemyService } from './alchemyService';
import { TwitterService } from './twitterService';
import { ENSWorkerService } from './ensWorkerService';
import { TwitterV2Tweet } from '../types/twitter';

const ONE_WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Tunables. Conservative defaults — enough breadth for the LLM to find a story
 * without blowing the token budget or the Twitter cost ceiling.
 */
const TUNABLES = {
  /** Top-N for Grails analytics top lists (sales/regs/offers). */
  GRAILS_TOP_LIMIT: 20,
  /**
   * How many premium-decay names by watcher count.
   * Bumped from 50 → 100 so genuine grails (e.g. send.eth, prompt.eth) don't
   * fall off the bottom of the list when several niche names happen to spike
   * in watchers in a given week. Most cost is in the prompt char budget, not
   * the API call itself, and the prompt builder still slices to a render cap.
   */
  PREMIUM_LIMIT: 100,
  /** How many grace-period names by watcher count. */
  GRACE_LIMIT: 50,
  /** Top-N renewal rows by per-name cost. */
  RENEWALS_TOP_N: 10,
  /**
   * Top-N participants for the "Top Player of the Week" candidate pool.
   * Bumped from 3 → 5 so the LLM has a wider pool to pick the most
   * interesting STORY (not just the top of the volume leaderboard).
   */
  TOP_PARTICIPANTS_N: 5,
  /** First N blacklist sales returned for context (full count + sum is unbounded). */
  WASH_SALES_LIMIT: 20,
  /** First N AI replies that mentioned 'wash' (full count is unbounded). */
  WASH_REPLIES_LIMIT: 10,
  /** Replies per engaged conversation. Capped at 100 by the v2 search-recent endpoint. */
  REPLIES_PER_CONV_CAP: 100,
  /** ENS chatter search size. */
  ENS_SEARCH_LIMIT: 100,
} as const;

export class WeeklySummaryDataService {
  constructor(
    private readonly databaseService: IDatabaseService,
    private readonly alchemyService: AlchemyService,
    private readonly twitterService: TwitterService,
    private readonly ensWorkerService: ENSWorkerService,
  ) {}

  /**
   * Collect a complete `WeeklySummaryData` for the given window.
   *
   * @param weekStart Window start (inclusive). Defaults to `weekEnd - 7d`.
   * @param weekEnd Window end (exclusive). Defaults to "now".
   */
  async collectWeeklyData(weekStart?: Date, weekEnd?: Date): Promise<WeeklySummaryData> {
    const end = weekEnd ?? new Date();
    const start = weekStart ?? new Date(end.getTime() - ONE_WEEK_MS);
    const startIso = start.toISOString();
    const endIso = end.toISOString();

    logger.info(`📊 [WeeklyData] Collecting window ${startIso} → ${endIso}`);
    const startedAt = Date.now();

    const partialSourceFailures: string[] = [];
    let twitterCostUsd = 0;

    const fail = (name: string, err: unknown): void => {
      const msg = (err as any)?.message ?? String(err);
      logger.warn(`📊 [WeeklyData] Source "${name}" failed: ${msg}`);
      partialSourceFailures.push(name);
    };

    /**
     * Wrap a promise so rejections become resolved `undefined` and get logged
     * as failures. We use this + `Promise.all` (instead of `Promise.allSettled`)
     * because Promise.all preserves precise tuple types on destructure, while
     * Promise.allSettled collapses to a union of all element types — which
     * makes the destructured types unusable without per-element narrowing.
     */
    const safe = async <T>(name: string, p: Promise<T>): Promise<T | undefined> => {
      try {
        return await p;
      } catch (err) {
        fail(name, err);
        return undefined;
      }
    };

    // ── Wave 1: fire all independent sources in parallel ────────────────────
    const [
      // Grails analytics (10)
      marketAnalyticsRaw,
      registrationAnalyticsRaw,
      topSalesRaw,
      topRegistrationsRaw,
      topOffersRaw,
      volumeChartRaw,
      salesChartRaw,
      volumeDistributionRaw,
      premiumByWatchersRaw,
      graceByWatchersRaw,

      // Self DB aggregations (4)
      botPostsRaw,
      renewalsStatsRaw,
      topParticipantsRaw,
      washSignalsRaw,

      // Last snapshot
      lastSnapshotRow,

      // Alchemy
      ethPriceNowRaw,
      ethPrice7dAgoRaw,

      // Twitter (only the ENS chatter search at Wave 1 — own-tweet metrics
      // are hydrated in Wave 1.5 from DB tweet IDs, see comment below)
      ensChatterRes,
    ] = await Promise.all([
      safe('grails:marketAnalytics', GrailsApiService.getMarketAnalytics('7d')),
      safe('grails:registrationAnalytics', GrailsApiService.getRegistrationAnalyticsSummary('7d')),
      safe('grails:topSales', GrailsApiService.getTopSales('7d', TUNABLES.GRAILS_TOP_LIMIT)),
      safe(
        'grails:topRegistrations',
        GrailsApiService.getTopRegistrations('7d', TUNABLES.GRAILS_TOP_LIMIT),
      ),
      safe('grails:topOffers', GrailsApiService.getTopOffers('7d', TUNABLES.GRAILS_TOP_LIMIT)),
      safe('grails:volumeChart', GrailsApiService.getVolumeChart('7d')),
      safe('grails:salesChart', GrailsApiService.getSalesChart('7d')),
      safe('grails:volumeDistribution', GrailsApiService.getVolumeDistribution('7d')),
      safe('grails:premiumByWatchers', GrailsApiService.searchPremiumByWatchers(TUNABLES.PREMIUM_LIMIT)),
      safe('grails:graceByWatchers', GrailsApiService.searchGraceByWatchers(TUNABLES.GRACE_LIMIT)),

      safe('self:botPosts', this.databaseService.getWeeklyTweetsAndReplies(start, end)),
      safe(
        'self:renewalsStats',
        this.databaseService.getWeeklyRenewalsStats(start, end, TUNABLES.RENEWALS_TOP_N),
      ),
      safe(
        'self:topParticipants',
        this.databaseService.getWeeklyTopParticipants(start, end, TUNABLES.TOP_PARTICIPANTS_N),
      ),
      safe(
        'self:washSignals',
        this.databaseService.getWeeklyWashSignals(
          start,
          end,
          TUNABLES.WASH_SALES_LIMIT,
          TUNABLES.WASH_REPLIES_LIMIT,
        ),
      ),

      safe('self:lastSnapshot', this.databaseService.getLastPostedWeeklySummary(start)),

      safe('alchemy:ethNow', this.alchemyService.getETHPriceUSD()),
      safe(
        'alchemy:eth7dAgo',
        this.alchemyService.getHistoricalEthPrice(Math.floor(start.getTime() / 1000)),
      ),

      safe('twitter:ensChatter', this.twitterService.searchEnsContent(TUNABLES.ENS_SEARCH_LIMIT)),
    ]);

    // Apply fallbacks now that each result has its narrow type.
    const marketAnalytics = marketAnalyticsRaw ?? null;
    const registrationAnalytics = registrationAnalyticsRaw ?? null;
    const topSales = topSalesRaw ?? [];
    const topRegistrations = topRegistrationsRaw ?? [];
    const topOffers = topOffersRaw ?? [];
    const volumeChart = volumeChartRaw ?? null;
    const salesChart = salesChartRaw ?? null;
    const volumeDistribution = volumeDistributionRaw ?? null;
    const premiumByWatchers = premiumByWatchersRaw ?? [];
    // Grace filter: only include grace-period names that will TRANSITION INTO
    // the premium auction phase within the next 7 days.
    //
    // ENS post-expiry timeline:
    //   Day 0      → name expires
    //   Days 0-90  → grace period (owner can still renew at normal cost)
    //   Day 90     → grace ends, premium auction starts
    //   Days 90+   → premium decays from $100M to $0 over 21 days
    //
    // "Drops from grace to premium within 7 days" means the name has been in
    // grace for 83-90 days (i.e. expiry_date is between 90 and 83 days ago).
    // Grace names sitting at, say, 30 days post-expiry aren't actionable yet
    // — the watcher data on those is stale signal. The 83-90d slice IS
    // actionable: registrants are about to compete for the name.
    const graceFilterEnd = end.getTime() - 83 * 24 * 60 * 60 * 1000;   // expired ≤ 83d ago
    const graceFilterStart = end.getTime() - 90 * 24 * 60 * 60 * 1000; // expired ≥ 90d ago
    const graceByWatchers = (graceByWatchersRaw ?? []).filter(name => {
      const expiryMs = new Date(name.expiry_date).getTime();
      // Must have a parseable expiry within the 83-90d-ago window.
      return Number.isFinite(expiryMs) && expiryMs >= graceFilterStart && expiryMs <= graceFilterEnd;
    });

    const botPosts = botPostsRaw ?? [];
    const renewalsStats: WeeklyRenewalsStats = renewalsStatsRaw ?? {
      count: 0,
      txCount: 0,
      totalVolumeEth: 0,
      totalVolumeUsd: 0,
      topByVolume: [],
    };
    let topParticipants: WeeklyTopParticipant[] = topParticipantsRaw ?? [];
    const washSignals: WeeklyWashSignals = washSignalsRaw ?? {
      blacklistMatches: { count: 0, volumeEth: 0, volumeUsd: 0, sales: [] },
      aiReplyWashMentions: { count: 0, replies: [] },
    };

    // `lastSnapshotRow` may be undefined (fetch failure) OR null (no prior
    // week — first run). Either way, `previousSnapshot` is null; only a
    // successful, present row contributes a real snapshot for comparison.
    const previousSnapshot: WeeklySnapshotData | null = lastSnapshotRow?.snapshotData ?? null;

    const ethPriceNow = ethPriceNowRaw ?? null;
    const ethPrice7dAgo = ethPrice7dAgoRaw ?? null;

    const ensTwitterChatter: TwitterV2Tweet[] = ensChatterRes?.data ?? [];
    twitterCostUsd += ensChatterRes?.costUsd ?? 0;

    // ── Wave 1.5: hydrate engagement metrics on the bot's own tweets ────────
    //
    // Why this isn't `getOwnTweetsSince`: the prior `/2/users/{me}/tweets`
    // approach silently broke in dev environments. Dev runs use a TESTING
    // Twitter account, but the DB contains tweet IDs from the PRODUCTION
    // account (DB is shared). `/2/users/{me}/tweets` returned the testing
    // account's recent tweets — usually empty or unrelated — which meant
    // `engagedTweets` was always empty in dev and the entire reply-fetch
    // pipeline downstream of it never ran.
    //
    // The DB-driven path works in BOTH environments: tweet IDs are global
    // on Twitter, and `public_metrics` is available regardless of which
    // account holds the auth token. We pull tweet IDs we know we posted
    // (from `botPosts`) and call `getTweetsWithMetrics(ids)` to hydrate.
    //
    // Cost note: in dev, hydrating tweet IDs the testing account doesn't own
    // is technically a "third-party read" ($0.005/tweet) instead of an
    // "owned read" ($0.001/tweet). For ~50 tweets/week that's a ~$0.20 diff
    // — acceptable. In prod, where the auth token matches the tweets, it's
    // back to $0.001/tweet.
    //
    // Trade-off: tweets posted to the bot's account OUTSIDE our pipeline
    // (e.g. manual posts via Twitter UI) won't be in `botPosts` and so
    // won't be hydrated. For the weekly summary use case that's fine — we
    // report on the bot's automated content, not its manual content.
    // Hydrate fresh engagement metrics for every bot tweet ID we know about.
    // Uses DB tweet IDs (works in any env — see prior comment block).
    // Also resolves the bot's own user (id + username) — username is needed
    // by the prompt builder to strip self-mentions from third-party text.
    const allBotTweetIds = Array.from(
      new Set(botPosts.map(p => p.tweetId).filter((id): id is string => !!id)),
    );
    const [ownUserResult, metricsByTweetId] = await Promise.all([
      (async () => {
        try {
          return await this.twitterService.getOwnUser();
        } catch (err: any) {
          fail('twitter:ownUser', err);
          return null;
        }
      })(),
      (async (): Promise<Map<string, TwitterV2Tweet>> => {
        const map = new Map<string, TwitterV2Tweet>();
        if (allBotTweetIds.length === 0) return map;
        logger.info(
          `📊 [WeeklyData] Hydrating engagement metrics on ${allBotTweetIds.length} bot tweet ID(s) from DB`,
        );
        try {
          const res = await this.twitterService.getTweetsWithMetrics(allBotTweetIds);
          twitterCostUsd += res.costUsd;
          for (const t of res.data) map.set(t.id, t);
        } catch (err: any) {
          fail('twitter:hydrateOwnMetrics', err);
        }
        return map;
      })(),
    ]);
    const botUsername = ownUserResult?.username ?? null;

    // ── Wave 2: build conversation tree per parent tweet ─────────────────────
    //
    // Each parent (sale/registration/bid/renewal) becomes a thread group:
    //   parent → ourAiReply (matched by conversation_id) → third-party replies
    //   + third-party quotes
    //
    // We fetch replies + quotes only for parents whose hydrated metrics show
    // engagement on that side (reply_count > 0 / quote_count > 0). Saves
    // money on quiet tweets.
    const parents = botPosts.filter(p => p.type !== 'ai_reply');
    const aiReplies = botPosts.filter(p => p.type === 'ai_reply');

    // Index AI replies by their parent tweet id (= the AI reply's
    // conversationId, which we set to ai_replies.original_tweet_id upstream).
    // A parent could in theory have multiple AI replies — we keep the most
    // recent one by postedAt so the thread group is one-to-one.
    const aiReplyByParentId = new Map<string, WeeklyBotPost>();
    for (const r of aiReplies) {
      if (!r.conversationId) continue;
      const existing = aiReplyByParentId.get(r.conversationId);
      if (!existing || r.postedAt > existing.postedAt) {
        aiReplyByParentId.set(r.conversationId, r);
      }
    }

    // Decide which parents need replies / quotes fetched.
    // Both calls go in the same Promise.allSettled batch for max parallelism.
    type FetchKind = 'replies' | 'quotes';
    const fetchTasks: Array<{ tweetId: string; kind: FetchKind }> = [];
    for (const parent of parents) {
      const m = metricsByTweetId.get(parent.tweetId)?.public_metrics;
      if ((m?.reply_count ?? 0) > 0) fetchTasks.push({ tweetId: parent.tweetId, kind: 'replies' });
      if ((m?.quote_count ?? 0) > 0) fetchTasks.push({ tweetId: parent.tweetId, kind: 'quotes' });
    }

    const repliesByParentId = new Map<string, TwitterV2Tweet[]>();
    const quotesByParentId = new Map<string, TwitterV2Tweet[]>();

    if (fetchTasks.length > 0) {
      logger.info(
        `📊 [WeeklyData] Fetching ${fetchTasks.filter(t => t.kind === 'replies').length} reply set(s) + ` +
          `${fetchTasks.filter(t => t.kind === 'quotes').length} quote set(s) for engaged parents`,
      );
      const fetchResults = await Promise.allSettled(
        fetchTasks.map(async task => {
          const res =
            task.kind === 'replies'
              ? await this.twitterService.getRepliesToTweet(task.tweetId, TUNABLES.REPLIES_PER_CONV_CAP)
              : await this.twitterService.getQuoteTweets(task.tweetId, TUNABLES.REPLIES_PER_CONV_CAP);
          return { task, res };
        }),
      );
      for (const r of fetchResults) {
        if (r.status === 'fulfilled') {
          twitterCostUsd += r.value.res.costUsd;
          if (r.value.task.kind === 'replies') {
            repliesByParentId.set(r.value.task.tweetId, r.value.res.data);
          } else {
            quotesByParentId.set(r.value.task.tweetId, r.value.res.data);
          }
        } else {
          // Collapse all per-task failures into a single source-failure entry.
          if (!partialSourceFailures.includes('twitter:repliesQuotesPartial')) {
            partialSourceFailures.push('twitter:repliesQuotesPartial');
          }
          logger.warn(
            `📊 [WeeklyData] Reply/quote fetch failed for one parent: ${(r.reason as any)?.message ?? r.reason}`,
          );
        }
      }
    }

    // Assemble thread groups. Sorted newest-first by parent.postedAt so the
    // prompt builder doesn't have to re-sort.
    const threadGroups: WeeklySummaryData['threadGroups'] = parents
      .map(parent => ({
        parent,
        ourAiReply: aiReplyByParentId.get(parent.tweetId) ?? null,
        metrics: metricsByTweetId.get(parent.tweetId)?.public_metrics ?? null,
        thirdPartyReplies: repliesByParentId.get(parent.tweetId) ?? [],
        thirdPartyQuotes: quotesByParentId.get(parent.tweetId) ?? [],
      }))
      .sort((a, b) => (a.parent.postedAt < b.parent.postedAt ? 1 : a.parent.postedAt > b.parent.postedAt ? -1 : 0));

    // AI replies whose parent is OUTSIDE this week's window — surface
    // separately so they don't get lost. Rare in practice (parent + reply
    // usually land within minutes of each other).
    const parentTweetIds = new Set(parents.map(p => p.tweetId));
    const orphanedAiReplies: WeeklyBotPost[] = aiReplies.filter(
      r => !r.conversationId || !parentTweetIds.has(r.conversationId),
    );

    // ── Wave 3: enrich top participants with ENS names + Twitter handles ───
    // Two parallel passes:
    //   - resolveAddresses() → ENS display name (used in prompt's "ensname.eth")
    //   - getSocialHandles() → twitter handle from com.twitter record (used by
    //     T5 Top Player tweet to @-mention the actual person if they have one)
    // Both fall through cleanly to null on individual failures. Per-address
    // calls to getSocialHandles are independent → wrapped in Promise.allSettled.
    if (topParticipants.length > 0) {
      try {
        const [resolved, socialResults] = await Promise.all([
          this.ensWorkerService.resolveAddresses(topParticipants.map(p => p.address)),
          Promise.allSettled(
            topParticipants.map(p => this.ensWorkerService.getSocialHandles(p.address)),
          ),
        ]);

        const ensByAddr = new Map(resolved.map(r => [r.address.toLowerCase(), r]));
        const handleByAddr = new Map<string, string | null>();
        topParticipants.forEach((p, idx) => {
          const r = socialResults[idx];
          if (r.status === 'fulfilled') {
            const raw = r.value.twitter ?? null;
            // Strip any leading @ + whitespace; treat empty as null.
            const cleaned = raw ? raw.replace(/^@/, '').trim() : null;
            handleByAddr.set(p.address.toLowerCase(), cleaned && cleaned.length > 0 ? cleaned : null);
          } else {
            handleByAddr.set(p.address.toLowerCase(), null);
          }
        });

        topParticipants = topParticipants.map(p => {
          const r = ensByAddr.get(p.address.toLowerCase());
          return {
            ...p,
            ensName: r?.hasEns && r.ensName ? r.ensName : null,
            twitterHandle: handleByAddr.get(p.address.toLowerCase()) ?? null,
          };
        });
      } catch (err: any) {
        partialSourceFailures.push('enrichment:topParticipantsEns');
        logger.warn(`📊 [WeeklyData] Top-participants ENS/social enrichment failed: ${err.message}`);
      }
    }

    // ── F3 (post-Wave 1): filter blacklisted addresses out of topSales ─────
    // Sales involving blacklisted addresses are NOT tweeted by our pipeline,
    // so they shouldn't be referenced by the LLM as "headline trades" either.
    // Fetch the blacklist and filter — done here (not at Grails-fetch time) so
    // the filter is applied with our own DB's authoritative blacklist.
    let topSalesFiltered = topSales;
    try {
      const blacklist = await this.databaseService.getAddressBlacklist();
      if (blacklist.length > 0 && topSales.length > 0) {
        const blSet = new Set(blacklist.map(a => a.toLowerCase()));
        const before = topSales.length;
        topSalesFiltered = topSales.filter(s => {
          const buyer = (s.buyer_address ?? '').toLowerCase();
          const seller = (s.seller_address ?? '').toLowerCase();
          return !blSet.has(buyer) && !blSet.has(seller);
        });
        const removed = before - topSalesFiltered.length;
        if (removed > 0) {
          logger.info(
            `📊 [WeeklyData] Filtered ${removed} blacklisted sale(s) from topSales (${before} → ${topSalesFiltered.length})`,
          );
        }
      }
    } catch (err: any) {
      partialSourceFailures.push('filter:blacklistTopSales');
      logger.warn(`📊 [WeeklyData] Blacklist filter failed, passing topSales through: ${err.message}`);
    }

    const totalReplies = threadGroups.reduce((acc, g) => acc + g.thirdPartyReplies.length, 0);
    const totalQuotes = threadGroups.reduce((acc, g) => acc + g.thirdPartyQuotes.length, 0);
    const groupsWithEngagement = threadGroups.filter(
      g => g.thirdPartyReplies.length > 0 || g.thirdPartyQuotes.length > 0,
    ).length;
    const elapsedMs = Date.now() - startedAt;
    logger.info(
      `📊 [WeeklyData] Done in ${elapsedMs}ms. ` +
        `${threadGroups.length} thread group(s) (${groupsWithEngagement} with engagement: ${totalReplies} repl(ies) + ${totalQuotes} quote(s)), ` +
        `${orphanedAiReplies.length} orphan AI repl(ies), ` +
        `${ensTwitterChatter.length} chatter tweet(s). ` +
        `Twitter cost ~$${twitterCostUsd.toFixed(3)}. ` +
        `Source failures: ${partialSourceFailures.length === 0 ? 'none' : partialSourceFailures.join(', ')}`,
    );

    return {
      weekStart: startIso,
      weekEnd: endIso,

      marketAnalytics,
      registrationAnalytics,
      topSales: topSalesFiltered,
      topRegistrations,
      topOffers,
      volumeChart,
      salesChart,
      volumeDistribution,
      premiumByWatchers,
      graceByWatchers,

      renewalsStats,
      topParticipants,
      washSignals,

      threadGroups,
      orphanedAiReplies,

      ensTwitterChatter,

      ethPriceNow,
      ethPrice7dAgo,

      previousSnapshot,

      twitterCostUsd,
      partialSourceFailures,
      botUsername,
    };
  }
}
