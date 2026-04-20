import { Client } from 'pg';
import { logger } from '../utils/logger';
import { AutoTweetService } from './autoTweetService';
import { IDatabaseService } from '../types';

// Forward declaration - will be created in Phase 3.3
export interface IAIReplyService {
  generateAndPostAIReply(type: 'sale' | 'registration' | 'bid', recordId: number): Promise<void>;
}

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
  private aiReplyService: IAIReplyService | null = null;

  // Separate queues for handling sales, registrations, bids, and renewals.
  // Renewals are tx-keyed (string), not row-keyed (number) — the unit-of-work for renewals
  // is the transaction (a single tx may have 100+ name renewals → one tweet).
  private saleNotificationQueue: number[] = [];
  private registrationNotificationQueue: number[] = [];
  private bidNotificationQueue: number[] = [];
  private renewalTxQueue: string[] = [];
  private isProcessingSales = false;
  private isProcessingRegistrations = false;
  private isProcessingBids = false;
  private isProcessingRenewals = false;

  // AI Reply queues (Phase 3.2 + Phase 4.6)
  private aiReplySaleQueue: number[] = [];
  private aiReplyRegistrationQueue: number[] = [];
  private aiReplyBidQueue: number[] = [];
  private isProcessingAIReplies = false;
  private aiReplyDelayMs = 30000; // 30 seconds between AI reply posts
  private lastAIReplyTime = 0;

  constructor(
    autoTweetService: AutoTweetService,
    databaseService: IDatabaseService,
    connectionString: string,
    aiReplyService?: IAIReplyService | null
  ) {
    this.autoTweetService = autoTweetService;
    this.databaseService = databaseService;
    this.aiReplyService = aiReplyService || null;
    
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
        connectionString: process.env.POSTGRES_URL || process.env.DATABASE_URL,
        keepAlive: true,
        keepAliveInitialDelayMillis: 10000,
      });

      // Set up event handlers before connecting
      this.client.on('notification', this.handleNotification.bind(this));
      this.client.on('error', this.handleConnectionError.bind(this));
      this.client.on('end', this.handleConnectionEnd.bind(this));

      // Connect and start listening for sales, registrations, bids, and renewals.
      // Renewals use a STATEMENT-level trigger that emits one notification per distinct
      // tx_hash (not per row) — payload is a tx_hash string instead of a numeric row id.
      // Note: posted_renewal_tx LISTEN is deferred to Phase 6 when AIReplyService gains
      // 'renewal' support — wiring it now would emit error logs on every renewal tweet.
      await this.client.connect();
      await this.client.query('LISTEN new_sale');
      await this.client.query('LISTEN new_registration');
      await this.client.query('LISTEN new_bid');
      await this.client.query('LISTEN new_renewal_tx');

      // Phase 3.2 + 4.6: Listen for AI reply triggers (posted sales/registrations/bids)
      await this.client.query('LISTEN posted_sale');
      await this.client.query('LISTEN posted_registration');
      await this.client.query('LISTEN posted_bid');

      this.isListening = true;
      this.reconnectAttempts = 0; // Reset on successful connection

      logger.info('✅ Database listener connected and listening for new_sale, new_registration, new_bid, new_renewal_tx, posted_sale, posted_registration, and posted_bid notifications');

    } catch (error: any) {
      this.isListening = false;
      logger.error('❌ Failed to connect database listener:', error.message);
      this.scheduleReconnect();
    }
  }

  /**
   * Handle incoming sale, registration, bid, and AI reply notifications
   */
  private handleNotification(msg: any): void {
    try {
      if (msg.channel === 'new_sale' && msg.payload) {
        const saleId = parseInt(msg.payload);
        
        if (isNaN(saleId)) {
          logger.warn(`Invalid sale ID in notification: ${msg.payload}`);
          return;
        }

        logger.info(`🚨 NEW SALE NOTIFICATION: ID ${saleId} - adding to sales queue`);
        this.addSaleToQueue(saleId);
        
      } else if (msg.channel === 'new_registration' && msg.payload) {
        const registrationId = parseInt(msg.payload);
        
        if (isNaN(registrationId)) {
          logger.warn(`Invalid registration ID in notification: ${msg.payload}`);
          return;
        }

        logger.info(`🚨 NEW REGISTRATION NOTIFICATION: ID ${registrationId} - adding to registrations queue`);
        this.addRegistrationToQueue(registrationId);
        
      } else if (msg.channel === 'new_bid' && msg.payload) {
        const bidId = parseInt(msg.payload);
        
        if (isNaN(bidId)) {
          logger.warn(`Invalid bid ID in notification: ${msg.payload}`);
          return;
        }

        logger.info(`🚨 NEW BID NOTIFICATION: ID ${bidId} - adding to bids queue`);
        this.addBidToQueue(bidId);

      } else if (msg.channel === 'new_renewal_tx' && msg.payload) {
        // Payload is a tx_hash string (real ones are 66 chars, 0x-prefixed) instead of
        // the numeric ids carried by the other channels. The statement-level trigger
        // emits one notify per distinct tx_hash inserted.
        // We do a soft sanity check (non-empty + 0x prefix) — strict length is enforced
        // upstream by the VARCHAR(66) column. Anything weirder than this is a DB bug.
        const txHash = msg.payload;
        if (!txHash.startsWith('0x') || txHash.length < 4) {
          logger.warn(`Invalid tx_hash in new_renewal_tx notification: ${txHash}`);
          return;
        }

        logger.info(`🚨 NEW RENEWAL TX NOTIFICATION: ${txHash.slice(0, 12)}… - adding to renewals queue`);
        this.addRenewalTxToQueue(txHash);

      } else if (msg.channel === 'posted_sale' && msg.payload) {
        // Phase 3.2: AI Reply trigger for posted sale
        const saleId = parseInt(msg.payload);
        
        if (isNaN(saleId)) {
          logger.warn(`Invalid sale ID in posted_sale notification: ${msg.payload}`);
          return;
        }

        logger.info(`🤖 POSTED SALE AI REPLY TRIGGER: ID ${saleId} - adding to AI reply queue`);
        this.addSaleToAIReplyQueue(saleId);
        
      } else if (msg.channel === 'posted_registration' && msg.payload) {
        // Phase 3.2: AI Reply trigger for posted registration
        const registrationId = parseInt(msg.payload);
        
        if (isNaN(registrationId)) {
          logger.warn(`Invalid registration ID in posted_registration notification: ${msg.payload}`);
          return;
        }

        logger.info(`🤖 POSTED REGISTRATION AI REPLY TRIGGER: ID ${registrationId} - adding to AI reply queue`);
        this.addRegistrationToAIReplyQueue(registrationId);

      } else if (msg.channel === 'posted_bid' && msg.payload) {
        // Phase 4.6: AI Reply trigger for posted bid
        const bidId = parseInt(msg.payload);
        
        if (isNaN(bidId)) {
          logger.warn(`Invalid bid ID in posted_bid notification: ${msg.payload}`);
          return;
        }

        logger.info(`🤖 POSTED BID AI REPLY TRIGGER: ID ${bidId} - adding to AI reply queue`);
        this.addBidToAIReplyQueue(bidId);
      }
    } catch (error: any) {
      logger.error('Error handling notification:', error.message);
    }
  }

  /**
   * Add sale ID to processing queue
   */
  private addSaleToQueue(saleId: number): void {
    // Avoid duplicates in queue
    if (!this.saleNotificationQueue.includes(saleId)) {
      this.saleNotificationQueue.push(saleId);
      logger.info(`📦 Added sale ${saleId} to sales queue (queue length: ${this.saleNotificationQueue.length})`);
    }

    // Start processing if not already running
    if (!this.isProcessingSales) {
      this.processSalesQueue();
    }
  }

  /**
   * Add registration ID to processing queue
   */
  private addRegistrationToQueue(registrationId: number): void {
    // Avoid duplicates in queue
    if (!this.registrationNotificationQueue.includes(registrationId)) {
      this.registrationNotificationQueue.push(registrationId);
      logger.info(`📦 Added registration ${registrationId} to registrations queue (queue length: ${this.registrationNotificationQueue.length})`);
    }

    // Start processing if not already running
    if (!this.isProcessingRegistrations) {
      this.processRegistrationsQueue();
    }
  }

  /**
   * Add bid ID to processing queue
   */
  private addBidToQueue(bidId: number): void {
    // Avoid duplicates in queue
    if (!this.bidNotificationQueue.includes(bidId)) {
      this.bidNotificationQueue.push(bidId);
      logger.info(`📦 Added bid ${bidId} to bids queue (queue length: ${this.bidNotificationQueue.length})`);
    }

    // Start processing if not already running
    if (!this.isProcessingBids) {
      this.processBidsQueue();
    }
  }

  /**
   * Add renewal tx_hash to processing queue.
   * Renewals are tx-keyed (string) rather than row-keyed (number) — the statement-level
   * trigger emits one notification per distinct tx_hash, and the unit-of-work for tweets
   * is the tx (a single bulk-renewal tx may contain 100+ name renewal events).
   */
  private addRenewalTxToQueue(txHash: string): void {
    if (!this.renewalTxQueue.includes(txHash)) {
      this.renewalTxQueue.push(txHash);
      logger.info(`📦 Added renewal tx ${txHash.slice(0, 12)}… to renewals queue (queue length: ${this.renewalTxQueue.length})`);
    }

    if (!this.isProcessingRenewals) {
      this.processRenewalTxQueue();
    }
  }

  /**
   * Phase 3.2: Add sale ID to AI reply queue
   */
  private addSaleToAIReplyQueue(saleId: number): void {
    // Check if AI reply service is available
    if (!this.aiReplyService) {
      logger.debug(`AI Reply Service not initialized, skipping AI reply for sale ${saleId}`);
      return;
    }

    // Avoid duplicates in queue
    if (!this.aiReplySaleQueue.includes(saleId)) {
      this.aiReplySaleQueue.push(saleId);
      logger.info(`🤖 Added sale ${saleId} to AI reply queue (queue length: ${this.aiReplySaleQueue.length})`);
    }

    // Start processing if not already running
    if (!this.isProcessingAIReplies) {
      this.processAIReplyQueue();
    }
  }

  /**
   * Phase 3.2: Add registration ID to AI reply queue
   */
  private addRegistrationToAIReplyQueue(registrationId: number): void {
    // Check if AI reply service is available
    if (!this.aiReplyService) {
      logger.debug(`AI Reply Service not initialized, skipping AI reply for registration ${registrationId}`);
      return;
    }

    // Avoid duplicates in queue
    if (!this.aiReplyRegistrationQueue.includes(registrationId)) {
      this.aiReplyRegistrationQueue.push(registrationId);
      logger.info(`🤖 Added registration ${registrationId} to AI reply queue (queue length: ${this.aiReplyRegistrationQueue.length})`);
    }

    // Start processing if not already running
    if (!this.isProcessingAIReplies) {
      this.processAIReplyQueue();
    }
  }

  /**
   * Add bid to AI reply queue (Phase 4.6)
   */
  private addBidToAIReplyQueue(bidId: number): void {
    // Check if AI reply service is available
    if (!this.aiReplyService) {
      logger.debug(`AI Reply Service not initialized, skipping AI reply for bid ${bidId}`);
      return;
    }

    // Avoid duplicates in queue
    if (!this.aiReplyBidQueue.includes(bidId)) {
      this.aiReplyBidQueue.push(bidId);
      logger.info(`🤖 Added bid ${bidId} to AI reply queue (queue length: ${this.aiReplyBidQueue.length})`);
    }

    // Start processing if not already running
    if (!this.isProcessingAIReplies) {
      this.processAIReplyQueue();
    }
  }

  /**
   * Process the sales notification queue with proper rate limiting
   */
  private async processSalesQueue(): Promise<void> {
    if (this.isProcessingSales || this.saleNotificationQueue.length === 0) {
      return;
    }

    this.isProcessingSales = true;
    logger.info(`🔄 Starting sales queue processing (${this.saleNotificationQueue.length} sales)`);

    while (this.saleNotificationQueue.length > 0 && !this.isShuttingDown) {
      const saleId = this.saleNotificationQueue.shift()!;
      
      try {
        await this.processSingleSale(saleId);
      } catch (error: any) {
        logger.error(`Failed to process sale ${saleId}:`, error.message);
      }
    }

    this.isProcessingSales = false;
    logger.info('✅ Sales queue processing complete');
  }

  /**
   * Process the registrations notification queue with proper rate limiting
   */
  private async processRegistrationsQueue(): Promise<void> {
    if (this.isProcessingRegistrations || this.registrationNotificationQueue.length === 0) {
      return;
    }

    this.isProcessingRegistrations = true;
    logger.info(`🔄 Starting registrations queue processing (${this.registrationNotificationQueue.length} registrations)`);

    while (this.registrationNotificationQueue.length > 0 && !this.isShuttingDown) {
      const registrationId = this.registrationNotificationQueue.shift()!;
      
      try {
        await this.processSingleRegistration(registrationId);
      } catch (error: any) {
        logger.error(`Failed to process registration ${registrationId}:`, error.message);
      }
    }

    this.isProcessingRegistrations = false;
    logger.info('✅ Registrations queue processing complete');
  }

  /**
   * Process the bids notification queue with proper rate limiting
   */
  private async processBidsQueue(): Promise<void> {
    if (this.isProcessingBids || this.bidNotificationQueue.length === 0) {
      return;
    }

    this.isProcessingBids = true;
    logger.info(`🔄 Starting bids queue processing (${this.bidNotificationQueue.length} bids)`);

    while (this.bidNotificationQueue.length > 0 && !this.isShuttingDown) {
      const bidId = this.bidNotificationQueue.shift()!;
      
      try {
        await this.processSingleBid(bidId);
      } catch (error: any) {
        logger.error(`Failed to process bid ${bidId}:`, error.message);
      }
    }

    this.isProcessingBids = false;
    logger.info('✅ Bids queue processing complete');
  }

  /**
   * Process the renewal tx queue. One iteration = one tx (which may contain many rows).
   * AutoTweetService.processNewRenewals handles the per-tx aggregation, threshold check
   * on total cost, and posts a single tweet for the tx.
   */
  private async processRenewalTxQueue(): Promise<void> {
    if (this.isProcessingRenewals || this.renewalTxQueue.length === 0) {
      return;
    }

    this.isProcessingRenewals = true;
    logger.info(`🔄 Starting renewals queue processing (${this.renewalTxQueue.length} tx(es))`);

    while (this.renewalTxQueue.length > 0 && !this.isShuttingDown) {
      const txHash = this.renewalTxQueue.shift()!;

      try {
        await this.processSingleRenewalTx(txHash);
      } catch (error: any) {
        logger.error(`Failed to process renewal tx ${txHash}:`, error.message);
      }
    }

    this.isProcessingRenewals = false;
    logger.info('✅ Renewals queue processing complete');
  }

  /**
   * Phase 3.2: Process the AI reply queue with rate limiting
   * Processes both sales and registrations in FIFO order with configurable delays
   */
  private async processAIReplyQueue(): Promise<void> {
    if (this.isProcessingAIReplies) {
      return;
    }

    const totalQueueLength = this.aiReplySaleQueue.length + this.aiReplyRegistrationQueue.length + this.aiReplyBidQueue.length;
    if (totalQueueLength === 0) {
      return;
    }

    this.isProcessingAIReplies = true;
    logger.info(`🤖 Starting AI reply queue processing (${this.aiReplySaleQueue.length} sales, ${this.aiReplyRegistrationQueue.length} registrations, ${this.aiReplyBidQueue.length} bids)`);

    while ((this.aiReplySaleQueue.length > 0 || this.aiReplyRegistrationQueue.length > 0 || this.aiReplyBidQueue.length > 0) && !this.isShuttingDown) {
      // Rate limiting: Check if enough time has passed since last AI reply
      const now = Date.now();
      const timeSinceLastReply = now - this.lastAIReplyTime;
      
      if (this.lastAIReplyTime > 0 && timeSinceLastReply < this.aiReplyDelayMs) {
        const waitTime = this.aiReplyDelayMs - timeSinceLastReply;
        logger.info(`⏳ Rate limiting: Waiting ${Math.round(waitTime / 1000)}s before next AI reply...`);
        await this.sleep(waitTime);
      }

      // Process sales first, then registrations, then bids (FIFO within each type)
      if (this.aiReplySaleQueue.length > 0) {
        const saleId = this.aiReplySaleQueue.shift()!;
        
        try {
          await this.processSingleAIReply('sale', saleId);
          this.lastAIReplyTime = Date.now();
        } catch (error: any) {
          logger.error(`Failed to process AI reply for sale ${saleId}:`, error.message);
          // Don't update lastAIReplyTime on error - we didn't actually post
        }
      } else if (this.aiReplyRegistrationQueue.length > 0) {
        const registrationId = this.aiReplyRegistrationQueue.shift()!;
        
        try {
          await this.processSingleAIReply('registration', registrationId);
          this.lastAIReplyTime = Date.now();
        } catch (error: any) {
          logger.error(`Failed to process AI reply for registration ${registrationId}:`, error.message);
          // Don't update lastAIReplyTime on error - we didn't actually post
        }
      } else if (this.aiReplyBidQueue.length > 0) {
        const bidId = this.aiReplyBidQueue.shift()!;
        
        try {
          await this.processSingleAIReply('bid', bidId);
          this.lastAIReplyTime = Date.now();
        } catch (error: any) {
          logger.error(`Failed to process AI reply for bid ${bidId}:`, error.message);
          // Don't update lastAIReplyTime on error - we didn't actually post
        }
      }
    }

    this.isProcessingAIReplies = false;
    logger.info('✅ AI reply queue processing complete');
  }

  /**
   * Phase 3.2: Process a single AI reply (sale or registration)
   */
  private async processSingleAIReply(type: 'sale' | 'registration' | 'bid', recordId: number): Promise<void> {
    if (!this.aiReplyService) {
      logger.warn(`AI Reply Service not available for ${type} ${recordId}`);
      return;
    }

    try {
      logger.info(`🤖 Generating AI reply for ${type} ${recordId}...`);
      await this.aiReplyService.generateAndPostAIReply(type, recordId);
      logger.info(`✅ Successfully generated and posted AI reply for ${type} ${recordId}`);
    } catch (error: any) {
      logger.error(`❌ Failed to generate AI reply for ${type} ${recordId}:`, error.message);
      // Could implement retry logic here with exponential backoff
      throw error;
    }
  }

  /**
   * Helper: Sleep for specified milliseconds
   */
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
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

      logger.info(`🚀 INSTANT PROCESSING: ${sale.nftName || sale.tokenId} (${sale.priceAmount} ${sale.currencySymbol || 'ETH'}) - ID: ${saleId}`);

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
   * Process a single registration notification
   */
  private async processSingleRegistration(registrationId: number): Promise<void> {
    try {
      // Get the registration from database
      const registration = await this.databaseService.getRegistrationById(registrationId);
      
      if (!registration) {
        logger.warn(`Registration ${registrationId} not found in database`);
        return;
      }

      if (registration.posted) {
        logger.info(`Registration ${registrationId} already posted, skipping`);
        return;
      }

      logger.info(`🚀 INSTANT PROCESSING: ${registration.fullName} (${registration.costEth || registration.costWei} ETH) - ID: ${registrationId}`);

      // Get auto-post settings
      const settings = await this.autoTweetService.getSettings();
      
      if (!settings.enabled || !settings.registrations.enabled) {
        logger.info(`Auto-posting disabled, skipping registration ${registrationId}`);
        return;
      }

      // Process through existing AutoTweetService registration method
      const results = await this.autoTweetService.processNewRegistrations([registration], settings);
      
      const result = results[0];
      if (result?.success) {
        logger.info(`✅ Successfully posted registration tweet for ${registrationId} - Tweet ID: ${result.tweetId}`);
      } else if (result?.skipped) {
        logger.info(`⏭️ Skipped registration ${registrationId}: ${result.reason}`);
      } else {
        logger.warn(`❌ Failed to post registration ${registrationId}: ${result?.error || 'Unknown error'}`);
      }

    } catch (error: any) {
      logger.error(`Error processing registration ${registrationId}:`, error.message);
    }
  }

  /**
   * Process a single bid notification
   */
  private async processSingleBid(bidId: number): Promise<void> {
    try {
      // Get the bid from database
      const bid = await this.databaseService.getBidById(bidId);
      
      if (!bid) {
        logger.warn(`Bid ${bidId} not found in database`);
        return;
      }

      if (bid.status !== 'unposted') {
        logger.info(`Bid ${bidId} already processed (status: ${bid.status}), skipping`);
        return;
      }

      logger.info(`🚀 INSTANT PROCESSING: ${bid.priceDecimal} ETH bid for ${bid.ensName} - ID: ${bidId}`);

      // Get auto-post settings
      const settings = await this.autoTweetService.getSettings();
      
      if (!settings.enabled || !settings.bids.enabled) {
        logger.info(`Auto-posting disabled, skipping bid ${bidId}`);
        return;
      }

      // Process through existing AutoTweetService bid method
      const results = await this.autoTweetService.processNewBids([bid], settings);
      
      const result = results[0];
      if (result?.success) {
        logger.info(`✅ Successfully posted bid tweet for ${bidId} - Tweet ID: ${result.tweetId}`);
      } else if (result?.skipped) {
        logger.info(`⏭️ Skipped bid ${bidId}: ${result.reason}`);
      } else {
        logger.warn(`❌ Failed to post bid ${bidId}: ${result?.error || 'Unknown error'}`);
      }

    } catch (error: any) {
      logger.error(`Error processing bid ${bidId}:`, error.message);
    }
  }

  /**
   * Process a single renewal tx notification. Fetches all rows for the tx, then
   * delegates to AutoTweetService.processNewRenewals which applies the per-tx
   * threshold (sum of all cost_eth in the tx) and posts a single tweet.
   *
   * If any row in the tx is already posted, the AutoTweetService skips it cleanly.
   */
  private async processSingleRenewalTx(txHash: string): Promise<void> {
    try {
      const renewals = await this.databaseService.getRenewalsByTxHash(txHash);

      if (renewals.length === 0) {
        logger.warn(`Renewal tx ${txHash.slice(0, 12)}… has no rows in database`);
        return;
      }

      // Defensive: if any row is already marked posted (e.g., re-delivery race),
      // assume the tx has been handled and skip — AutoTweetService also checks this.
      if (renewals.every(r => r.posted)) {
        logger.info(`Renewal tx ${txHash.slice(0, 12)}… already posted, skipping`);
        return;
      }

      const totalEth = renewals.reduce((sum, r) => sum + parseFloat(r.costEth || '0'), 0);
      const renewerShort = renewals[0].renewerAddress.slice(0, 6) + '…' + renewals[0].renewerAddress.slice(-4);
      logger.info(
        `🚀 INSTANT PROCESSING: ${renewals.length} name(s) renewed by ${renewerShort} for ${totalEth.toFixed(4)} ETH ` +
        `(tx: ${txHash.slice(0, 12)}…)`
      );

      const settings = await this.autoTweetService.getSettings();

      if (!settings.enabled || !settings.renewals.enabled) {
        logger.info(`Auto-posting disabled, skipping renewal tx ${txHash.slice(0, 12)}…`);
        return;
      }

      // Pass the tx as a Map<txHash, rows>; AutoTweetService.processNewRenewals iterates
      // the map and applies all per-tx gating (threshold on total cost, age, rate-limit).
      const results = await this.autoTweetService.processNewRenewals(
        new Map([[txHash, renewals]]),
        settings
      );

      const result = results[0];
      if (result?.success) {
        logger.info(`✅ Successfully posted renewal tweet for tx ${txHash.slice(0, 12)}… - Tweet ID: ${result.tweetId}`);
      } else if (result?.skipped) {
        logger.info(`⏭️ Skipped renewal tx ${txHash.slice(0, 12)}…: ${result.reason}`);
      } else {
        logger.warn(`❌ Failed to post renewal tx ${txHash.slice(0, 12)}…: ${result?.error || 'Unknown error'}`);
      }

    } catch (error: any) {
      logger.error(`Error processing renewal tx ${txHash}:`, error.message);
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
      // Health check passed (logging disabled to reduce noise)
    } catch (error: any) {
      logger.warn('💔 Database listener health check failed, reconnecting...', error.message);
      this.isListening = false;
      await this.ensureConnection();
    }
  }

  /**
   * Perform startup recovery - check for unposted sales and registrations from previous session
   */
  private async performStartupRecovery(): Promise<void> {
    if (this.isShuttingDown) return;

    try {
      logger.info('🔍 Checking for unposted sales and registrations from previous session...');

      // Get auto-post settings to use the same time filters
      const autoPostSettings = await this.autoTweetService.getSettings();
      
      logger.info(`🔍 Using auto-posting time window: Sales ${autoPostSettings.sales.maxAgeHours}h, Registrations ${autoPostSettings.registrations.maxAgeHours}h, Bids ${autoPostSettings.bids.maxAgeHours}h, Renewals ${autoPostSettings.renewals.maxAgeHours}h (Global enabled: ${autoPostSettings.enabled})`);
      
      // === SALES RECOVERY ===
      const unpostedSales = await this.databaseService.getUnpostedSales(5, autoPostSettings.sales.maxAgeHours);
      const allUnpostedSales = await this.databaseService.getUnpostedSales(5, 999); // Debug check
      
      logger.info(`🔍 Sales recovery: Found ${allUnpostedSales.length} unposted sales total (any age), ${unpostedSales.length} within ${autoPostSettings.sales.maxAgeHours}h window`);

      if (unpostedSales.length > 0) {
        logger.info(`🔄 Sales startup recovery: Found ${unpostedSales.length} unposted sales, adding to processing queue`);
        
        for (const sale of unpostedSales) {
          if (sale.id) {
            this.addSaleToQueue(sale.id);
            logger.info(`🔄 Recovered unposted sale: ${sale.nftName || sale.tokenId} (${sale.priceAmount} ${sale.currencySymbol || 'ETH'}) - ID: ${sale.id}`);
          }
        }
      } else if (allUnpostedSales.length > 0) {
        logger.info(`⏰ Found ${allUnpostedSales.length} unposted sales but they're older than ${autoPostSettings.sales.maxAgeHours}h - outside auto-posting window`);
      }

      // === REGISTRATIONS RECOVERY ===
      const unpostedRegistrations = await this.databaseService.getUnpostedRegistrations(5, autoPostSettings.registrations.maxAgeHours);
      const allUnpostedRegistrations = await this.databaseService.getUnpostedRegistrations(5, 999); // Debug check
      
      logger.info(`🔍 Registrations recovery: Found ${allUnpostedRegistrations.length} unposted registrations total (any age), ${unpostedRegistrations.length} within ${autoPostSettings.registrations.maxAgeHours}h window`);

      if (unpostedRegistrations.length > 0) {
        logger.info(`🔄 Registrations startup recovery: Found ${unpostedRegistrations.length} unposted registrations, adding to processing queue`);
        
        for (const registration of unpostedRegistrations) {
          if (registration.id) {
            this.addRegistrationToQueue(registration.id);
            logger.info(`🔄 Recovered unposted registration: ${registration.fullName} (${registration.costEth || registration.costWei} ETH) - ID: ${registration.id}`);
          }
        }
      } else if (allUnpostedRegistrations.length > 0) {
        logger.info(`⏰ Found ${allUnpostedRegistrations.length} unposted registrations but they're older than ${autoPostSettings.registrations.maxAgeHours}h - outside auto-posting window`);
      }

      // === BIDS RECOVERY ===
      const unpostedBids = await this.databaseService.getUnpostedBids(5, autoPostSettings.bids.maxAgeHours);
      const allUnpostedBids = await this.databaseService.getUnpostedBids(5, 999); // Debug check
      
      logger.info(`🔍 Bids recovery: Found ${allUnpostedBids.length} unposted bids total (any age), ${unpostedBids.length} within ${autoPostSettings.bids.maxAgeHours}h window`);

      if (unpostedBids.length > 0) {
        logger.info(`🔄 Bids startup recovery: Found ${unpostedBids.length} unposted bids, adding to processing queue`);
        
        for (const bid of unpostedBids) {
          if (bid.id) {
            this.addBidToQueue(bid.id);
            logger.info(`🔄 Recovered unposted bid: ${bid.priceDecimal} ETH for ${bid.ensName} - ID: ${bid.id}`);
          }
        }
      } else if (allUnpostedBids.length > 0) {
        logger.info(`⏰ Found ${allUnpostedBids.length} unposted bids but they're older than ${autoPostSettings.bids.maxAgeHours}h - outside auto-posting window`);
      }

      // === RENEWALS RECOVERY ===
      // Renewals are queued by tx_hash, not row id — one queue entry per renewal tx.
      const unpostedRenewalTxs = await this.databaseService.getUnpostedRenewalTxHashes(5, autoPostSettings.renewals.maxAgeHours);
      const allUnpostedRenewalTxs = await this.databaseService.getUnpostedRenewalTxHashes(5, 999); // Debug check

      logger.info(`🔍 Renewals recovery: Found ${allUnpostedRenewalTxs.length} unposted renewal tx(es) total (any age), ${unpostedRenewalTxs.length} within ${autoPostSettings.renewals.maxAgeHours}h window`);

      if (unpostedRenewalTxs.length > 0) {
        logger.info(`🔄 Renewals startup recovery: Found ${unpostedRenewalTxs.length} unposted renewal tx(es), adding to processing queue`);

        for (const txHash of unpostedRenewalTxs) {
          this.addRenewalTxToQueue(txHash);
          logger.info(`🔄 Recovered unposted renewal tx: ${txHash.slice(0, 12)}…`);
        }
      } else if (allUnpostedRenewalTxs.length > 0) {
        logger.info(`⏰ Found ${allUnpostedRenewalTxs.length} unposted renewal tx(es) but they're older than ${autoPostSettings.renewals.maxAgeHours}h - outside auto-posting window`);
      }

      // === SUMMARY ===
      const totalRecovered = unpostedSales.length + unpostedRegistrations.length + unpostedBids.length + unpostedRenewalTxs.length;
      if (totalRecovered === 0) {
        logger.info('✅ No unposted items found within time windows - clean startup');
      } else {
        logger.info(`✅ Startup recovery complete - ${unpostedSales.length} sales, ${unpostedRegistrations.length} registrations, ${unpostedBids.length} bids, and ${unpostedRenewalTxs.length} renewal tx(es) added to processing queues`);
      }

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
    salesQueueLength: number;
    registrationsQueueLength: number;
    bidsQueueLength: number;
    renewalsQueueLength: number;
    isProcessingSales: boolean;
    isProcessingRegistrations: boolean;
    isProcessingBids: boolean;
    isProcessingRenewals: boolean;
    reconnectAttempts: number;
    aiReplySalesQueueLength: number;
    aiReplyRegistrationsQueueLength: number;
    aiReplyBidsQueueLength: number;
    isProcessingAIReplies: boolean;
    aiReplyServiceAvailable: boolean;
  } {
    return {
      isListening: this.isListening,
      salesQueueLength: this.saleNotificationQueue.length,
      registrationsQueueLength: this.registrationNotificationQueue.length,
      bidsQueueLength: this.bidNotificationQueue.length,
      renewalsQueueLength: this.renewalTxQueue.length,
      isProcessingSales: this.isProcessingSales,
      isProcessingRegistrations: this.isProcessingRegistrations,
      isProcessingBids: this.isProcessingBids,
      isProcessingRenewals: this.isProcessingRenewals,
      reconnectAttempts: this.reconnectAttempts,
      aiReplySalesQueueLength: this.aiReplySaleQueue.length,
      aiReplyRegistrationsQueueLength: this.aiReplyRegistrationQueue.length,
      aiReplyBidsQueueLength: this.aiReplyBidQueue.length,
      isProcessingAIReplies: this.isProcessingAIReplies,
      aiReplyServiceAvailable: this.aiReplyService !== null,
    };
  }
}
