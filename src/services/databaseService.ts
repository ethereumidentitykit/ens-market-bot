import sqlite3 from 'sqlite3';
import { Database, open } from 'sqlite';
import path from 'path';
import fs from 'fs';
import { config } from '../utils/config';
import { logger } from '../utils/logger';
import { ProcessedSale, IDatabaseService } from '../types';

export class DatabaseService implements IDatabaseService {
  private db: Database<sqlite3.Database, sqlite3.Statement> | null = null;

  /**
   * Initialize the database connection and create tables
   */
  async initialize(): Promise<void> {
    try {
      // Ensure data directory exists
      const dbDir = path.dirname(config.database.path);
      if (!fs.existsSync(dbDir)) {
        fs.mkdirSync(dbDir, { recursive: true });
        logger.info(`Created database directory: ${dbDir}`);
      }

      // Open database connection
      this.db = await open({
        filename: config.database.path,
        driver: sqlite3.Database,
      });

      logger.info(`Database connected: ${config.database.path}`);

      // Create tables
      await this.createTables();
      
      logger.info('Database initialization completed');
    } catch (error: any) {
      logger.error('Failed to initialize database:', error.message);
      throw error;
    }
  }

  /**
   * Create database tables if they don't exist
   */
  private async createTables(): Promise<void> {
    if (!this.db) throw new Error('Database not initialized');

    // Create processed_sales table
    await this.db.exec(`
      CREATE TABLE IF NOT EXISTS processed_sales (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        transaction_hash TEXT NOT NULL UNIQUE,
        contract_address TEXT NOT NULL,
        token_id TEXT NOT NULL,
        marketplace TEXT NOT NULL,
        buyer_address TEXT NOT NULL,
        seller_address TEXT NOT NULL,
        price_eth TEXT NOT NULL,
        price_usd TEXT,
        block_number INTEGER NOT NULL,
        block_timestamp TEXT NOT NULL,
        processed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        tweet_id TEXT,
        posted INTEGER DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Create index for faster lookups
    await this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_transaction_hash ON processed_sales(transaction_hash);
      CREATE INDEX IF NOT EXISTS idx_contract_address ON processed_sales(contract_address);
      CREATE INDEX IF NOT EXISTS idx_block_number ON processed_sales(block_number);
      CREATE INDEX IF NOT EXISTS idx_posted ON processed_sales(posted);
    `);

    // Create system_state table for tracking last processed blocks
    await this.db.exec(`
      CREATE TABLE IF NOT EXISTS system_state (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        key TEXT NOT NULL UNIQUE,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);

    logger.info('Database tables created successfully');
  }

  /**
   * Insert a new processed sale record
   */
  async insertSale(sale: Omit<ProcessedSale, 'id'>): Promise<number> {
    if (!this.db) throw new Error('Database not initialized');

    try {
      const result = await this.db.run(`
        INSERT INTO processed_sales (
          transaction_hash, contract_address, token_id, marketplace,
          buyer_address, seller_address, price_eth, price_usd,
          block_number, block_timestamp, processed_at, posted
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [
        sale.transactionHash,
        sale.contractAddress,
        sale.tokenId,
        sale.marketplace,
        sale.buyerAddress,
        sale.sellerAddress,
        sale.priceEth,
        sale.priceUsd || null,
        sale.blockNumber,
        sale.blockTimestamp,
        sale.processedAt,
        sale.posted ? 1 : 0
      ]);

      logger.debug(`Inserted sale record with ID: ${result.lastID}`);
      return result.lastID!;
    } catch (error: any) {
      logger.error('Failed to insert sale:', error.message);
      throw error;
    }
  }

  /**
   * Check if a sale has already been processed
   */
  async isSaleProcessed(transactionHash: string): Promise<boolean> {
    if (!this.db) throw new Error('Database not initialized');

    try {
      const result = await this.db.get(
        'SELECT id FROM processed_sales WHERE transaction_hash = ?',
        [transactionHash]
      );

      return !!result;
    } catch (error: any) {
      logger.error('Failed to check if sale is processed:', error.message);
      throw error;
    }
  }

  /**
   * Get recent sales for display/monitoring
   */
  async getRecentSales(limit: number = 50): Promise<ProcessedSale[]> {
    if (!this.db) throw new Error('Database not initialized');

    try {
      const rows = await this.db.all(`
        SELECT 
          id, transaction_hash as transactionHash, contract_address as contractAddress,
          token_id as tokenId, marketplace, buyer_address as buyerAddress,
          seller_address as sellerAddress, price_eth as priceEth, price_usd as priceUsd,
          block_number as blockNumber, block_timestamp as blockTimestamp,
          processed_at as processedAt, tweet_id as tweetId, posted
        FROM processed_sales 
        ORDER BY block_number DESC 
        LIMIT ?
      `, [limit]);

      return rows.map(row => ({
        ...row,
        posted: !!row.posted
      }));
    } catch (error: any) {
      logger.error('Failed to get recent sales:', error.message);
      throw error;
    }
  }

  /**
   * Get sales that haven't been posted to Twitter yet
   */
  async getUnpostedSales(limit: number = 10): Promise<ProcessedSale[]> {
    if (!this.db) throw new Error('Database not initialized');

    try {
      const rows = await this.db.all(`
        SELECT 
          id, transaction_hash as transactionHash, contract_address as contractAddress,
          token_id as tokenId, marketplace, buyer_address as buyerAddress,
          seller_address as sellerAddress, price_eth as priceEth, price_usd as priceUsd,
          block_number as blockNumber, block_timestamp as blockTimestamp,
          processed_at as processedAt, tweet_id as tweetId, posted
        FROM processed_sales 
        WHERE posted = 0 
        ORDER BY block_number ASC 
        LIMIT ?
      `, [limit]);

      return rows.map(row => ({
        ...row,
        posted: !!row.posted
      }));
    } catch (error: any) {
      logger.error('Failed to get unposted sales:', error.message);
      throw error;
    }
  }

  /**
   * Mark a sale as posted with tweet ID
   */
  async markAsPosted(id: number, tweetId: string): Promise<void> {
    if (!this.db) throw new Error('Database not initialized');

    try {
      await this.db.run(`
        UPDATE processed_sales 
        SET posted = 1, tweet_id = ?, updated_at = CURRENT_TIMESTAMP 
        WHERE id = ?
      `, [tweetId, id]);

      logger.debug(`Marked sale ${id} as posted with tweet ID: ${tweetId}`);
    } catch (error: any) {
      logger.error('Failed to mark sale as posted:', error.message);
      throw error;
    }
  }

  /**
   * Get/set system state values (like last processed block)
   */
  async getSystemState(key: string): Promise<string | null> {
    if (!this.db) throw new Error('Database not initialized');

    try {
      const result = await this.db.get(
        'SELECT value FROM system_state WHERE key = ?',
        [key]
      );

      return result?.value || null;
    } catch (error: any) {
      logger.error(`Failed to get system state for key ${key}:`, error.message);
      throw error;
    }
  }

  async setSystemState(key: string, value: string): Promise<void> {
    if (!this.db) throw new Error('Database not initialized');

    try {
      await this.db.run(`
        INSERT OR REPLACE INTO system_state (key, value, updated_at)
        VALUES (?, ?, CURRENT_TIMESTAMP)
      `, [key, value]);

      logger.debug(`Set system state ${key} = ${value}`);
    } catch (error: any) {
      logger.error(`Failed to set system state for key ${key}:`, error.message);
      throw error;
    }
  }

  /**
   * Get database statistics for monitoring
   */
  async getStats(): Promise<{
    totalSales: number;
    postedSales: number;
    unpostedSales: number;
    lastProcessedBlock: string | null;
  }> {
    if (!this.db) throw new Error('Database not initialized');

    try {
      const totalResult = await this.db.get('SELECT COUNT(*) as count FROM processed_sales');
      const postedResult = await this.db.get('SELECT COUNT(*) as count FROM processed_sales WHERE posted = 1');
      const unpostedResult = await this.db.get('SELECT COUNT(*) as count FROM processed_sales WHERE posted = 0');
      const lastBlock = await this.getSystemState('last_processed_block');

      return {
        totalSales: totalResult.count,
        postedSales: postedResult.count,
        unpostedSales: unpostedResult.count,
        lastProcessedBlock: lastBlock
      };
    } catch (error: any) {
      logger.error('Failed to get database stats:', error.message);
      throw error;
    }
  }

  /**
   * Close database connection
   */
  async close(): Promise<void> {
    if (this.db) {
      await this.db.close();
      this.db = null;
      logger.info('Database connection closed');
    }
  }
}
