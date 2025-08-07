import { CronJob } from 'cron';
import { SalesProcessingService } from './salesProcessingService';
import { logger } from '../utils/logger';

export class SchedulerService {
  private salesProcessingService: SalesProcessingService;
  private syncJob: CronJob | null = null;
  private isRunning: boolean = false;
  private lastRunTime: Date | null = null;
  private lastRunStats: any = null;
  private consecutiveErrors: number = 0;
  private maxConsecutiveErrors: number = 5;

  constructor(salesProcessingService: SalesProcessingService) {
    this.salesProcessingService = salesProcessingService;
  }

  /**
   * Start the automated scheduling
   * Runs every 5 minutes as requested
   */
  start(): void {
    if (this.syncJob) {
      logger.warn('Scheduler already running');
      return;
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
      logger.info('Scheduler stopped');
    }
  }

  /**
   * Execute the scheduled sync process
   */
  private async runScheduledSync(): Promise<void> {
    if (!this.isRunning) {
      return;
    }

    const startTime = new Date();
    logger.info('Starting scheduled sales sync...');

    try {
      // Process new sales
      const result = await this.salesProcessingService.processNewSales();
      
      this.lastRunTime = startTime;
      this.lastRunStats = result;
      this.consecutiveErrors = 0; // Reset error counter on success

      const duration = Date.now() - startTime.getTime();
      
      logger.info(`Scheduled sync completed in ${duration}ms:`, {
        fetched: result.fetched,
        newSales: result.newSales,
        duplicates: result.duplicates,
        errors: result.errors
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
