import { CronJob } from 'cron';
import { SalesProcessingService } from './salesProcessingService';
import { BidsProcessingService } from './bidsProcessingService';
import { AutoTweetService, AutoPostSettings, PostResult } from './autoTweetService';
import { APIToggleService } from './apiToggleService';
import { logger } from '../utils/logger';
import { IDatabaseService } from '../types';

export class SchedulerService {
  private salesProcessingService: SalesProcessingService;
  private bidsProcessingService: BidsProcessingService;
  private autoTweetService: AutoTweetService;
  private apiToggleService: APIToggleService;
  private databaseService: IDatabaseService;
  private salesSyncJob: CronJob | null = null;
  private registrationSyncJob: CronJob | null = null;
  private bidsSyncJob: CronJob | null = null;
  private isRunning: boolean = false;
  private lastRunTime: Date | null = null;
  private lastRunStats: any = null;
  private consecutiveErrors: number = 0;
  private maxConsecutiveErrors: number = 5;

  constructor(
    salesProcessingService: SalesProcessingService,
    bidsProcessingService: BidsProcessingService,
    autoTweetService: AutoTweetService,
    databaseService: IDatabaseService
  ) {
    this.salesProcessingService = salesProcessingService;
    this.bidsProcessingService = bidsProcessingService;
    this.autoTweetService = autoTweetService;
    this.apiToggleService = APIToggleService.getInstance();
    this.databaseService = databaseService;
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
   */
  async start(): Promise<void> {
    // Stop existing jobs if running
    if (this.salesSyncJob || this.registrationSyncJob || this.bidsSyncJob) {
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

    // Create cron job for bid processing (every 2 minutes)
    this.bidsSyncJob = new CronJob(
      '0 */2 * * * *', // Every 2 minutes at :00 seconds
      () => {
        this.runBidsSync();
      },
      null,
      false, // Don't start automatically
      'America/New_York' // Timezone
    );

    this.salesSyncJob.start();
    this.registrationSyncJob.start();
    this.bidsSyncJob.start();
    this.isRunning = true;
    
    // Save enabled state to database for persistence across restarts
    await this.saveSchedulerState(true);
    
    logger.info('Scheduler started - Sales: every 5 minutes, Registrations: every 1 minute, Bids: every 2 minutes');
    logger.info(`Next sales run: ${this.salesSyncJob.nextDate().toString()}`);
    logger.info(`Next registration run: ${this.registrationSyncJob.nextDate().toString()}`);
    logger.info(`Next bid run: ${this.bidsSyncJob.nextDate().toString()}`);
  }

  /**
   * Stop the automated scheduling
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
    
    if (this.bidsSyncJob) {
      this.bidsSyncJob.stop();
      this.bidsSyncJob = null;
      wasRunning = true;
    }
    
    if (wasRunning) {
      this.isRunning = false;
      
      // Save disabled state to database for persistence across restarts
      await this.saveSchedulerState(false);
      
      logger.info('Scheduler stopped - sales, registration, and bid processing halted');
    } else {
      logger.info('Scheduler was not running');
    }
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
    
    if (this.registrationSyncJob) {
      this.registrationSyncJob.stop();
      this.registrationSyncJob = null;
    }
    
    if (this.bidsSyncJob) {
      this.bidsSyncJob.stop();
      this.bidsSyncJob = null;
    }
    
    // Save disabled state to database for persistence across restarts
    await this.saveSchedulerState(false);
    
    logger.info('Scheduler force stopped - all activity halted');
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
   */
  private async runSalesSync(): Promise<void> {
    if (!this.isRunning) {
      logger.debug('Skipping sales sync - scheduler is stopped');
      return;
    }

    const startTime = new Date();
    logger.info('Starting sales sync...');

    try {
      // Refresh NTP time cache before processing
      await this.autoTweetService.refreshTimeCache();
      
      // Process new sales
      const result = await this.salesProcessingService.processNewSales();
      
      // Auto-post new sales if enabled
      let autoPostResults: PostResult[] = [];
      
      if (result.newSales > 0 && result.processedSales.length > 0) {
        const autoPostSettings = await this.autoTweetService.getSettings();
        // Check global AND sales-specific toggles
        if (autoPostSettings.enabled && autoPostSettings.sales.enabled) {
          logger.info(`🤖 Auto-posting ${result.processedSales.length} new sales...`);
          autoPostResults = await this.autoTweetService.processNewSales(result.processedSales, autoPostSettings);
          
          const posted = autoPostResults.filter(r => r.success).length;
          const skipped = autoPostResults.filter(r => r.skipped).length;
          const failed = autoPostResults.filter(r => !r.success && !r.skipped).length;
          
          logger.info(`🐦 Sales auto-posting results: ${posted} posted, ${skipped} skipped, ${failed} failed`);
        } else {
          logger.debug(`🤖 Skipping sales auto-posting - Global: ${autoPostSettings.enabled}, Sales: ${autoPostSettings.sales.enabled}`);
        }
      }
      
      this.lastRunTime = startTime;
      this.lastRunStats = { ...result, autoPostResults };
      this.consecutiveErrors = 0; // Reset error counter on success

      const duration = Date.now() - startTime.getTime();
      const salesPosted = autoPostResults.filter(r => r.success).length;
      
      logger.info(`Sales sync completed in ${duration}ms:`, {
        fetched: result.fetched,
        newSales: result.newSales,
        duplicates: result.duplicates,
        errors: result.errors,
        salesAutoPosted: salesPosted
      });

      // Log notable events
      if (result.newSales > 0) {
        logger.info(`📈 Found ${result.newSales} new sales to process`);
      }
      
      if (salesPosted > 0) {
        logger.info(`🐦 Posted ${salesPosted} sale tweets`);
      }
      
      if (result.errors > 0) {
        logger.warn(`⚠️ Encountered ${result.errors} errors during processing`);
      }

    } catch (error: any) {
      this.consecutiveErrors++;
      
      logger.error(`Scheduled sync failed (attempt ${this.consecutiveErrors}/${this.maxConsecutiveErrors}):`, error.message);
      
      this.lastRunStats = {
        success: false,
        error: error.message,
        consecutiveErrors: this.consecutiveErrors
      };

      // Stop scheduler if too many consecutive errors
      if (this.consecutiveErrors >= this.maxConsecutiveErrors) {
        logger.error(`Too many consecutive errors (${this.consecutiveErrors}). Stopping scheduler for safety.`);
        this.stop();
        
        // TODO: In a production system, this would trigger alerts
        // For now, just log the critical error
        logger.error('🚨 SCHEDULER STOPPED DUE TO REPEATED FAILURES - Manual intervention required');
      }
    }
  }

  /**
   * Execute the registration sync process (runs every 1 minute)
   */
  private async runRegistrationSync(): Promise<void> {
    if (!this.isRunning) {
      logger.debug('Skipping registration sync - scheduler is stopped');
      return;
    }

    const startTime = new Date();
    logger.info('Starting registration sync...');

    try {
      // Auto-post unposted registrations if enabled
      const unpostedRegistrations = await this.databaseService.getUnpostedRegistrations(10);
      let registrationAutoPostResults: PostResult[] = [];
      
      if (unpostedRegistrations.length > 0) {
        const autoPostSettings = await this.autoTweetService.getSettings();
        // Check global AND registrations-specific toggles
        if (autoPostSettings.enabled && autoPostSettings.registrations.enabled) {
          logger.info(`🏛️ Auto-posting ${unpostedRegistrations.length} unposted registrations...`);
          registrationAutoPostResults = await this.autoTweetService.processNewRegistrations(unpostedRegistrations, autoPostSettings);
          
          const posted = registrationAutoPostResults.filter(r => r.success).length;
          const skipped = registrationAutoPostResults.filter(r => r.skipped).length;
          const failed = registrationAutoPostResults.filter(r => !r.success && !r.skipped).length;
          
          logger.info(`🏛️ Registration auto-posting results: ${posted} posted, ${skipped} skipped, ${failed} failed`);
        } else {
          logger.debug(`🏛️ Skipping registrations auto-posting - Global: ${autoPostSettings.enabled}, Registrations: ${autoPostSettings.registrations.enabled}`);
        }
      }

      const duration = Date.now() - startTime.getTime();
      const registrationsPosted = registrationAutoPostResults.filter(r => r.success).length;
      
      logger.info(`Registration sync completed in ${duration}ms:`, {
        unpostedFound: unpostedRegistrations.length,
        registrationsAutoPosted: registrationsPosted
      });

      // Log registration processing summary
      if (unpostedRegistrations.length > 0) {
        logger.info(`🏛️ Processed ${unpostedRegistrations.length} registrations: ${registrationsPosted} posted, ${unpostedRegistrations.length - registrationsPosted} skipped/failed`);
      }
      
      if (registrationsPosted > 0) {
        logger.info(`🐦 Posted ${registrationsPosted} registration tweets`);
      }

    } catch (error: any) {
      logger.error(`Registration sync failed:`, error.message);
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

    const startTime = new Date();
    logger.info('Starting bid sync...');

    try {
      // Step 1: Process new bids from Magic Eden API
      const processingResult = await this.bidsProcessingService.processNewBids();
      
      // Step 2: Auto-post unposted bids if enabled
      const unpostedBids = await this.databaseService.getUnpostedBids(10);
      let bidAutoPostResults: PostResult[] = [];
      
      if (unpostedBids.length > 0) {
        const autoPostSettings = await this.autoTweetService.getSettings();
        // Check global AND bids-specific toggles
        if (autoPostSettings.enabled && autoPostSettings.bids.enabled) {
          logger.info(`✋ Auto-posting ${unpostedBids.length} unposted bids...`);
          bidAutoPostResults = await this.autoTweetService.processNewBids(unpostedBids, autoPostSettings);
          
          const posted = bidAutoPostResults.filter(r => r.success).length;
          const skipped = bidAutoPostResults.filter(r => r.skipped).length;
          const failed = bidAutoPostResults.filter(r => !r.success && !r.skipped).length;
          
          logger.info(`✋ Bid auto-posting results: ${posted} posted, ${skipped} skipped, ${failed} failed`);
        } else {
          logger.debug(`✋ Skipping bids auto-posting - Global: ${autoPostSettings.enabled}, Bids: ${autoPostSettings.bids.enabled}`);
        }
      }

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
    lastRunStats: any;
    consecutiveErrors: number;
    uptime: number;
  } {
    const nextSalesRunTime = this.salesSyncJob ? this.salesSyncJob.nextDate().toJSDate() : null;
    const nextRegistrationRunTime = this.registrationSyncJob ? this.registrationSyncJob.nextDate().toJSDate() : null;
    const nextBidsRunTime = this.bidsSyncJob ? this.bidsSyncJob.nextDate().toJSDate() : null;
    
    // For backward compatibility, show the nearest upcoming run
    let nextRunTime = null;
    const allNextTimes = [nextSalesRunTime, nextRegistrationRunTime, nextBidsRunTime].filter(t => t !== null);
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
      lastRunStats: this.lastRunStats,
      consecutiveErrors: this.consecutiveErrors,
      uptime: this.lastRunTime ? Date.now() - this.lastRunTime.getTime() : 0
    };
  }

  /**
   * Manually trigger both sales and registration sync (doesn't affect the schedule)
   */
  async triggerManualSync(): Promise<{
    success: boolean;
    stats?: any;
    error?: string;
  }> {
    try {
      logger.info('Manual sync triggered - running sales, registration, and bid processing');
      
      // Run all sync methods manually
      await this.runSalesSync();
      await this.runRegistrationSync();
      await this.runBidsSync();
      
      return {
        success: true,
        stats: { message: 'Sales, registration, and bid sync completed' }
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
  getUpcomingRuns(count: number = 5): { sales: Date[], registrations: Date[], bids: Date[] } {
    if (!this.salesSyncJob || !this.registrationSyncJob || !this.bidsSyncJob) {
      return { sales: [], registrations: [], bids: [] };
    }

    const salesRuns: Date[] = [];
    const registrationRuns: Date[] = [];
    const bidRuns: Date[] = [];
    
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
    
    // Get next few bid runs (every 2 minutes)
    for (let i = 0; i < count; i++) {
      const nextBidRun = new Date(this.bidsSyncJob.nextDate().toJSDate());
      nextBidRun.setMinutes(nextBidRun.getMinutes() + (i * 2));
      bidRuns.push(nextBidRun);
    }
    
    return { sales: salesRuns, registrations: registrationRuns, bids: bidRuns };
  }

  /**
   * Check if scheduler is healthy
   */
  isHealthy(): boolean {
    return this.isRunning && this.consecutiveErrors < this.maxConsecutiveErrors;
  }


}
