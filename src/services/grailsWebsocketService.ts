/**
 * GrailsWebsocketService
 * 
 * Connects to the Grails activity websocket to receive real-time bid events.
 * Phase 1: Connection management, subscription, and event logging.
 * Phase 2: Transform Grails events to internal TransformedBid format.
 */

import WebSocket from 'ws';
import { config } from '../utils/config';
import { logger } from '../utils/logger';
import { TransformedBid } from './bidsProcessingService';

// ENS contract addresses
const ENS_REGISTRY = '0x57f1887a8bf19b14fc0df6fd9b2acc9af147ea85';
// const ENS_NAME_WRAPPER = '0xD4416b13d2b3a9aBae7AcD5D6C2BbDBE25686401';

// Currency address to symbol mapping
const CURRENCY_MAP: Record<string, string> = {
  '0x0000000000000000000000000000000000000000': 'ETH',
  '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2': 'WETH',
  '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48': 'USDC',
  '0xdac17f958d2ee523a2206206994597c13d831ec7': 'USDT',
};

// Platform to source domain/name mapping
const PLATFORM_MAP: Record<string, { domain: string; name: string }> = {
  'opensea': { domain: 'opensea.io', name: 'OpenSea' },
  'blur': { domain: 'blur.io', name: 'Blur' },
  'x2y2': { domain: 'x2y2.io', name: 'X2Y2' },
  'looksrare': { domain: 'looksrare.org', name: 'LooksRare' },
  'grails': { domain: 'grails.app', name: 'Grails' },
};

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

      // Transform the event to internal format
      const transformedBid = this.transformEvent(event);
      
      if (!transformedBid) {
        // Already logged in transformEvent
        return;
      }

      // Log the transformed bid
      logger.info(`🔌 Transformed Grails bid:`, {
        ensName: transformedBid.ensName,
        bidId: transformedBid.bidId.substring(0, 20) + '...',
        bidder: transformedBid.makerAddress.substring(0, 10) + '...',
        price: `${transformedBid.priceDecimal} ${transformedBid.currencySymbol}`,
        source: transformedBid.sourceName,
        createdAt: transformedBid.createdAtApi
      });

      // TODO Phase 3: Process this event via BidsProcessingService
      // await this.bidsProcessingService.processWebsocketBid(transformedBid);
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

  /**
   * Transform Grails offer_made event to internal TransformedBid format
   * 
   * @param event - The Grails offer_made event
   * @returns TransformedBid or null if event is invalid (missing order_hash)
   */
  transformEvent(event: GrailsOfferEvent): TransformedBid | null {
    // Require order_hash for deduplication
    const orderHash = event.metadata?.order_hash;
    if (!orderHash) {
      logger.warn('🔌 Skipping Grails event without order_hash (cannot deduplicate)', {
        name: event.name,
        grailsId: event.id
      });
      return null;
    }

    // Resolve currency symbol from address
    const currencySymbol = this.resolveCurrencySymbol(event.currency_address);

    // Calculate price in decimal (wei to ETH)
    const priceDecimal = this.weiToEth(event.price_wei);

    // Map platform to source domain/name
    const source = this.resolveSource(event.platform);

    // Validity period defaults (Grails doesn't provide these)
    // Default: valid from now, expires in 7 days
    const now = Math.floor(Date.now() / 1000);
    const validFrom = now;
    const validUntil = now + (7 * 24 * 60 * 60); // 7 days

    const transformed: TransformedBid = {
      bidId: orderHash,
      contractAddress: ENS_REGISTRY, // Default to ENS Registry (most common)
      tokenId: event.token_id || null,
      makerAddress: event.actor_address,
      takerAddress: event.counterparty_address || '', // Owner address (bonus from Grails!)
      status: 'unposted',
      priceRaw: event.price_wei,
      priceDecimal: priceDecimal,
      priceUsd: '', // Will be enriched by BidsProcessingService
      currencyContract: event.currency_address,
      currencySymbol: currencySymbol,
      sourceDomain: source.domain,
      sourceName: source.name,
      marketplaceFee: 0, // Not provided by Grails
      createdAtApi: event.created_at,
      updatedAtApi: event.created_at, // Same as created (no update info)
      validFrom: validFrom,
      validUntil: validUntil,
      processedAt: new Date().toISOString(),
      ensName: event.name, // ✅ Already resolved by Grails!
      nftImage: undefined, // Will be enriched if needed
    };

    return transformed;
  }

  /**
   * Resolve currency symbol from contract address
   */
  private resolveCurrencySymbol(currencyAddress: string): string {
    if (!currencyAddress) return 'ETH';
    const normalized = currencyAddress.toLowerCase();
    return CURRENCY_MAP[normalized] || 'UNKNOWN';
  }

  /**
   * Convert wei to ETH decimal string
   */
  private weiToEth(weiString: string): string {
    try {
      const wei = BigInt(weiString);
      const eth = Number(wei) / 1e18;
      return eth.toString();
    } catch {
      return '0';
    }
  }

  /**
   * Resolve source domain and name from platform string
   */
  private resolveSource(platform: string): { domain: string; name: string } {
    const normalized = platform?.toLowerCase() || '';
    return PLATFORM_MAP[normalized] || { domain: 'unknown', name: 'Unknown' };
  }
}

// Singleton instance
export const grailsWebsocketService = new GrailsWebsocketService();

