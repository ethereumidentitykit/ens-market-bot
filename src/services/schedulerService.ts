import { CronJob } from 'cron';
import { BidsProcessingService } from './bidsProcessingService';
import { GrailsApiService } from './grailsApiService';
import { AutoTweetService, AutoPostSettings, PostResult } from './autoTweetService';
import { APIToggleService } from './apiToggleService';
import { WeeklySummaryService } from './weeklySummaryService';
import { logger } from '../utils/logger';
import { IDatabaseService } from '../types';

export class SchedulerService {
  private bidsProcessingService: BidsProcessingService;
  private grailsApiService: GrailsApiService | null = null;
  private weeklySummaryService: WeeklySummaryService | null = null;
  private autoTweetService: AutoTweetService;
  private apiToggleService: APIToggleService;
  private databaseService: IDatabaseService;
  private salesSyncJob: CronJob | null = null;
  private registrationSyncJob: CronJob | null = null;
  private grailsSyncJob: CronJob | null = null;
  // Two decoupled cron jobs for the Friday weekly summary thread:
  //   - Gen at 19:00 Madrid: collect data + LLM call + insert as 'pending'
  //   - Post at 20:00 Madrid: post the pending row as a thread
  // Decoupled so the post is deterministic at 20:00 even if generation is
  // slow, and so admin can manually override either step from the dashboard.
  private weeklySummaryGenJob: CronJob | null = null;
  private weeklySummaryPostJob: CronJob | null = null;
  private isRunning: boolean = false;
  private lastRunTime: Date | null = null;
  private lastRunStats: any = null;
  private consecutiveErrors: number = 0;
  private maxConsecutiveErrors: number = 5;
  
  private isProcessingSales: boolean = false;
  private isProcessingRegistrations: boolean = false;
  private isProcessingGrails: boolean = false;
  private isProcessingWeeklyGen: boolean = false;
  private isProcessingWeeklyPost: boolean = false;

  constructor(
    bidsProcessingService: BidsProcessingService,
    autoTweetService: AutoTweetService,
    databaseService: IDatabaseService
  ) {
    this.bidsProcessingService = bidsProcessingService;
    this.autoTweetService = autoTweetService;
    this.apiToggleService = APIToggleService.getInstance();
    this.databaseService = databaseService;
  }

  /**
   * Set GrailsApiService (injected after construction to avoid circular deps)
   */
  setGrailsApiService(grailsApiService: GrailsApiService): void {
    this.grailsApiService = grailsApiService;
    logger.info('🍷 GrailsApiService injected into SchedulerService');
  }

  /**
   * Set WeeklySummaryService. Injected after construction (mirrors the
   * GrailsApiService pattern) because the weekly service has many of its
   * own dependencies that the scheduler shouldn't know about. If not
   * injected, the weekly cron jobs gracefully skip with a warn-level log.
   */
  setWeeklySummaryService(weeklySummaryService: WeeklySummaryService): void {
    this.weeklySummaryService = weeklySummaryService;
    logger.info('📰 WeeklySummaryService injected into SchedulerService');
  }

  async initializeFromDatabase(): Promise<void> {
    try {
      logger.info('🔄 Initializing scheduler from database...');
      
      await new Promise(resolve => setTimeout(resolve, 1000));
      
      const savedState = await this.databaseService.getSystemState('scheduler_enabled');
      logger.info(`📊 Database scheduler state: ${savedState || 'not set'}`);
      
      if (savedState === 'true') {
        logger.info('✅ Scheduler was previously enabled - auto-starting...');
        await this.start();
        logger.info('🚀 Scheduler successfully restored and running');
      } else {
        logger.info('⏹️  Scheduler remains stopped (database state: false or unset)');
      }
    } catch (error: any) {
      logger.error('❌ Failed to load scheduler state from database:', error.message);
      logger.info('🛑 Scheduler will remain stopped until manually started');
      
      if (error.code) {
        logger.error(`Database error code: ${error.code}`);
      }
    }
  }

  /**
   * Start the automated scheduling.
   * Sales: every 5 minutes, Registrations: every 1 minute, Grails bids: every 1 minute.
   * Weekly summary: Friday 19:00 (gen) + 20:00 (post) Madrid time.
   * Registration tweet processing is handled in real-time by DatabaseEventService.
   */
  async start(): Promise<void> {
    if (
      this.salesSyncJob ||
      this.registrationSyncJob ||
      this.grailsSyncJob ||
      this.weeklySummaryGenJob ||
      this.weeklySummaryPostJob
    ) {
      logger.warn('Scheduler already running, stopping existing jobs first');
      await this.stop();
    }

    this.salesSyncJob = new CronJob(
      '0 */5 * * * *',
      () => { this.runSalesSync(); },
      null,
      false,
      'America/New_York'
    );

    this.registrationSyncJob = new CronJob(
      '0 * * * * *',
      () => { this.runRegistrationSync(); },
      null,
      false,
      'America/New_York'
    );

    this.grailsSyncJob = new CronJob(
      '0 * * * * *',
      () => { this.runGrailsSync(); },
      null,
      false,
      'America/New_York'
    );

    // Weekly summary jobs run in Europe/Madrid TZ (separate from the New York
    // jobs above). Cron `0 0 H * * 5` = at second 0 of minute 0 of hour H,
    // any day of any month, day-of-week 5 (Friday). Both jobs gate on the
    // weeklySummaryAutoEnabled toggle at run time — we always register them
    // with the scheduler (so admin doesn't need to restart to flip the
    // toggle) but they no-op when the toggle is off.
    this.weeklySummaryGenJob = new CronJob(
      '0 0 19 * * 5',
      () => { this.runWeeklySummaryGen(); },
      null,
      false,
      'Europe/Madrid'
    );

    this.weeklySummaryPostJob = new CronJob(
      '0 0 20 * * 5',
      () => { this.runWeeklySummaryPost(); },
      null,
      false,
      'Europe/Madrid'
    );

    this.salesSyncJob.start();
    this.registrationSyncJob.start();
    this.grailsSyncJob.start();
    this.weeklySummaryGenJob.start();
    this.weeklySummaryPostJob.start();
    this.isRunning = true;
    
    await this.saveSchedulerState(true);
    
    logger.info('Scheduler started - Sales: every 5 minutes, Registrations: every 1 minute, Grails bids: every 1 minute');
    logger.info('Weekly summary: Fridays 19:00 (gen) + 20:00 (post) Europe/Madrid');
    logger.info('Tweet processing: REAL-TIME via DatabaseEventService for QuickNode data');
    logger.info(`Next sales run: ${this.salesSyncJob.nextDate().toString()}`);
    logger.info(`Next registration run: ${this.registrationSyncJob.nextDate().toString()}`);
    logger.info(`Next Grails run: ${this.grailsSyncJob.nextDate().toString()}`);
    logger.info(`Next weekly summary gen: ${this.weeklySummaryGenJob.nextDate().toString()}`);
    logger.info(`Next weekly summary post: ${this.weeklySummaryPostJob.nextDate().toString()}`);
  }

  /**
   * Stop the automated scheduling (manual stop - persists disabled state)
   */
  async stop(): Promise<void> {
    let wasRunning = false;
    
    if (this.salesSyncJob) {
      this.salesSyncJob.stop();
      this.salesSyncJob = null;
      wasRunning = true;
    }
    
    if (this.registrationSyncJob) {
      this.registrationSyncJob.stop();
      this.registrationSyncJob = null;
      wasRunning = true;
    }
    
    if (this.grailsSyncJob) {
      this.grailsSyncJob.stop();
      this.grailsSyncJob = null;
      wasRunning = true;
    }

    if (this.weeklySummaryGenJob) {
      this.weeklySummaryGenJob.stop();
      this.weeklySummaryGenJob = null;
      wasRunning = true;
    }

    if (this.weeklySummaryPostJob) {
      this.weeklySummaryPostJob.stop();
      this.weeklySummaryPostJob = null;
      wasRunning = true;
    }

    if (wasRunning) {
      this.isRunning = false;
      await this.saveSchedulerState(false);
      logger.info('💾 Scheduler state persisted: DISABLED (survives restarts)');
      logger.info('Scheduler stopped - sales, registration, bid, and weekly summary processing halted');
      logger.info('Registration tweet processing continues via real-time DatabaseEventService');
    } else {
      logger.info('Scheduler was not running');
    }
  }

  async gracefulShutdown(): Promise<void> {
    if (this.salesSyncJob) {
      this.salesSyncJob.stop();
      this.salesSyncJob = null;
    }
    
    if (this.registrationSyncJob) {
      this.registrationSyncJob.stop();
      this.registrationSyncJob = null;
    }
    
    if (this.grailsSyncJob) {
      this.grailsSyncJob.stop();
      this.grailsSyncJob = null;
    }

    if (this.weeklySummaryGenJob) {
      this.weeklySummaryGenJob.stop();
      this.weeklySummaryGenJob = null;
    }

    if (this.weeklySummaryPostJob) {
      this.weeklySummaryPostJob.stop();
      this.weeklySummaryPostJob = null;
    }

    this.isRunning = false;
    logger.info('Scheduler gracefully stopped (state preserved for restart)');
  }

  async forceStop(): Promise<void> {
    this.isRunning = false;
    
    if (this.salesSyncJob) {
      this.salesSyncJob.stop();
      this.salesSyncJob = null;
    }
    
    if (this.registrationSyncJob) {
      this.registrationSyncJob.stop();
      this.registrationSyncJob = null;
    }
    
    if (this.grailsSyncJob) {
      this.grailsSyncJob.stop();
      this.grailsSyncJob = null;
    }

    if (this.weeklySummaryGenJob) {
      this.weeklySummaryGenJob.stop();
      this.weeklySummaryGenJob = null;
    }

    if (this.weeklySummaryPostJob) {
      this.weeklySummaryPostJob.stop();
      this.weeklySummaryPostJob = null;
    }

    await this.saveSchedulerState(false);
    logger.info('Scheduler force stopped - all processing halted');
  }

  private async saveSchedulerState(enabled: boolean): Promise<void> {
    try {
      await this.databaseService.setSystemState('scheduler_enabled', enabled.toString());
      logger.info(`💾 Scheduler state persisted: ${enabled ? 'ENABLED' : 'DISABLED'} (survives restarts)`);
    } catch (error: any) {
      logger.error('❌ Failed to save scheduler state to database:', error.message);
      logger.warn('⚠️  Scheduler state will NOT persist across restarts!');
    }
  }

  /**
   * Sales sync heartbeat (every 5 minutes).
   * QuickNode webhooks handle all sales ingestion in real-time.
   */
  private async runSalesSync(): Promise<void> {
    if (!this.isRunning) {
      logger.debug('Skipping sales sync - scheduler is stopped');
      return;
    }

    if (this.isProcessingSales) {
      logger.info('⏳ Sales sync skipped - previous batch still processing');
      return;
    }

    this.isProcessingSales = true;
    const startTime = new Date();

    try {
      await this.autoTweetService.refreshTimeCache();

      this.lastRunTime = startTime;
      this.lastRunStats = { fetched: 0, newSales: 0, duplicates: 0, filtered: 0, errors: 0 };
      this.consecutiveErrors = 0;

      const duration = Date.now() - startTime.getTime();
      logger.debug(`Sales sync heartbeat completed in ${duration}ms - QuickNode webhooks handle all sales`);

    } catch (error: any) {
      this.consecutiveErrors++;
      logger.error(`Sales sync failed (attempt ${this.consecutiveErrors}/${this.maxConsecutiveErrors}):`, error.message);

      this.lastRunStats = {
        success: false,
        error: error.message,
        consecutiveErrors: this.consecutiveErrors
      };

      if (this.consecutiveErrors >= this.maxConsecutiveErrors) {
        logger.error(`Too many consecutive errors (${this.consecutiveErrors}). Stopping scheduler for safety.`);
        this.stop();
        logger.error('🚨 SCHEDULER STOPPED DUE TO REPEATED FAILURES - Manual intervention required');
      }
    } finally {
      this.isProcessingSales = false;
    }
  }

  /**
   * Registration sync heartbeat (every 1 minute).
   * Registration data ingestion handled by QuickNode webhooks.
   * Tweet processing handled by DatabaseEventService via NOTIFY/LISTEN.
   */
  private async runRegistrationSync(): Promise<void> {
    if (!this.isRunning) {
      logger.debug('Skipping registration sync - scheduler is stopped');
      return;
    }

    if (this.isProcessingRegistrations) {
      logger.info('⏳ Registration sync skipped - previous batch still processing');
      return;
    }

    this.isProcessingRegistrations = true;
    const startTime = new Date();
    logger.debug('Starting registration sync (maintenance only)...');

    try {
      const duration = Date.now() - startTime.getTime();
      logger.debug(`Registration sync completed in ${duration}ms`);

    } catch (error: any) {
      logger.error(`Registration sync failed:`, error.message);
    } finally {
      this.isProcessingRegistrations = false;
    }
  }

  /**
   * Grails API bid sync (every 1 minute).
   * Grails is an aggregator — fetches bids from all marketplaces.
   */
  private async runGrailsSync(): Promise<void> {
    if (!this.isRunning) {
      logger.debug('Skipping Grails sync - scheduler is stopped');
      return;
    }

    if (!this.grailsApiService) {
      logger.debug('Skipping Grails sync - GrailsApiService not initialized');
      return;
    }

    if (this.isProcessingGrails) {
      logger.info('⏳ Grails sync skipped - previous batch still processing');
      return;
    }

    this.isProcessingGrails = true;
    const startTime = new Date();
    logger.info('🍷 Starting Grails API sync...');

    try {
      const fetchResult = await this.grailsApiService.fetchNewOffers();
      const { offers, newestTimestamp, boundaryTimestamp, hitPageCap, oldestFetchedTimestamp } = fetchResult;

      if (offers.length === 0) {
        // No new offers — safe to advance cursor to bookmark progress
        // (e.g., quiet period) but only when we DIDN'T hit the page cap.
        if (!hitPageCap && newestTimestamp > boundaryTimestamp) {
          await this.grailsApiService.advanceCursor(newestTimestamp);
        }
        logger.info('🍷 Grails sync complete - no new offers');
      } else {
        const stats = await this.bidsProcessingService.processBids(offers);

        // Cursor advancement strategy:
        // - If we hit the page cap, only advance to the OLDEST fetched offer's
        //   timestamp. This guarantees the next poll re-reads anything past
        //   the cap that we couldn't fit in this batch.
        // - Otherwise, advance to the NEWEST timestamp seen. The boundary was
        //   reached naturally so there's nothing older to recover.
        // Either way, advance only AFTER processBids resolves successfully so
        // a downstream crash leaves the cursor pointing at unprocessed offers.
        const cursorTarget = hitPageCap && oldestFetchedTimestamp !== null
          ? oldestFetchedTimestamp
          : newestTimestamp;

        if (cursorTarget > boundaryTimestamp) {
          await this.grailsApiService.advanceCursor(cursorTarget);
        }

        const duration = Date.now() - startTime.getTime();
        logger.info(`🍷 Grails sync completed in ${duration}ms:`, {
          fetched: offers.length,
          stored: stats.newBids,
          duplicates: stats.duplicates,
          filtered: stats.filtered,
          errors: stats.errors,
          hitPageCap,
        });
      }

    } catch (error: any) {
      logger.error(`🍷 Grails sync failed:`, error.message);
      // Cursor intentionally NOT advanced on error — next run will retry the same window.
    } finally {
      this.isProcessingGrails = false;
    }
  }

  /**
   * Weekly summary GENERATION job (Friday 19:00 Madrid).
   * Pre-flight checks (in order, fail-soft on any miss):
   *   1. Scheduler must be running
   *   2. weeklySummaryService must be injected
   *   3. weeklySummaryAutoEnabled toggle must be on (admin-controlled)
   *   4. Twitter + OpenAI APIs must both be enabled (data integrity)
   *   5. No pending row may already exist (avoid double-generation if cron
   *      fires twice for any reason; admin-generated rows also count here)
   *   6. Mutex against another in-flight gen run
   *
   * Errors are caught and logged — never bubble out of the cron callback.
   */
  private async runWeeklySummaryGen(): Promise<void> {
    if (!this.isRunning) {
      logger.debug('Skipping weekly summary gen - scheduler is stopped');
      return;
    }
    if (!this.weeklySummaryService) {
      logger.warn('📰 Weekly summary gen skipped - WeeklySummaryService not injected');
      return;
    }
    if (!this.apiToggleService.isWeeklySummaryAutoEnabled()) {
      logger.info('📰 Weekly summary gen skipped - auto toggle is OFF (admin-controlled)');
      return;
    }
    if (!this.apiToggleService.isTwitterEnabled() || !this.apiToggleService.isOpenAIEnabled()) {
      logger.warn('📰 Weekly summary gen skipped - Twitter or OpenAI API is disabled');
      return;
    }
    if (this.isProcessingWeeklyGen) {
      logger.warn('📰 Weekly summary gen skipped - previous run still in flight');
      return;
    }

    // Skip if a pending row already exists at all (admin may have generated
    // earlier, or a previous cron fired). The post job will pick up whatever
    // is pending; we don't want to overwrite it.
    try {
      const existing = await this.databaseService.getCurrentPendingWeeklySummary();
      if (existing) {
        logger.info(
          `📰 Weekly summary gen skipped - pending row already exists (id=${existing.id}, weekStart=${existing.weekStart})`,
        );
        return;
      }
    } catch (error: any) {
      logger.error('📰 Failed to check for existing pending summary - aborting gen:', error.message);
      return;
    }

    this.isProcessingWeeklyGen = true;
    const startTime = Date.now();
    logger.info('📰 Starting weekly summary generation...');

    try {
      const id = await this.weeklySummaryService.generate();
      const elapsed = Date.now() - startTime;
      logger.info(`📰 Weekly summary gen completed in ${elapsed}ms - new pending row id=${id}`);
    } catch (error: any) {
      logger.error('📰 Weekly summary gen failed:', error.message);
      logger.error(error.stack);
    } finally {
      this.isProcessingWeeklyGen = false;
    }
  }

  /**
   * Weekly summary POSTING job (Friday 20:00 Madrid).
   * Pre-flight checks:
   *   1. Scheduler running, service injected, toggle on, Twitter enabled
   *   2. A pending row must exist (we DO NOT auto-generate at the last
   *      second — if gen failed at 19:00, post just skips to avoid posting
   *      a degraded thread)
   *   3. The pending row's `generatedAt` must be within the last 24 hours
   *      (stale rows from prior weeks are skipped)
   *   4. Mutex against another in-flight post run
   *
   * Errors are caught and logged.
   */
  private async runWeeklySummaryPost(): Promise<void> {
    if (!this.isRunning) {
      logger.debug('Skipping weekly summary post - scheduler is stopped');
      return;
    }
    if (!this.weeklySummaryService) {
      logger.warn('📰 Weekly summary post skipped - WeeklySummaryService not injected');
      return;
    }
    if (!this.apiToggleService.isWeeklySummaryAutoEnabled()) {
      logger.info('📰 Weekly summary post skipped - auto toggle is OFF (admin-controlled)');
      return;
    }
    if (!this.apiToggleService.isTwitterEnabled()) {
      logger.warn('📰 Weekly summary post skipped - Twitter API is disabled');
      return;
    }
    if (this.isProcessingWeeklyPost) {
      logger.warn('📰 Weekly summary post skipped - previous run still in flight');
      return;
    }

    let pending;
    try {
      pending = await this.databaseService.getCurrentPendingWeeklySummary();
    } catch (error: any) {
      logger.error('📰 Failed to fetch pending summary - aborting post:', error.message);
      return;
    }

    if (!pending || pending.id === undefined) {
      logger.warn(
        '📰 Weekly summary post skipped - no pending row found. Gen at 19:00 may have failed; ' +
          'NOT auto-generating now to avoid posting a low-quality last-minute thread.',
      );
      return;
    }

    // Stale-row check: anything generated >24h ago is treated as not-this-week.
    const generatedMs = new Date(pending.generatedAt).getTime();
    const ageHours = (Date.now() - generatedMs) / (1000 * 60 * 60);
    if (!Number.isFinite(generatedMs) || ageHours > 24) {
      logger.warn(
        `📰 Weekly summary post skipped - pending row id=${pending.id} is stale ` +
          `(generated ${ageHours.toFixed(1)}h ago, expected <24h). Discard it manually if no longer wanted.`,
      );
      return;
    }

    this.isProcessingWeeklyPost = true;
    const startTime = Date.now();
    logger.info(`📰 Starting weekly summary post for id=${pending.id} (generated ${ageHours.toFixed(1)}h ago)...`);

    try {
      await this.weeklySummaryService.post(pending.id);
      const elapsed = Date.now() - startTime;
      logger.info(`📰 Weekly summary post completed in ${elapsed}ms - id=${pending.id}`);
    } catch (error: any) {
      logger.error(`📰 Weekly summary post failed for id=${pending.id}:`, error.message);
      logger.error(error.stack);
    } finally {
      this.isProcessingWeeklyPost = false;
    }
  }

  getStatus(): {
    isRunning: boolean;
    lastRunTime: Date | null;
    nextRunTime: Date | null;
    nextSalesRunTime: Date | null;
    nextRegistrationRunTime: Date | null;
    nextGrailsRunTime: Date | null;
    nextWeeklyGenRunTime: Date | null;
    nextWeeklyPostRunTime: Date | null;
    grailsEnabled: boolean;
    weeklySummaryEnabled: boolean;
    lastRunStats: any;
    consecutiveErrors: number;
    uptime: number;
  } {
    const nextSalesRunTime = this.salesSyncJob ? this.salesSyncJob.nextDate().toJSDate() : null;
    const nextRegistrationRunTime = this.registrationSyncJob ? this.registrationSyncJob.nextDate().toJSDate() : null;
    const nextGrailsRunTime = this.grailsSyncJob ? this.grailsSyncJob.nextDate().toJSDate() : null;
    const nextWeeklyGenRunTime = this.weeklySummaryGenJob ? this.weeklySummaryGenJob.nextDate().toJSDate() : null;
    const nextWeeklyPostRunTime = this.weeklySummaryPostJob ? this.weeklySummaryPostJob.nextDate().toJSDate() : null;

    let nextRunTime = null;
    const allNextTimes = [
      nextSalesRunTime,
      nextRegistrationRunTime,
      nextGrailsRunTime,
      nextWeeklyGenRunTime,
      nextWeeklyPostRunTime,
    ].filter(t => t !== null);
    if (allNextTimes.length > 0) {
      nextRunTime = new Date(Math.min(...allNextTimes.map(t => t!.getTime())));
    }

    return {
      isRunning: this.isRunning,
      lastRunTime: this.lastRunTime,
      nextRunTime,
      nextSalesRunTime,
      nextRegistrationRunTime,
      nextGrailsRunTime,
      nextWeeklyGenRunTime,
      nextWeeklyPostRunTime,
      grailsEnabled: this.grailsApiService !== null,
      weeklySummaryEnabled: this.weeklySummaryService !== null,
      lastRunStats: this.lastRunStats,
      consecutiveErrors: this.consecutiveErrors,
      uptime: this.lastRunTime ? Date.now() - this.lastRunTime.getTime() : 0
    };
  }

  /**
   * Manually trigger sync (doesn't affect the schedule).
   * Sales handled by QuickNode webhooks (real-time), Registration tweets by DatabaseEventService.
   */
  async triggerManualSync(): Promise<{
    success: boolean;
    stats?: any;
    error?: string;
  }> {
    try {
      logger.info('Manual sync triggered - running registration and Grails bid processing');
      
      await this.runSalesSync();
      await this.runRegistrationSync();
      await this.runGrailsSync();
      
      return {
        success: true,
        stats: { message: 'Registration and Grails bid sync completed (sales handled by QuickNode webhooks)' }
      };
    } catch (error: any) {
      logger.error('Manual sync failed:', error.message);
      return {
        success: false,
        error: error.message
      };
    }
  }

  resetErrorCounter(): void {
    this.consecutiveErrors = 0;
    logger.info('Scheduler error counter reset');
  }

  getUpcomingRuns(count: number = 5): { sales: Date[], registrations: Date[], grails: Date[] } {
    if (!this.salesSyncJob || !this.registrationSyncJob) {
      return { sales: [], registrations: [], grails: [] };
    }

    const salesRuns: Date[] = [];
    const registrationRuns: Date[] = [];
    const grailsRuns: Date[] = [];
    
    for (let i = 0; i < count; i++) {
      const nextSalesRun = new Date(this.salesSyncJob.nextDate().toJSDate());
      nextSalesRun.setMinutes(nextSalesRun.getMinutes() + (i * 5));
      salesRuns.push(nextSalesRun);
    }
    
    for (let i = 0; i < count; i++) {
      const nextRegRun = new Date(this.registrationSyncJob.nextDate().toJSDate());
      nextRegRun.setMinutes(nextRegRun.getMinutes() + i);
      registrationRuns.push(nextRegRun);
    }
    
    if (this.grailsSyncJob) {
      for (let i = 0; i < count; i++) {
        const nextGrailsRun = new Date(this.grailsSyncJob.nextDate().toJSDate());
        nextGrailsRun.setMinutes(nextGrailsRun.getMinutes() + i);
        grailsRuns.push(nextGrailsRun);
      }
    }
    
    return { sales: salesRuns, registrations: registrationRuns, grails: grailsRuns };
  }

  isHealthy(): boolean {
    return this.isRunning && this.consecutiveErrors < this.maxConsecutiveErrors;
  }
}
