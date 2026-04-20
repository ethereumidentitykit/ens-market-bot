import { CronJob } from 'cron';
import { BidsProcessingService } from './bidsProcessingService';
import { GrailsApiService } from './grailsApiService';
import { AutoTweetService, AutoPostSettings, PostResult } from './autoTweetService';
import { APIToggleService } from './apiToggleService';
import { logger } from '../utils/logger';
import { IDatabaseService } from '../types';

export class SchedulerService {
  private bidsProcessingService: BidsProcessingService;
  private grailsApiService: GrailsApiService | null = null;
  private autoTweetService: AutoTweetService;
  private apiToggleService: APIToggleService;
  private databaseService: IDatabaseService;
  private salesSyncJob: CronJob | null = null;
  private registrationSyncJob: CronJob | null = null;
  private grailsSyncJob: CronJob | null = null;
  private isRunning: boolean = false;
  private lastRunTime: Date | null = null;
  private lastRunStats: any = null;
  private consecutiveErrors: number = 0;
  private maxConsecutiveErrors: number = 5;
  
  private isProcessingSales: boolean = false;
  private isProcessingRegistrations: boolean = false;
  private isProcessingGrails: boolean = false;

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
   * Registration tweet processing is handled in real-time by DatabaseEventService.
   */
  async start(): Promise<void> {
    if (this.salesSyncJob || this.registrationSyncJob || this.grailsSyncJob) {
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

    this.salesSyncJob.start();
    this.registrationSyncJob.start();
    this.grailsSyncJob.start();
    this.isRunning = true;
    
    await this.saveSchedulerState(true);
    
    logger.info('Scheduler started - Sales: every 5 minutes, Registrations: every 1 minute, Grails bids: every 1 minute');
    logger.info('Tweet processing: REAL-TIME via DatabaseEventService for QuickNode data');
    logger.info(`Next sales run: ${this.salesSyncJob.nextDate().toString()}`);
    logger.info(`Next registration run: ${this.registrationSyncJob.nextDate().toString()}`);
    logger.info(`Next Grails run: ${this.grailsSyncJob.nextDate().toString()}`);
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
    
    if (wasRunning) {
      this.isRunning = false;
      await this.saveSchedulerState(false);
      logger.info('💾 Scheduler state persisted: DISABLED (survives restarts)');
      logger.info('Scheduler stopped - sales, registration, and bid processing halted');
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

  getStatus(): {
    isRunning: boolean;
    lastRunTime: Date | null;
    nextRunTime: Date | null;
    nextSalesRunTime: Date | null;
    nextRegistrationRunTime: Date | null;
    nextGrailsRunTime: Date | null;
    grailsEnabled: boolean;
    lastRunStats: any;
    consecutiveErrors: number;
    uptime: number;
  } {
    const nextSalesRunTime = this.salesSyncJob ? this.salesSyncJob.nextDate().toJSDate() : null;
    const nextRegistrationRunTime = this.registrationSyncJob ? this.registrationSyncJob.nextDate().toJSDate() : null;
    const nextGrailsRunTime = this.grailsSyncJob ? this.grailsSyncJob.nextDate().toJSDate() : null;
    
    let nextRunTime = null;
    const allNextTimes = [nextSalesRunTime, nextRegistrationRunTime, nextGrailsRunTime].filter(t => t !== null);
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
      grailsEnabled: this.grailsApiService !== null,
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
