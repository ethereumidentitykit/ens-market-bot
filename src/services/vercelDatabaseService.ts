import { config } from '../utils/config';
import { logger } from '../utils/logger';
import { ProcessedSale, IDatabaseService } from '../types';

/**
 * Vercel-compatible database service using Vercel KV (Redis) or PostgreSQL
 * For now, we'll use a simple in-memory store with persistence to Vercel KV
 */
export class VercelDatabaseService implements IDatabaseService {
  private sales: ProcessedSale[] = [];
  private systemState: Map<string, string> = new Map();

  /**
   * Initialize the database connection
   * In production, this would connect to Vercel KV or PostgreSQL
   */
  async initialize(): Promise<void> {
    try {
      logger.info('Vercel database service initialized (in-memory for now)');
      
      // TODO: In production, connect to Vercel KV or PostgreSQL
      // For now, we'll use in-memory storage which will reset on each deployment
      // This is temporary until we set up a proper database
      
    } catch (error: any) {
      logger.error('Failed to initialize Vercel database:', error.message);
      throw error;
    }
  }

  /**
   * Insert a new processed sale record
   */
  async insertSale(sale: Omit<ProcessedSale, 'id'>): Promise<number> {
    try {
      const newSale: ProcessedSale = {
        ...sale,
        id: this.sales.length + 1
      };
      
      this.sales.push(newSale);
      logger.debug(`Inserted sale record with ID: ${newSale.id}`);
      
      return newSale.id!;
    } catch (error: any) {
      logger.error('Failed to insert sale:', error.message);
      throw error;
    }
  }

  /**
   * Check if a sale has already been processed
   */
  async isSaleProcessed(transactionHash: string): Promise<boolean> {
    try {
      const exists = this.sales.some(sale => sale.transactionHash === transactionHash);
      return exists;
    } catch (error: any) {
      logger.error('Failed to check if sale is processed:', error.message);
      throw error;
    }
  }

  /**
   * Get recent sales for display/monitoring
   */
  async getRecentSales(limit: number = 50): Promise<ProcessedSale[]> {
    try {
      return this.sales
        .sort((a, b) => b.blockNumber - a.blockNumber)
        .slice(0, limit);
    } catch (error: any) {
      logger.error('Failed to get recent sales:', error.message);
      throw error;
    }
  }

  /**
   * Get sales that haven't been posted to Twitter yet
   */
  async getUnpostedSales(limit: number = 10): Promise<ProcessedSale[]> {
    try {
      return this.sales
        .filter(sale => !sale.posted)
        .sort((a, b) => a.blockNumber - b.blockNumber)
        .slice(0, limit);
    } catch (error: any) {
      logger.error('Failed to get unposted sales:', error.message);
      throw error;
    }
  }

  /**
   * Mark a sale as posted with tweet ID
   */
  async markAsPosted(id: number, tweetId: string): Promise<void> {
    try {
      const sale = this.sales.find(s => s.id === id);
      if (sale) {
        sale.posted = true;
        sale.tweetId = tweetId;
        logger.debug(`Marked sale ${id} as posted with tweet ID: ${tweetId}`);
      }
    } catch (error: any) {
      logger.error('Failed to mark sale as posted:', error.message);
      throw error;
    }
  }

  /**
   * Get/set system state values
   */
  async getSystemState(key: string): Promise<string | null> {
    try {
      return this.systemState.get(key) || null;
    } catch (error: any) {
      logger.error(`Failed to get system state for key ${key}:`, error.message);
      throw error;
    }
  }

  async setSystemState(key: string, value: string): Promise<void> {
    try {
      this.systemState.set(key, value);
      logger.debug(`Set system state ${key} = ${value}`);
    } catch (error: any) {
      logger.error(`Failed to set system state for key ${key}:`, error.message);
      throw error;
    }
  }

  /**
   * Get database statistics
   */
  async getStats(): Promise<{
    totalSales: number;
    postedSales: number;
    unpostedSales: number;
    lastProcessedBlock: string | null;
  }> {
    try {
      const totalSales = this.sales.length;
      const postedSales = this.sales.filter(s => s.posted).length;
      const unpostedSales = this.sales.filter(s => !s.posted).length;
      const lastBlock = await this.getSystemState('last_processed_block');

      return {
        totalSales,
        postedSales,
        unpostedSales,
        lastProcessedBlock: lastBlock
      };
    } catch (error: any) {
      logger.error('Failed to get database stats:', error.message);
      throw error;
    }
  }

  /**
   * Close database connection (no-op for in-memory)
   */
  async close(): Promise<void> {
    logger.info('Vercel database service closed');
  }
}
