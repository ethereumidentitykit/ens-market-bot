import { CronJob } from 'cron';
import { SalesProcessingService } from './salesProcessingService';
import { AutoTweetService, AutoPostSettings, PostResult } from './autoTweetService';
import { APIToggleService } from './apiToggleService';
import { logger } from '../utils/logger';
import { IDatabaseService } from '../types';

export class SchedulerService {
  private salesProcessingService: SalesProcessingService;
  private autoTweetService: AutoTweetService;
  private apiToggleService: APIToggleService;
  private databaseService: IDatabaseService;
  private syncJob: CronJob | null = null;
  private isRunning: boolean = false;
  private lastRunTime: Date | null = null;
  private lastRunStats: any = null;
  private consecutiveErrors: number = 0;
  private maxConsecutiveErrors: number = 5;

  constructor(
    salesProcessingService: SalesProcessingService, 
    autoTweetService: AutoTweetService,
    databaseService: IDatabaseService
  ) {
    this.salesProcessingService = salesProcessingService;
    this.autoTweetService = autoTweetService;
    this.apiToggleService = APIToggleService.getInstance();
    this.databaseService = databaseService;
  }

  /**
   * Initialize scheduler state from database
   */
  async initializeFromDatabase(): Promise<void> {
    try {
      const savedState = await this.databaseService.getSystemState('scheduler_enabled');
      if (savedState === 'true') {
        logger.info('Scheduler was enabled, starting automatically...');
        this.start();
      } else {
        logger.info('Scheduler is disabled by default - use dashboard to start');
      }
    } catch (error: any) {
      logger.warn('Could not load scheduler state from database:', error.message);
      logger.info('Scheduler will remain stopped until manually started');
    }
  }

  /**
   * Start the automated scheduling
   * Runs every 5 minutes for more responsive data collection
   */
  start(): void {
    // Stop existing job if running
    if (this.syncJob) {
      logger.warn('Scheduler already running, stopping existing job first');
      this.stop();
    }

    // Create cron job for every 5 minutes
    this.syncJob = new CronJob(
      '0 */5 * * * *', // Every 5 minutes at :00 seconds
      () => {
        this.runScheduledSync();
      },
      null,
      false, // Don't start automatically
      'America/New_York' // Timezone
    );

    this.syncJob.start();
    this.isRunning = true;
    
    // Save enabled state to database
    this.saveSchedulerState(true);
    
    logger.info('Scheduler started - will run every 5 minutes');
    logger.info(`Next run scheduled for: ${this.syncJob.nextDate().toString()}`);
  }

  /**
   * Stop the automated scheduling
   */
  stop(): void {
    if (this.syncJob) {
      this.syncJob.stop();
      this.syncJob = null;
      this.isRunning = false;
      
      // Save disabled state to database
      this.saveSchedulerState(false);
      
      logger.info('Scheduler stopped');
    } else {
      logger.info('Scheduler was not running');
    }
  }

  /**
   * Force stop all scheduler activity
   */
  forceStop(): void {
    this.isRunning = false;
    if (this.syncJob) {
      this.syncJob.stop();
      this.syncJob = null;
    }
    
    // Save disabled state to database
    this.saveSchedulerState(false);
    
    logger.info('Scheduler force stopped - all activity halted');
  }

  /**
   * Save scheduler enabled/disabled state to database
   */
  private async saveSchedulerState(enabled: boolean): Promise<void> {
    try {
      await this.databaseService.setSystemState('scheduler_enabled', enabled.toString());
      logger.debug(`Scheduler state saved: ${enabled ? 'enabled' : 'disabled'}`);
    } catch (error: any) {
      logger.warn('Could not save scheduler state to database:', error.message);
    }
  }

  /**
   * Execute the scheduled sync process
   */
  private async runScheduledSync(): Promise<void> {
    if (!this.isRunning) {
      logger.debug('Skipping scheduled sync - scheduler is stopped');
      return;
    }

    const startTime = new Date();
    logger.info('Starting scheduled sales sync...');

    try {
      // Refresh NTP time cache before processing
      await this.autoTweetService.refreshTimeCache();
      
      // Process new sales
      const result = await this.salesProcessingService.processNewSales();
      
      // Auto-post new sales if enabled
      let autoPostResults: PostResult[] = [];
      if (result.newSales > 0 && result.processedSales.length > 0) {
        const autoPostSettings = await this.autoTweetService.getSettings();
        if (autoPostSettings.enabled && this.apiToggleService.isAutoPostingEnabled()) {
          logger.info(`🤖 Auto-posting ${result.processedSales.length} new sales...`);
          autoPostResults = await this.autoTweetService.processNewSales(result.processedSales, autoPostSettings);
          
          const posted = autoPostResults.filter(r => r.success).length;
          const skipped = autoPostResults.filter(r => r.skipped).length;
          const failed = autoPostResults.filter(r => !r.success && !r.skipped).length;
          
          logger.info(`🐦 Auto-posting results: ${posted} posted, ${skipped} skipped, ${failed} failed`);
        }
      }
      
      this.lastRunTime = startTime;
      this.lastRunStats = { ...result, autoPostResults };
      this.consecutiveErrors = 0; // Reset error counter on success

      const duration = Date.now() - startTime.getTime();
      
      logger.info(`Scheduled sync completed in ${duration}ms:`, {
        fetched: result.fetched,
        newSales: result.newSales,
        duplicates: result.duplicates,
        errors: result.errors,
        autoPosted: autoPostResults.filter(r => r.success).length
      });

      // Log notable events
      if (result.newSales > 0) {
        logger.info(`📈 Found ${result.newSales} new sales to process`);
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
   * Get scheduler status and statistics
   */
  getStatus(): {
    isRunning: boolean;
    lastRunTime: Date | null;
    nextRunTime: Date | null;
    lastRunStats: any;
    consecutiveErrors: number;
    uptime: number;
  } {
    return {
      isRunning: this.isRunning,
      lastRunTime: this.lastRunTime,
      nextRunTime: this.syncJob ? this.syncJob.nextDate().toJSDate() : null,
      lastRunStats: this.lastRunStats,
      consecutiveErrors: this.consecutiveErrors,
      uptime: this.lastRunTime ? Date.now() - this.lastRunTime.getTime() : 0
    };
  }

  /**
   * Manually trigger a sync (doesn't affect the schedule)
   */
  async triggerManualSync(): Promise<{
    success: boolean;
    stats?: any;
    error?: string;
  }> {
    try {
      logger.info('Manual sync triggered via scheduler service');
      const stats = await this.salesProcessingService.processNewSales();
      
      return {
        success: true,
        stats
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
  getUpcomingRuns(count: number = 5): Date[] {
    if (!this.syncJob) {
      return [];
    }

    const runs: Date[] = [];
    let currentTime = new Date();
    
    for (let i = 0; i < count; i++) {
      // Calculate next run time manually for multiple runs
      const nextRunMinutes = Math.ceil((currentTime.getMinutes() + 1) / 5) * 5 + (i * 5);
      const nextRun = new Date(currentTime);
      nextRun.setMinutes(nextRunMinutes, 0, 0);
      
      // If we've gone past the hour, adjust accordingly
      if (nextRun.getMinutes() >= 60) {
        nextRun.setHours(nextRun.getHours() + Math.floor(nextRun.getMinutes() / 60));
        nextRun.setMinutes(nextRun.getMinutes() % 60);
      }
      
      runs.push(nextRun);
    }
    
    return runs;
  }

  /**
   * Check if scheduler is healthy
   */
  isHealthy(): boolean {
    return this.isRunning && this.consecutiveErrors < this.maxConsecutiveErrors;
  }


}
