import { Pool } from 'pg';
import { config } from '../utils/config';
import { logger } from '../utils/logger';
import { ProcessedSale, IDatabaseService, TwitterPost } from '../types';

/**
 * PostgreSQL database service for Vercel deployment
 * Uses Vercel Postgres or any PostgreSQL connection string
 */
export class VercelDatabaseService implements IDatabaseService {
  private pool: Pool | null = null;

  /**
   * Initialize the PostgreSQL connection
   */
  async initialize(): Promise<void> {
    try {
      // Create PostgreSQL connection pool
      this.pool = new Pool({
        connectionString: process.env.POSTGRES_URL || process.env.DATABASE_URL,
        ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
      });

      logger.info('PostgreSQL connection pool created');

      // Create tables if they don't exist
      await this.createTables();
      
      logger.info('PostgreSQL database initialized successfully');
    } catch (error: any) {
      logger.error('Failed to initialize PostgreSQL database:', error.message);
      throw error;
    }
  }

  /**
   * Create database tables if they don't exist
   */
  private async createTables(): Promise<void> {
    if (!this.pool) throw new Error('Database not initialized');

    try {
      // Create processed_sales table
      await this.pool.query(`
        CREATE TABLE IF NOT EXISTS processed_sales (
          id SERIAL PRIMARY KEY,
          transaction_hash VARCHAR(66) NOT NULL UNIQUE,
          contract_address VARCHAR(42) NOT NULL,
          token_id VARCHAR(255) NOT NULL,
          marketplace VARCHAR(50) NOT NULL,
          buyer_address VARCHAR(42) NOT NULL,
          seller_address VARCHAR(42) NOT NULL,
          price_eth DECIMAL(18,8) NOT NULL,
          price_usd DECIMAL(12,2),
          block_number INTEGER NOT NULL,
          block_timestamp TIMESTAMP NOT NULL,
          processed_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
          tweet_id VARCHAR(255),
          posted BOOLEAN DEFAULT FALSE,
          created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
        )
      `);

      // Create indexes for faster lookups
      await this.pool.query(`
        CREATE INDEX IF NOT EXISTS idx_transaction_hash ON processed_sales(transaction_hash);
        CREATE INDEX IF NOT EXISTS idx_contract_address ON processed_sales(contract_address);
        CREATE INDEX IF NOT EXISTS idx_block_number ON processed_sales(block_number);
        CREATE INDEX IF NOT EXISTS idx_posted ON processed_sales(posted);
      `);

      // Create system_state table
      await this.pool.query(`
        CREATE TABLE IF NOT EXISTS system_state (
          id SERIAL PRIMARY KEY,
          key VARCHAR(255) NOT NULL UNIQUE,
          value TEXT NOT NULL,
          updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
        )
      `);

      // Create twitter_posts table for rate limiting
      await this.pool.query(`
        CREATE TABLE IF NOT EXISTS twitter_posts (
          id SERIAL PRIMARY KEY,
          sale_id INTEGER REFERENCES processed_sales(id),
          tweet_id VARCHAR(255) NOT NULL,
          tweet_content TEXT NOT NULL,
          posted_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
          success BOOLEAN NOT NULL DEFAULT TRUE,
          error_message TEXT
        )
      `);

      // Create index for rate limiting queries
      await this.pool.query(`
        CREATE INDEX IF NOT EXISTS idx_twitter_posts_posted_at ON twitter_posts(posted_at);
      `);

      logger.info('PostgreSQL tables created successfully');
    } catch (error: any) {
      logger.error('Failed to create PostgreSQL tables:', error.message);
      throw error;
    }
  }

  /**
   * Insert a new processed sale record
   */
  async insertSale(sale: Omit<ProcessedSale, 'id'>): Promise<number> {
    if (!this.pool) throw new Error('Database not initialized');

    try {
      const result = await this.pool.query(`
        INSERT INTO processed_sales (
          transaction_hash, contract_address, token_id, marketplace,
          buyer_address, seller_address, price_eth, price_usd,
          block_number, block_timestamp, processed_at, posted
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
        RETURNING id
      `, [
        sale.transactionHash,
        sale.contractAddress,
        sale.tokenId,
        sale.marketplace,
        sale.buyerAddress,
        sale.sellerAddress,
        parseFloat(sale.priceEth),
        sale.priceUsd ? parseFloat(sale.priceUsd) : null,
        sale.blockNumber,
        new Date(sale.blockTimestamp),
        new Date(sale.processedAt),
        sale.posted
      ]);

      const insertedId = result.rows[0].id;
      logger.debug(`Inserted sale record with ID: ${insertedId}`);
      return insertedId;
    } catch (error: any) {
      logger.error('Failed to insert sale:', error.message);
      throw error;
    }
  }

  /**
   * Check if a sale has already been processed
   */
  async isSaleProcessed(transactionHash: string): Promise<boolean> {
    if (!this.pool) throw new Error('Database not initialized');

    try {
      const result = await this.pool.query(
        'SELECT id FROM processed_sales WHERE transaction_hash = $1',
        [transactionHash]
      );

      return result.rows.length > 0;
    } catch (error: any) {
      logger.error('Failed to check if sale is processed:', error.message);
      throw error;
    }
  }

  /**
   * Get recent sales for display/monitoring
   */
  async getRecentSales(limit: number = 50): Promise<ProcessedSale[]> {
    if (!this.pool) throw new Error('Database not initialized');

    try {
      const result = await this.pool.query(`
        SELECT 
          id, transaction_hash as "transactionHash", contract_address as "contractAddress",
          token_id as "tokenId", marketplace, buyer_address as "buyerAddress",
          seller_address as "sellerAddress", price_eth as "priceEth", price_usd as "priceUsd",
          block_number as "blockNumber", block_timestamp as "blockTimestamp",
          processed_at as "processedAt", tweet_id as "tweetId", posted
        FROM processed_sales 
        ORDER BY block_number DESC 
        LIMIT $1
      `, [limit]);

      return result.rows.map(row => ({
        ...row,
        priceEth: row.priceEth.toString(),
        priceUsd: row.priceUsd ? row.priceUsd.toString() : undefined,
        blockTimestamp: row.blockTimestamp.toISOString(),
        processedAt: row.processedAt.toISOString()
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
    if (!this.pool) throw new Error('Database not initialized');

    try {
      const result = await this.pool.query(`
        SELECT 
          id, transaction_hash as "transactionHash", contract_address as "contractAddress",
          token_id as "tokenId", marketplace, buyer_address as "buyerAddress",
          seller_address as "sellerAddress", price_eth as "priceEth", price_usd as "priceUsd",
          block_number as "blockNumber", block_timestamp as "blockTimestamp",
          processed_at as "processedAt", tweet_id as "tweetId", posted
        FROM processed_sales 
        WHERE posted = FALSE 
        ORDER BY block_number ASC 
        LIMIT $1
      `, [limit]);

      return result.rows.map(row => ({
        ...row,
        priceEth: row.priceEth.toString(),
        priceUsd: row.priceUsd ? row.priceUsd.toString() : undefined,
        blockTimestamp: row.blockTimestamp.toISOString(),
        processedAt: row.processedAt.toISOString()
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
    if (!this.pool) throw new Error('Database not initialized');

    try {
      await this.pool.query(`
        UPDATE processed_sales 
        SET posted = TRUE, tweet_id = $1, updated_at = CURRENT_TIMESTAMP 
        WHERE id = $2
      `, [tweetId, id]);

      logger.debug(`Marked sale ${id} as posted with tweet ID: ${tweetId}`);
    } catch (error: any) {
      logger.error('Failed to mark sale as posted:', error.message);
      throw error;
    }
  }

  /**
   * Get/set system state values
   */
  async getSystemState(key: string): Promise<string | null> {
    if (!this.pool) throw new Error('Database not initialized');

    try {
      const result = await this.pool.query(
        'SELECT value FROM system_state WHERE key = $1',
        [key]
      );

      return result.rows.length > 0 ? result.rows[0].value : null;
    } catch (error: any) {
      logger.error(`Failed to get system state for key ${key}:`, error.message);
      throw error;
    }
  }

  async setSystemState(key: string, value: string): Promise<void> {
    if (!this.pool) throw new Error('Database not initialized');

    try {
      await this.pool.query(`
        INSERT INTO system_state (key, value, updated_at)
        VALUES ($1, $2, CURRENT_TIMESTAMP)
        ON CONFLICT (key) 
        DO UPDATE SET value = $2, updated_at = CURRENT_TIMESTAMP
      `, [key, value]);

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
    if (!this.pool) throw new Error('Database not initialized');

    try {
      const totalResult = await this.pool.query('SELECT COUNT(*) as count FROM processed_sales');
      const postedResult = await this.pool.query('SELECT COUNT(*) as count FROM processed_sales WHERE posted = TRUE');
      const unpostedResult = await this.pool.query('SELECT COUNT(*) as count FROM processed_sales WHERE posted = FALSE');
      const lastBlock = await this.getSystemState('last_processed_block');

      return {
        totalSales: parseInt(totalResult.rows[0].count),
        postedSales: parseInt(postedResult.rows[0].count),
        unpostedSales: parseInt(unpostedResult.rows[0].count),
        lastProcessedBlock: lastBlock
      };
    } catch (error: any) {
      logger.error('Failed to get database stats:', error.message);
      throw error;
    }
  }

  /**
   * Record a tweet post for rate limiting
   */
  async recordTweetPost(post: Omit<TwitterPost, 'id'>): Promise<number> {
    if (!this.pool) throw new Error('Database not initialized');

    try {
      const result = await this.pool.query(`
        INSERT INTO twitter_posts (sale_id, tweet_id, tweet_content, posted_at, success, error_message)
        VALUES ($1, $2, $3, $4, $5, $6)
        RETURNING id
      `, [
        post.saleId || null,
        post.tweetId,
        post.tweetContent,
        post.postedAt,
        post.success,
        post.errorMessage || null
      ]);

      const id = result.rows[0].id;
      logger.info(`Recorded tweet post with ID: ${id}`);
      return id;
    } catch (error: any) {
      logger.error('Failed to record tweet post:', error.message);
      throw error;
    }
  }

  /**
   * Get recent tweet posts
   */
  async getRecentTweetPosts(hoursBack: number = 24): Promise<TwitterPost[]> {
    if (!this.pool) throw new Error('Database not initialized');

    try {
      const cutoffTime = new Date(Date.now() - hoursBack * 60 * 60 * 1000);
      
      const result = await this.pool.query(`
        SELECT 
          id,
          sale_id as "saleId",
          tweet_id as "tweetId",
          tweet_content as "tweetContent",
          posted_at as "postedAt",
          success,
          error_message as "errorMessage"
        FROM twitter_posts 
        WHERE posted_at >= $1
        ORDER BY posted_at DESC
      `, [cutoffTime]);

      return result.rows.map(post => ({
        ...post,
        postedAt: post.postedAt.toISOString()
      }));
    } catch (error: any) {
      logger.error('Failed to get recent tweet posts:', error.message);
      throw error;
    }
  }

  /**
   * Get count of tweet posts in last 24 hours
   */
  async getTweetPostsInLast24Hours(): Promise<number> {
    if (!this.pool) throw new Error('Database not initialized');

    try {
      const cutoffTime = new Date(Date.now() - 24 * 60 * 60 * 1000);
      
      const result = await this.pool.query(`
        SELECT COUNT(*) as count 
        FROM twitter_posts 
        WHERE posted_at >= $1 AND success = TRUE
      `, [cutoffTime]);

      return parseInt(result.rows[0].count) || 0;
    } catch (error: any) {
      logger.error('Failed to count tweet posts in last 24 hours:', error.message);
      throw error;
    }
  }

  /**
   * Close database connection
   */
  async close(): Promise<void> {
    if (this.pool) {
      await this.pool.end();
      this.pool = null;
      logger.info('PostgreSQL connection pool closed');
    }
  }
}
