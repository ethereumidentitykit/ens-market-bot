import { Client } from 'pg';
import { logger } from '../utils/logger';
import { AutoTweetService } from './autoTweetService';
import { IDatabaseService } from '../types';

export class DatabaseEventService {
  private client: Client | null = null;
  private isListening = false;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private healthCheckTimer: NodeJS.Timeout | null = null;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 10;
  private isShuttingDown = false;

  // Services for processing notifications
  private autoTweetService: AutoTweetService;
  private databaseService: IDatabaseService;

  // Queue for handling multiple notifications
  private notificationQueue: number[] = [];
  private isProcessingQueue = false;

  constructor(
    autoTweetService: AutoTweetService,
    databaseService: IDatabaseService,
    connectionString: string
  ) {
    this.autoTweetService = autoTweetService;
    this.databaseService = databaseService;
    
    // Create client with connection string
    this.client = new Client({
      connectionString,
      // Connection pool settings for reliability
      keepAlive: true,
      keepAliveInitialDelayMillis: 10000,
    });
  }

  /**
   * Start the database event listener with robust connection management
   */
  async start(): Promise<void> {
    if (this.isShuttingDown) {
      logger.warn('Cannot start DatabaseEventService - service is shutting down');
      return;
    }

    logger.info('🎧 Starting DatabaseEventService...');
    
    // Always try to connect on startup
    await this.ensureConnection();
    
    // Check for unposted sales from previous session (startup recovery)
    await this.performStartupRecovery();
    
    // Set up periodic health check (every 30 seconds)
    this.healthCheckTimer = setInterval(() => {
      this.performHealthCheck();
    }, 30000);

    logger.info('✅ DatabaseEventService started with health monitoring');
  }

  /**
   * Stop the database event listener gracefully
   */
  async stop(): Promise<void> {
    this.isShuttingDown = true;
    logger.info('🛑 Stopping DatabaseEventService...');

    // Clear timers
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
      this.healthCheckTimer = null;
    }

    // Close database connection
    if (this.client) {
      try {
        await this.client.end();
        logger.info('✅ Database connection closed');
      } catch (error: any) {
        logger.warn('Warning closing database connection:', error.message);
      }
      this.client = null;
    }

    this.isListening = false;
    logger.info('✅ DatabaseEventService stopped');
  }

  /**
   * Ensure database connection is active and listening
   */
  private async ensureConnection(): Promise<void> {
    if (this.isShuttingDown) return;

    try {
      // Clean up existing connection if any
      if (this.client && this.client.listenerCount('error') > 0) {
        await this.client.end();
      }

      // Create fresh connection
      this.client = new Client({
        connectionString: process.env.DATABASE_URL,
        keepAlive: true,
        keepAliveInitialDelayMillis: 10000,
      });

      // Set up event handlers before connecting
      this.client.on('notification', this.handleNotification.bind(this));
      this.client.on('error', this.handleConnectionError.bind(this));
      this.client.on('end', this.handleConnectionEnd.bind(this));

      // Connect and start listening
      await this.client.connect();
      await this.client.query('LISTEN new_sale');
      
      this.isListening = true;
      this.reconnectAttempts = 0; // Reset on successful connection
      
      logger.info('✅ Database listener connected and listening for new_sale notifications');

    } catch (error: any) {
      this.isListening = false;
      logger.error('❌ Failed to connect database listener:', error.message);
      this.scheduleReconnect();
    }
  }

  /**
   * Handle incoming sale notifications
   */
  private handleNotification(msg: any): void {
    try {
      if (msg.channel === 'new_sale' && msg.payload) {
        const saleId = parseInt(msg.payload);
        
        if (isNaN(saleId)) {
          logger.warn(`Invalid sale ID in notification: ${msg.payload}`);
          return;
        }

        logger.info(`🚨 NEW SALE NOTIFICATION: ID ${saleId} - adding to queue`);
        
        // Add to queue for processing
        this.addToQueue(saleId);
      }
    } catch (error: any) {
      logger.error('Error handling notification:', error.message);
    }
  }

  /**
   * Add sale ID to processing queue
   */
  private addToQueue(saleId: number): void {
    // Avoid duplicates in queue
    if (!this.notificationQueue.includes(saleId)) {
      this.notificationQueue.push(saleId);
      logger.info(`📦 Added sale ${saleId} to queue (queue length: ${this.notificationQueue.length})`);
    }

    // Start processing if not already running
    if (!this.isProcessingQueue) {
      this.processQueue();
    }
  }

  /**
   * Process the notification queue with proper rate limiting
   */
  private async processQueue(): Promise<void> {
    if (this.isProcessingQueue || this.notificationQueue.length === 0) {
      return;
    }

    this.isProcessingQueue = true;
    logger.info(`🔄 Starting queue processing (${this.notificationQueue.length} sales)`);

    while (this.notificationQueue.length > 0 && !this.isShuttingDown) {
      const saleId = this.notificationQueue.shift()!;
      
      try {
        await this.processSingleSale(saleId);
      } catch (error: any) {
        logger.error(`Failed to process sale ${saleId}:`, error.message);
      }
    }

    this.isProcessingQueue = false;
    logger.info('✅ Queue processing complete');
  }

  /**
   * Process a single sale notification
   */
  private async processSingleSale(saleId: number): Promise<void> {
    try {
      // Get the sale from database
      const sale = await this.databaseService.getSaleById(saleId);
      
      if (!sale) {
        logger.warn(`Sale ${saleId} not found in database`);
        return;
      }

      if (sale.posted) {
        logger.info(`Sale ${saleId} already posted, skipping`);
        return;
      }

      logger.info(`🚀 INSTANT PROCESSING: ${sale.nftName || sale.tokenId} (${sale.priceEth} ETH) - ID: ${saleId}`);

      // Get auto-post settings
      const settings = await this.autoTweetService.getSettings();
      
      if (!settings.enabled || !settings.sales.enabled) {
        logger.info(`Auto-posting disabled, skipping sale ${saleId}`);
        return;
      }

      // Process through existing AutoTweetService
      const results = await this.autoTweetService.processNewSales([sale], settings);
      
      const result = results[0];
      if (result?.success) {
        logger.info(`✅ Successfully posted tweet for sale ${saleId} - Tweet ID: ${result.tweetId}`);
      } else if (result?.skipped) {
        logger.info(`⏭️ Skipped sale ${saleId}: ${result.reason}`);
      } else {
        logger.warn(`❌ Failed to post sale ${saleId}: ${result?.error || 'Unknown error'}`);
      }

    } catch (error: any) {
      logger.error(`Error processing sale ${saleId}:`, error.message);
    }
  }

  /**
   * Handle database connection errors
   */
  private handleConnectionError(error: Error): void {
    logger.error('🚨 Database listener connection error:', error.message);
    this.isListening = false;
    this.scheduleReconnect();
  }

  /**
   * Handle database connection end
   */
  private handleConnectionEnd(): void {
    logger.warn('🔌 Database listener connection ended');
    this.isListening = false;
    
    if (!this.isShuttingDown) {
      this.scheduleReconnect();
    }
  }

  /**
   * Schedule a reconnection attempt with exponential backoff
   */
  private scheduleReconnect(): void {
    if (this.isShuttingDown || this.reconnectTimer) {
      return; // Already scheduled or shutting down
    }

    this.reconnectAttempts++;
    
    if (this.reconnectAttempts > this.maxReconnectAttempts) {
      logger.error(`❌ Max reconnection attempts (${this.maxReconnectAttempts}) exceeded. Manual intervention required.`);
      return;
    }

    // Exponential backoff: 5s, 10s, 20s, 40s, etc. (max 60s)
    const delay = Math.min(5000 * Math.pow(2, this.reconnectAttempts - 1), 60000);
    
    logger.info(`🔄 Scheduling reconnection attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts} in ${delay/1000}s...`);
    
    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      await this.ensureConnection();
    }, delay);
  }

  /**
   * Perform periodic health check
   */
  private async performHealthCheck(): Promise<void> {
    if (this.isShuttingDown) return;

    if (!this.isListening) {
      logger.warn('🔄 Database listener not active during health check, reconnecting...');
      await this.ensureConnection();
      return;
    }

    try {
      // Simple ping to check connection
      await this.client?.query('SELECT 1');
      logger.debug('💓 Database listener health check passed');
    } catch (error: any) {
      logger.warn('💔 Database listener health check failed, reconnecting...', error.message);
      this.isListening = false;
      await this.ensureConnection();
    }
  }

  /**
   * Perform startup recovery - check for unposted sales from previous session
   */
  private async performStartupRecovery(): Promise<void> {
    if (this.isShuttingDown) return;

    try {
      logger.info('🔍 Checking for unposted sales from previous session...');

      // Get auto-post settings to use the same time filters
      const autoPostSettings = await this.autoTweetService.getSettings();
      
      logger.info(`🔍 Using auto-posting time window: ${autoPostSettings.sales.maxAgeHours} hours (enabled: ${autoPostSettings.enabled}/${autoPostSettings.sales.enabled})`);
      
      // Get the 5 newest unposted sales using auto-posting time window
      const unpostedSales = await this.databaseService.getUnpostedSales(5, autoPostSettings.sales.maxAgeHours);

      // Debug: Also check without time filter to see if there are ANY unposted sales
      const allUnpostedSales = await this.databaseService.getUnpostedSales(5, 999); // Very large time window
      logger.info(`🔍 Debug: Found ${allUnpostedSales.length} unposted sales total (any age), ${unpostedSales.length} within ${autoPostSettings.sales.maxAgeHours}h window`);

      if (unpostedSales.length === 0) {
        if (allUnpostedSales.length > 0) {
          logger.info(`⏰ Found ${allUnpostedSales.length} unposted sales but they're older than ${autoPostSettings.sales.maxAgeHours}h - outside auto-posting window`);
        } else {
          logger.info('✅ No unposted sales found - clean startup');
        }
        return;
      }

      // Simple notification about startup recovery
      logger.info(`🔄 Startup recovery: Found ${unpostedSales.length} unposted sales, adding to processing queue`);

      // Add unposted sales to queue for immediate processing
      for (const sale of unpostedSales) {
        if (sale.id) {
          this.addToQueue(sale.id);
          logger.info(`🔄 Recovered unposted sale: ${sale.nftName || sale.tokenId} (${sale.priceEth} ETH) - ID: ${sale.id}`);
        }
      }

      logger.info(`✅ Startup recovery complete - ${unpostedSales.length} sales added to processing queue`);

    } catch (error: any) {
      logger.error('❌ Startup recovery failed:', error.message);
      // Don't throw - we don't want to prevent service startup
    }
  }

  /**
   * Get current service status
   */
  getStatus(): {
    isListening: boolean;
    queueLength: number;
    isProcessing: boolean;
    reconnectAttempts: number;
  } {
    return {
      isListening: this.isListening,
      queueLength: this.notificationQueue.length,
      isProcessing: this.isProcessingQueue,
      reconnectAttempts: this.reconnectAttempts,
    };
  }
}
