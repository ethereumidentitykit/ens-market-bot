/**
 * GrailsWebsocketService
 * 
 * Connects to the Grails activity websocket to receive real-time bid events.
 * Phase 1: Connection management, subscription, and event logging.
 */

import WebSocket from 'ws';
import { config } from '../utils/config';
import { logger } from '../utils/logger';

// Grails websocket message types
interface GrailsSubscribeMessage {
  type: 'subscribe_all';
}

interface GrailsFilterMessage {
  type: 'set_event_filter';
  filter_type: 'include' | 'exclude';
  event_types: string[];
}

interface GrailsUnsubscribeMessage {
  type: 'unsubscribe_all';
}

// Grails offer_made event structure
export interface GrailsOfferEvent {
  id: number;                       // Grails internal DB ID
  ens_name_id: number;              // Grails ENS name reference
  name: string;                     // ENS name (already resolved!)
  event_type: 'offer_made';
  actor_address: string;            // Bidder address
  counterparty_address: string;     // Owner address
  platform: string;                 // Source marketplace (e.g., "opensea")
  chain_id: number;
  price_wei: string;                // Price in wei
  currency_address: string;         // Token contract (0x0...0 = ETH)
  transaction_hash: string | null;
  block_number: number | null;
  metadata: {
    listing_id?: number;
    order_hash?: string;            // Same as Magic Eden order ID!
  };
  created_at: string;               // ISO timestamp
  token_id: string;                 // ENS token ID
}

interface GrailsActivityEvent {
  type: 'activity_event';
  data: GrailsOfferEvent;
}

type GrailsIncomingMessage = GrailsActivityEvent;

export class GrailsWebsocketService {
  private ws: WebSocket | null = null;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 10;
  private baseReconnectDelay = 1000; // 1 second
  private maxReconnectDelay = 60000; // 1 minute
  private isShuttingDown = false;
  private pingInterval: NodeJS.Timeout | null = null;
  private lastEventTime: Date | null = null;

  // Connection state
  private _isConnected = false;
  get isConnected(): boolean {
    return this._isConnected;
  }

  get lastEventReceived(): Date | null {
    return this.lastEventTime;
  }

  /**
   * Initialize the websocket connection
   */
  async connect(): Promise<void> {
    if (!config.grails?.websocketUrl) {
      logger.warn('🔌 Grails websocket URL not configured (GRAILS_WEBSOCKET_URL). Skipping connection.');
      return;
    }

    if (this.ws) {
      logger.debug('🔌 Websocket already exists, closing before reconnect');
      this.ws.terminate();
    }

    const url = config.grails.websocketUrl;
    logger.info(`🔌 Connecting to Grails websocket: ${url}`);

    try {
      this.ws = new WebSocket(url);
      this.setupEventHandlers();
    } catch (error) {
      logger.error('🔌 Failed to create websocket:', error);
      this.scheduleReconnect();
    }
  }

  /**
   * Setup websocket event handlers
   */
  private setupEventHandlers(): void {
    if (!this.ws) return;

    this.ws.on('open', () => {
      logger.info('🔌 Grails websocket connected');
      this._isConnected = true;
      this.reconnectAttempts = 0;
      
      // Subscribe to all events first, then filter
      this.subscribe();
      
      // Start ping interval to keep connection alive
      this.startPingInterval();
    });

    this.ws.on('message', (data: WebSocket.Data) => {
      try {
        const message = JSON.parse(data.toString()) as GrailsIncomingMessage;
        this.handleMessage(message);
      } catch (error) {
        logger.error('🔌 Failed to parse websocket message:', error);
      }
    });

    this.ws.on('close', (code: number, reason: Buffer) => {
      logger.warn(`🔌 Grails websocket closed: code=${code}, reason=${reason.toString()}`);
      this._isConnected = false;
      this.stopPingInterval();
      
      if (!this.isShuttingDown) {
        this.scheduleReconnect();
      }
    });

    this.ws.on('error', (error: Error) => {
      logger.error('🔌 Grails websocket error:', error.message);
      // Don't reconnect here - 'close' event will follow
    });

    this.ws.on('pong', () => {
      logger.debug('🔌 Received pong from Grails websocket');
    });
  }

  /**
   * Subscribe to all events then filter to offer_made only
   */
  private subscribe(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      logger.error('🔌 Cannot subscribe: websocket not open');
      return;
    }

    // Subscribe to all events
    const subscribeMsg: GrailsSubscribeMessage = { type: 'subscribe_all' };
    this.ws.send(JSON.stringify(subscribeMsg));
    logger.info('🔌 Sent subscribe_all message');

    // Filter to only offer_made events
    const filterMsg: GrailsFilterMessage = {
      type: 'set_event_filter',
      filter_type: 'include',
      event_types: ['offer_made']
    };
    this.ws.send(JSON.stringify(filterMsg));
    logger.info('🔌 Sent event filter for offer_made events');
  }

  /**
   * Handle incoming websocket messages
   */
  private handleMessage(message: GrailsIncomingMessage): void {
    if (message.type === 'activity_event') {
      this.lastEventTime = new Date();
      const event = message.data;
      
      // Only process offer_made events
      if (event.event_type !== 'offer_made') {
        logger.debug(`🔌 Ignoring non-offer event: ${event.event_type}`);
        return;
      }

      // Phase 1: Just log the event
      logger.info(`🔌 Received offer_made event:`, {
        name: event.name,
        bidder: event.actor_address.substring(0, 10) + '...',
        priceWei: event.price_wei,
        platform: event.platform,
        orderHash: event.metadata?.order_hash?.substring(0, 20) + '...',
        createdAt: event.created_at
      });

      // TODO Phase 3: Process this event via BidsProcessingService
      // await this.bidsProcessingService.processWebsocketBid(event);
    }
  }

  /**
   * Schedule reconnection with exponential backoff
   */
  private scheduleReconnect(): void {
    if (this.isShuttingDown) {
      logger.debug('🔌 Shutdown in progress, not scheduling reconnect');
      return;
    }

    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      logger.error(`🔌 Max reconnect attempts (${this.maxReconnectAttempts}) reached. Giving up.`);
      return;
    }

    // Exponential backoff with jitter
    const delay = Math.min(
      this.baseReconnectDelay * Math.pow(2, this.reconnectAttempts) + Math.random() * 1000,
      this.maxReconnectDelay
    );

    this.reconnectAttempts++;
    logger.info(`🔌 Scheduling reconnect attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts} in ${Math.round(delay)}ms`);

    setTimeout(() => {
      if (!this.isShuttingDown) {
        this.connect();
      }
    }, delay);
  }

  /**
   * Start ping interval to keep connection alive
   */
  private startPingInterval(): void {
    this.stopPingInterval();
    
    this.pingInterval = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.ping();
        logger.debug('🔌 Sent ping to Grails websocket');
      }
    }, 30000); // Ping every 30 seconds
  }

  /**
   * Stop ping interval
   */
  private stopPingInterval(): void {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
  }

  /**
   * Gracefully disconnect
   */
  async disconnect(): Promise<void> {
    logger.info('🔌 Disconnecting Grails websocket...');
    this.isShuttingDown = true;
    this.stopPingInterval();

    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      // Send unsubscribe message
      const unsubscribeMsg: GrailsUnsubscribeMessage = { type: 'unsubscribe_all' };
      this.ws.send(JSON.stringify(unsubscribeMsg));
      logger.info('🔌 Sent unsubscribe_all message');

      // Close gracefully
      this.ws.close(1000, 'Client shutting down');
    }

    this.ws = null;
    this._isConnected = false;
    logger.info('🔌 Grails websocket disconnected');
  }

  /**
   * Get connection status for health checks
   */
  getStatus(): { connected: boolean; lastEvent: Date | null; reconnectAttempts: number } {
    return {
      connected: this._isConnected,
      lastEvent: this.lastEventTime,
      reconnectAttempts: this.reconnectAttempts
    };
  }
}

// Singleton instance
export const grailsWebsocketService = new GrailsWebsocketService();

