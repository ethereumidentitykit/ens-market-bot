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
  /** How many premium-decay names by watcher count. */
  PREMIUM_LIMIT: 50,
  /** How many grace-period names by watcher count. */
  GRACE_LIMIT: 50,
  /** Top-N renewal rows by per-name cost. */
  RENEWALS_TOP_N: 10,
  /** Top-N participants for "Star of the week" candidate pool. */
  TOP_PARTICIPANTS_N: 3,
  /** First N blacklist sales returned for context (full count + sum is unbounded). */
  WASH_SALES_LIMIT: 20,
  /** First N AI replies that mentioned 'wash' (full count is unbounded). */
  WASH_REPLIES_LIMIT: 10,
  /** Upper bound on the bot's own tweets fetched in the window. ~50-100/wk realistically. */
  OWN_TWEETS_LIMIT: 200,
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

      // Twitter
      ownTweetsRes,
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

      safe(
        'twitter:ownTweets',
        this.twitterService.getOwnTweetsSince(startIso, TUNABLES.OWN_TWEETS_LIMIT),
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
    const graceByWatchers = graceByWatchersRaw ?? [];

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

    const ownTweetsWithFreshMetrics: TwitterV2Tweet[] = ownTweetsRes?.data ?? [];
    twitterCostUsd += ownTweetsRes?.costUsd ?? 0;

    const ensTwitterChatter: TwitterV2Tweet[] = ensChatterRes?.data ?? [];
    twitterCostUsd += ensChatterRes?.costUsd ?? 0;

    // ── Wave 2: third-party replies for each engaged own tweet ──────────────
    //
    // We pull replies for EVERY tweet with reply_count > 0 (per plan), capped
    // at 100 replies per conversation by `getRepliesToTweet`. Sub-calls are
    // also `Promise.allSettled` so one failed conversation doesn't break the
    // batch.
    const engagedTweets = ownTweetsWithFreshMetrics.filter(
      t => (t.public_metrics?.reply_count ?? 0) > 0,
    );

    const thirdPartyReplies: WeeklySummaryData['thirdPartyReplies'] = [];
    if (engagedTweets.length > 0) {
      logger.info(
        `📊 [WeeklyData] Fetching replies for ${engagedTweets.length} engaged conversation(s)`,
      );
      const replyResults = await Promise.allSettled(
        engagedTweets.map(async t => {
          const conversationId = t.conversation_id ?? t.id;
          const res = await this.twitterService.getRepliesToTweet(
            conversationId,
            TUNABLES.REPLIES_PER_CONV_CAP,
          );
          return { conversationId, res };
        }),
      );
      for (const r of replyResults) {
        if (r.status === 'fulfilled') {
          thirdPartyReplies.push({
            conversationId: r.value.conversationId,
            replies: r.value.res.data,
          });
          twitterCostUsd += r.value.res.costUsd;
        } else {
          // Don't spam partialSourceFailures with one entry per failed conv —
          // collapse to a single counted source name.
          if (!partialSourceFailures.includes('twitter:repliesPartial')) {
            partialSourceFailures.push('twitter:repliesPartial');
          }
          logger.warn(
            `📊 [WeeklyData] Reply fetch failed for one conversation: ${(r.reason as any)?.message ?? r.reason}`,
          );
        }
      }
    }

    // ── Wave 3: enrich top participants with ENS names ──────────────────────
    if (topParticipants.length > 0) {
      try {
        const resolved = await this.ensWorkerService.resolveAddresses(
          topParticipants.map(p => p.address),
        );
        const ensByAddr = new Map(resolved.map(r => [r.address.toLowerCase(), r]));
        topParticipants = topParticipants.map(p => {
          const r = ensByAddr.get(p.address.toLowerCase());
          // hasEns + ensName present means we got a real ENS name back.
          // Otherwise leave ensName null and let the prompt show the address.
          return { ...p, ensName: r?.hasEns && r.ensName ? r.ensName : null };
        });
      } catch (err: any) {
        partialSourceFailures.push('enrichment:topParticipantsEns');
        logger.warn(`📊 [WeeklyData] Top-participants ENS enrichment failed: ${err.message}`);
      }
    }

    const elapsedMs = Date.now() - startedAt;
    logger.info(
      `📊 [WeeklyData] Done in ${elapsedMs}ms. ` +
        `${botPosts.length} bot post(s), ${ownTweetsWithFreshMetrics.length} own tweet(s) ` +
        `with metrics, ${thirdPartyReplies.length} engaged conv(s), ` +
        `${ensTwitterChatter.length} chatter tweet(s). ` +
        `Twitter cost ~$${twitterCostUsd.toFixed(3)}. ` +
        `Source failures: ${partialSourceFailures.length === 0 ? 'none' : partialSourceFailures.join(', ')}`,
    );

    return {
      weekStart: startIso,
      weekEnd: endIso,

      marketAnalytics,
      registrationAnalytics,
      topSales,
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
      botPosts,

      ownTweetsWithFreshMetrics,
      thirdPartyReplies,
      ensTwitterChatter,

      ethPriceNow,
      ethPrice7dAgo,

      previousSnapshot,

      twitterCostUsd,
      partialSourceFailures,
    };
  }
}
