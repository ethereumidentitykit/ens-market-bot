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
  
  // Processing locks to prevent race conditions
  private isProcessingSales: boolean = false;
  private isProcessingRegistrations: boolean = false;
  private isProcessingBids: boolean = false;

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
   * NOTE: Registration tweet processing is handled in real-time by DatabaseEventService
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

    this.salesSyncJob.start();
    this.registrationSyncJob.start();
    this.bidsSyncJob.start();
    this.isRunning = true;
    
    // Save enabled state to database for persistence across restarts
    await this.saveSchedulerState(true);
    
    logger.info('Scheduler started - Sales: every 5 minutes, Registrations: every 1 minute, Bids: every 1 minute');
    logger.info('Tweet processing: REAL-TIME via DatabaseEventService for both Moralis and QuickNode data');
    logger.info(`Next sales run: ${this.salesSyncJob.nextDate().toString()}`);
    logger.info(`Next registration run: ${this.registrationSyncJob.nextDate().toString()}`);
    logger.info(`Next bid run: ${this.bidsSyncJob.nextDate().toString()}`);
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
    
    if (wasRunning) {
      this.isRunning = false;
      
      // Save disabled state to database for persistence across restarts
      await this.saveSchedulerState(false);
      
      logger.info('💾 Scheduler state persisted: DISABLED (survives restarts)');
    logger.info('Scheduler stopped - sales, registration, and bid processing halted');
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
    
    // Save disabled state to database for persistence across restarts
    await this.saveSchedulerState(false);
    
    logger.info('Scheduler force stopped - sales, registration, and bid processing halted');
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
   * NOTE: Moralis sales processing disabled - QuickNode webhooks handle all sales in real-time
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
    logger.info('Starting sales sync...');

    try {
      // Refresh NTP time cache before processing
      await this.autoTweetService.refreshTimeCache();
      
      // ⚠️ MORALIS SALES PROCESSING DISABLED ⚠️
      // QuickNode webhooks now handle ALL sales ingestion in real-time
      // Moralis was causing duplicates due to incorrect log_index extraction
      // and never provided data that QuickNode didn't already capture
      
      logger.info(`✅ Sales sync skipped - QuickNode webhooks handle all sales in real-time`);
      
      // Mock result for stats tracking
      const moralisResult = {
        fetched: 0,
        newSales: 0,
        duplicates: 0,
        filtered: 0,
        errors: 0
      };
      
      this.lastRunTime = startTime;
      this.lastRunStats = moralisResult;
      this.consecutiveErrors = 0; // Reset error counter on success

      const duration = Date.now() - startTime.getTime();
      
      logger.info(`Sales sync completed in ${duration}ms:`, {
        fetched: moralisResult.fetched,
        newSales: moralisResult.newSales,
        duplicates: moralisResult.duplicates,
        errors: moralisResult.errors
      });
      
      if (moralisResult.errors > 0) {
        logger.warn(`⚠️ Encountered ${moralisResult.errors} errors during Moralis processing`);
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
    } finally {
      this.isProcessingSales = false;
    }
  }

  /**
   * Execute the registration sync process (runs every 1 minute)
   * NOTE: Registration data ingestion handled by Moralis (/webhook/ens-registrations) and QuickNode webhooks
   * NOTE: Registration tweet processing is now handled by DatabaseEventService via NOTIFY/LISTEN
   * This method is kept for potential future registration maintenance tasks
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
      // Registration data ingestion: Handled by multiple webhooks:
      // - Moralis webhook: /webhook/ens-registrations (fallback)
      // - QuickNode webhook: /webhook/quicknode-registrations (primary)
      // Both store to database with duplicate protection
      
      // Registration tweet processing: Handled by DatabaseEventService via NOTIFY/LISTEN
      // This provides instant real-time processing when registrations are stored in database
      
      // Future: Add any registration maintenance tasks here (e.g., data cleanup, analytics)
      
      const duration = Date.now() - startTime.getTime();
      
      logger.debug(`Registration sync completed in ${duration}ms - dual webhook ingestion active (Moralis fallback + QuickNode primary)`);

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
      
      // Load auto-posting settings first to get age limits
      const autoPostSettings = await this.autoTweetService.getSettings();
      
      // Step 2: Auto-post unposted bids if enabled (with age filtering at database level)
      const unpostedBids = await this.databaseService.getUnpostedBids(10, autoPostSettings.bids.maxAgeHours);
      let bidAutoPostResults: PostResult[] = [];
      
      if (unpostedBids.length > 0) {
        // Check global AND bids-specific toggles
        if (autoPostSettings.enabled && autoPostSettings.bids.enabled) {
          logger.info(`✋ Auto-posting ${unpostedBids.length} unposted bids (within ${autoPostSettings.bids.maxAgeHours}h)...`);
          bidAutoPostResults = await this.autoTweetService.processNewBids(unpostedBids, autoPostSettings);
          
          const posted = bidAutoPostResults.filter(r => r.success).length;
          const skipped = bidAutoPostResults.filter(r => r.skipped).length;
          const failed = bidAutoPostResults.filter(r => !r.success && !r.skipped).length;
          
          logger.info(`✋ Bid auto-posting results: ${posted} posted, ${skipped} skipped, ${failed} failed`);
        } else {
          logger.debug(`✋ Skipping bids auto-posting - Global: ${autoPostSettings.enabled}, Bids: ${autoPostSettings.bids.enabled}`);
        }
      } else {
        logger.debug(`✋ No unposted bids found within ${autoPostSettings.bids.maxAgeHours} hours`);
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
    } finally {
      this.isProcessingBids = false;
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
   * Manually trigger sales, registration, and bid sync (doesn't affect the schedule)
   * NOTE: Sales handled by QuickNode webhooks (real-time), Registration handled by DatabaseEventService (real-time)
   */
  async triggerManualSync(): Promise<{
    success: boolean;
    stats?: any;
    error?: string;
  }> {
    try {
      logger.info('Manual sync triggered - running registration and bid processing');
      logger.info('Sales: QuickNode webhooks (real-time), Registration tweets: DatabaseEventService (real-time)');
      
      // Run all sync methods manually (sales sync is now a no-op)
      await this.runSalesSync(); // No-op: QuickNode handles sales
      await this.runRegistrationSync();
      await this.runBidsSync();
      
      return {
        success: true,
        stats: { message: 'Registration and bid sync completed (sales handled by QuickNode webhooks)' }
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
    
    // Get next few bid runs (every 1 minute)
    for (let i = 0; i < count; i++) {
      const nextBidRun = new Date(this.bidsSyncJob.nextDate().toJSDate());
      nextBidRun.setMinutes(nextBidRun.getMinutes() + i);
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
