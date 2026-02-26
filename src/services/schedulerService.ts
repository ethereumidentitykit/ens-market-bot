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
  private bidsSyncJob: CronJob | null = null;
  private grailsSyncJob: CronJob | null = null;
  private isRunning: boolean = false;
  private lastRunTime: Date | null = null;
  private lastRunStats: any = null;
  private consecutiveErrors: number = 0;
  private maxConsecutiveErrors: number = 5;
  
  // Processing locks to prevent race conditions
  private isProcessingSales: boolean = false;
  private isProcessingRegistrations: boolean = false;
  private isProcessingBids: boolean = false;
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

  /**
   * Initialize scheduler state from database
   */
  async initializeFromDatabase(): Promise<void> {
    try {
      logger.info('🔄 Initializing scheduler from database...');
      
      // Add a small delay to ensure database is fully ready
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
      
      // Log more details for debugging VPS deployment issues
      if (error.code) {
        logger.error(`Database error code: ${error.code}`);
      }
    }
  }

  /**
   * Start the automated scheduling
   * Sales: every 5 minutes, Registrations: every 1 minute, Bids: every 2 minutes
   * NOTE: Registration tweet processing is handled in real-time by DatabaseEventService
   */
  async start(): Promise<void> {
    // Stop existing jobs if running
    if (this.salesSyncJob || this.registrationSyncJob || this.bidsSyncJob || this.grailsSyncJob) {
      logger.warn('Scheduler already running, stopping existing jobs first');
      await this.stop();
    }

    // Create cron job for sales processing (every 5 minutes)
    this.salesSyncJob = new CronJob(
      '0 */5 * * * *', // Every 5 minutes at :00 seconds
      () => {
        this.runSalesSync();
      },
      null,
      false, // Don't start automatically
      'America/New_York' // Timezone
    );

    // Create cron job for registration processing (every 1 minute)
    this.registrationSyncJob = new CronJob(
      '0 * * * * *', // Every 1 minute at :00 seconds
      () => {
        this.runRegistrationSync();
      },
      null,
      false, // Don't start automatically
      'America/New_York' // Timezone
    );

    // Create cron job for bid processing (every 1 minute)
    this.bidsSyncJob = new CronJob(
      '0 * * * * *', // Every 1 minute at :00 seconds
      () => {
        this.runBidsSync();
      },
      null,
      false, // Don't start automatically
      'America/New_York' // Timezone
    );

    // Create cron job for Grails API polling (every 5 minutes)
    this.grailsSyncJob = new CronJob(
      '30 */5 * * * *', // Every 5 minutes at :30 seconds (offset from sales)
      () => {
        this.runGrailsSync();
      },
      null,
      false, // Don't start automatically
      'America/New_York' // Timezone
    );

    this.salesSyncJob.start();
    this.registrationSyncJob.start();
    this.bidsSyncJob.start();
    this.grailsSyncJob.start();
    this.isRunning = true;
    
    // Save enabled state to database for persistence across restarts
    await this.saveSchedulerState(true);
    
    logger.info('Scheduler started - Sales: every 5 minutes, Registrations: every 1 minute, Bids: every 1 minute, Grails: every 5 minutes');
    logger.info('Tweet processing: REAL-TIME via DatabaseEventService for QuickNode data');
    logger.info(`Next sales run: ${this.salesSyncJob.nextDate().toString()}`);
    logger.info(`Next registration run: ${this.registrationSyncJob.nextDate().toString()}`);
    logger.info(`Next bid run: ${this.bidsSyncJob.nextDate().toString()}`);
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
    
    // Registration sync job is already disabled (handled by DatabaseEventService)
    if (this.registrationSyncJob) {
      this.registrationSyncJob.stop();
      this.registrationSyncJob = null;
      wasRunning = true;
    }
    
    if (this.bidsSyncJob) {
      this.bidsSyncJob.stop();
      this.bidsSyncJob = null;
      wasRunning = true;
    }
    
    if (this.grailsSyncJob) {
      this.grailsSyncJob.stop();
      this.grailsSyncJob = null;
      wasRunning = true;
    }
    
    if (wasRunning) {
      this.isRunning = false;
      
      // Save disabled state to database for persistence across restarts
      await this.saveSchedulerState(false);
      
      logger.info('💾 Scheduler state persisted: DISABLED (survives restarts)');
    logger.info('Scheduler stopped - sales, registration, bid, and Grails processing halted');
    logger.info('Registration tweet processing continues via real-time DatabaseEventService');
    } else {
      logger.info('Scheduler was not running');
    }
  }

  /**
   * Gracefully stop scheduler without persisting state (for app restarts)
   */
  async gracefulShutdown(): Promise<void> {
    if (this.salesSyncJob) {
      this.salesSyncJob.stop();
      this.salesSyncJob = null;
    }
    
    // Registration sync job is already disabled (handled by DatabaseEventService)
    if (this.registrationSyncJob) {
      this.registrationSyncJob.stop();
      this.registrationSyncJob = null;
    }
    
    if (this.bidsSyncJob) {
      this.bidsSyncJob.stop();
      this.bidsSyncJob = null;
    }
    
    if (this.grailsSyncJob) {
      this.grailsSyncJob.stop();
      this.grailsSyncJob = null;
    }
    
    this.isRunning = false;
    
    // Don't persist state change - allows scheduler to resume after restart
    logger.info('Scheduler gracefully stopped (state preserved for restart)');
    logger.info('Registration tweet processing continues via real-time DatabaseEventService');
  }

  /**
   * Force stop all scheduler activity
   */
  async forceStop(): Promise<void> {
    this.isRunning = false;
    
    if (this.salesSyncJob) {
      this.salesSyncJob.stop();
      this.salesSyncJob = null;
    }
    
    // Registration sync job is already disabled (handled by DatabaseEventService)
    if (this.registrationSyncJob) {
      this.registrationSyncJob.stop();
      this.registrationSyncJob = null;
    }
    
    if (this.bidsSyncJob) {
      this.bidsSyncJob.stop();
      this.bidsSyncJob = null;
    }
    
    if (this.grailsSyncJob) {
      this.grailsSyncJob.stop();
      this.grailsSyncJob = null;
    }
    
    // Save disabled state to database for persistence across restarts
    await this.saveSchedulerState(false);
    
    logger.info('Scheduler force stopped - sales, registration, bid, and Grails processing halted');
    logger.info('Registration tweet processing continues via real-time DatabaseEventService');
  }

  /**
   * Save scheduler enabled/disabled state to database
   */
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
   * Execute the sales sync process (runs every 5 minutes)
   * QuickNode webhooks handle all sales ingestion in real-time.
   * This is kept as a heartbeat / placeholder for future maintenance tasks.
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
   * Execute the registration sync process (runs every 1 minute)
   * Registration data ingestion handled by QuickNode webhooks.
   * Tweet processing handled by DatabaseEventService via NOTIFY/LISTEN.
   * Kept for potential future maintenance tasks.
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
   * Execute the bid sync process (runs every 2 minutes)
   */
  private async runBidsSync(): Promise<void> {
    if (!this.isRunning) {
      logger.debug('Skipping bid sync - scheduler is stopped');
      return;
    }

    if (this.isProcessingBids) {
      logger.info('⏳ Bid sync skipped - previous batch still processing');
      return;
    }

    this.isProcessingBids = true;
    const startTime = new Date();
    logger.info('Starting bid sync...');

    try {
      // Step 1: Process new bids from Magic Eden API
      const processingResult = await this.bidsProcessingService.processNewBids();
      
      // ⚠️ SCHEDULED BID AUTO-POSTING DISABLED ⚠️
      // Real-time database notifications (databaseEventService) now handle all bid auto-posting
      // This prevents duplicate posts caused by racing between scheduled polling and real-time triggers
      // Magic Eden API ingestion (above) remains active to fetch new bids into the database
      
      logger.debug('✅ Scheduled bid polling disabled - real-time notifications handle auto-posting');
      
      const unpostedBids: any[] = []; // Empty for stats
      const bidAutoPostResults: PostResult[] = [];

      const duration = Date.now() - startTime.getTime();
      const bidsPosted = bidAutoPostResults.filter(r => r.success).length;
      
      logger.info(`Bid sync completed in ${duration}ms:`, {
        newBidsProcessed: processingResult.newBids || 0,
        unpostedFound: unpostedBids.length,
        bidsAutoPosted: bidsPosted
      });

      // Log bid processing summary
      if (processingResult.newBids && processingResult.newBids > 0) {
        logger.info(`📊 New bids processed: ${processingResult.newBids} (${processingResult.duplicates || 0} duplicates, ${processingResult.filtered || 0} filtered)`);
      }
      
      if (unpostedBids.length > 0) {
        logger.info(`✋ Processed ${unpostedBids.length} bids: ${bidsPosted} posted, ${bidAutoPostResults.filter(r => r.skipped).length} skipped, ${bidAutoPostResults.filter(r => !r.success && !r.skipped).length} failed`);
      }
      
      if (bidsPosted > 0) {
        logger.info(`🐦 Posted ${bidsPosted} bid tweets`);
      }

    } catch (error: any) {
      logger.error(`Bid sync failed:`, error.message);
      this.consecutiveErrors++;
      
      // Auto-disable after too many consecutive errors
      if (this.consecutiveErrors >= this.maxConsecutiveErrors) {
        logger.error(`Maximum consecutive errors (${this.maxConsecutiveErrors}) reached. Stopping scheduler.`);
        this.stop();
      }
    } finally {
      this.isProcessingBids = false;
    }
  }

  /**
   * Execute the Grails API sync process (runs every 5 minutes)
   * Fetches offers from Grails marketplace that Magic Eden doesn't pick up
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
      // Fetch new offers from Grails API
      const offers = await this.grailsApiService.fetchNewOffers();
      
      if (offers.length === 0) {
        logger.info('🍷 Grails sync complete - no new offers');
      } else {
        // Process offers through BidsProcessingService
        const stats = await this.bidsProcessingService.processGrailsBids(offers);
        
        const duration = Date.now() - startTime.getTime();
        logger.info(`🍷 Grails sync completed in ${duration}ms:`, {
          fetched: offers.length,
          stored: stats.newBids,
          duplicates: stats.duplicates,
          filtered: stats.filtered,
          errors: stats.errors
        });
      }

    } catch (error: any) {
      logger.error(`🍷 Grails sync failed:`, error.message);
      // Don't increment consecutiveErrors for Grails - it's supplementary
    } finally {
      this.isProcessingGrails = false;
    }
  }

  /**
   * Get scheduler status and statistics
   */
  getStatus(): {
    isRunning: boolean;
    lastRunTime: Date | null;
    nextRunTime: Date | null;  // Backward compatibility - shows nearest upcoming run
    nextSalesRunTime: Date | null;
    nextRegistrationRunTime: Date | null;
    nextBidsRunTime: Date | null;
    nextGrailsRunTime: Date | null;
    grailsEnabled: boolean;
    lastRunStats: any;
    consecutiveErrors: number;
    uptime: number;
  } {
    const nextSalesRunTime = this.salesSyncJob ? this.salesSyncJob.nextDate().toJSDate() : null;
    const nextRegistrationRunTime = this.registrationSyncJob ? this.registrationSyncJob.nextDate().toJSDate() : null;
    const nextBidsRunTime = this.bidsSyncJob ? this.bidsSyncJob.nextDate().toJSDate() : null;
    const nextGrailsRunTime = this.grailsSyncJob ? this.grailsSyncJob.nextDate().toJSDate() : null;
    
    // For backward compatibility, show the nearest upcoming run
    let nextRunTime = null;
    const allNextTimes = [nextSalesRunTime, nextRegistrationRunTime, nextBidsRunTime, nextGrailsRunTime].filter(t => t !== null);
    if (allNextTimes.length > 0) {
      nextRunTime = new Date(Math.min(...allNextTimes.map(t => t!.getTime())));
    }

    return {
      isRunning: this.isRunning,
      lastRunTime: this.lastRunTime,
      nextRunTime, // Backward compatibility
      nextSalesRunTime,
      nextRegistrationRunTime,
      nextBidsRunTime,
      nextGrailsRunTime,
      grailsEnabled: this.grailsApiService !== null,
      lastRunStats: this.lastRunStats,
      consecutiveErrors: this.consecutiveErrors,
      uptime: this.lastRunTime ? Date.now() - this.lastRunTime.getTime() : 0
    };
  }

  /**
   * Manually trigger sales, registration, and bid sync (doesn't affect the schedule)
   * NOTE: Sales handled by QuickNode webhooks (real-time), Registration handled by DatabaseEventService (real-time)
   */
  async triggerManualSync(): Promise<{
    success: boolean;
    stats?: any;
    error?: string;
  }> {
    try {
      logger.info('Manual sync triggered - running registration, bid, and Grails processing');
      logger.info('Sales: QuickNode webhooks (real-time), Registration tweets: DatabaseEventService (real-time)');
      
      // Run all sync methods manually (sales sync is now a no-op)
      await this.runSalesSync(); // No-op: QuickNode handles sales
      await this.runRegistrationSync();
      await this.runBidsSync();
      await this.runGrailsSync();
      
      return {
        success: true,
        stats: { message: 'Registration, bid, and Grails sync completed (sales handled by QuickNode webhooks)' }
      };
    } catch (error: any) {
      logger.error('Manual sync failed:', error.message);
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Reset error counter (useful for recovery)
   */
  resetErrorCounter(): void {
    this.consecutiveErrors = 0;
    logger.info('Scheduler error counter reset');
  }

  /**
   * Get next few scheduled run times for monitoring
   */
  getUpcomingRuns(count: number = 5): { sales: Date[], registrations: Date[], bids: Date[], grails: Date[] } {
    if (!this.salesSyncJob || !this.registrationSyncJob || !this.bidsSyncJob) {
      return { sales: [], registrations: [], bids: [], grails: [] };
    }

    const salesRuns: Date[] = [];
    const registrationRuns: Date[] = [];
    const bidRuns: Date[] = [];
    const grailsRuns: Date[] = [];
    
    // Get next few sales runs (every 5 minutes)
    let currentTime = new Date();
    for (let i = 0; i < count; i++) {
      const nextSalesRun = new Date(this.salesSyncJob.nextDate().toJSDate());
      nextSalesRun.setMinutes(nextSalesRun.getMinutes() + (i * 5));
      salesRuns.push(nextSalesRun);
    }
    
    // Get next few registration runs (every 1 minute)  
    for (let i = 0; i < count; i++) {
      const nextRegRun = new Date(this.registrationSyncJob.nextDate().toJSDate());
      nextRegRun.setMinutes(nextRegRun.getMinutes() + i);
      registrationRuns.push(nextRegRun);
    }
    
    // Get next few bid runs (every 1 minute)
    for (let i = 0; i < count; i++) {
      const nextBidRun = new Date(this.bidsSyncJob.nextDate().toJSDate());
      nextBidRun.setMinutes(nextBidRun.getMinutes() + i);
      bidRuns.push(nextBidRun);
    }
    
    // Get next few Grails runs (every 5 minutes)
    if (this.grailsSyncJob) {
      for (let i = 0; i < count; i++) {
        const nextGrailsRun = new Date(this.grailsSyncJob.nextDate().toJSDate());
        nextGrailsRun.setMinutes(nextGrailsRun.getMinutes() + (i * 5));
        grailsRuns.push(nextGrailsRun);
      }
    }
    
    return { sales: salesRuns, registrations: registrationRuns, bids: bidRuns, grails: grailsRuns };
  }

  /**
   * Check if scheduler is healthy
   */
  isHealthy(): boolean {
    return this.isRunning && this.consecutiveErrors < this.maxConsecutiveErrors;
  }


}
