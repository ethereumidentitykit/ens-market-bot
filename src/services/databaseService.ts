import sqlite3 from 'sqlite3';
import { Database, open } from 'sqlite';
import path from 'path';
import fs from 'fs';
import { config } from '../utils/config';
import { logger } from '../utils/logger';
import { ProcessedSale, IDatabaseService, TwitterPost } from '../types';

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
        transaction_hash TEXT NOT NULL,
        contract_address TEXT NOT NULL,
        token_id TEXT NOT NULL UNIQUE,
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
        collection_name TEXT,
        collection_logo TEXT,
        nft_name TEXT,
        nft_image TEXT,
        nft_description TEXT,
        marketplace_logo TEXT,
        current_usd_value TEXT,
        verified_collection INTEGER DEFAULT 0,
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

    // Create twitter_posts table for rate limiting
    await this.db.exec(`
      CREATE TABLE IF NOT EXISTS twitter_posts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        sale_id INTEGER,
        tweet_id TEXT NOT NULL,
        tweet_content TEXT NOT NULL,
        posted_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        success BOOLEAN NOT NULL DEFAULT TRUE,
        error_message TEXT,
        FOREIGN KEY (sale_id) REFERENCES processed_sales (id)
      )
    `);

    // Create generated_images table for storing images in serverless environment
    await this.db.exec(`
      CREATE TABLE IF NOT EXISTS generated_images (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        filename TEXT NOT NULL UNIQUE,
        image_data BLOB NOT NULL,
        content_type TEXT NOT NULL DEFAULT 'image/png',
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
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
          block_number, block_timestamp, processed_at, posted,
          collection_name, collection_logo, nft_name, nft_image,
          nft_description, marketplace_logo, current_usd_value, verified_collection
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
        sale.posted ? 1 : 0,
        sale.collectionName || null,
        sale.collectionLogo || null,
        sale.nftName || null,
        sale.nftImage || null,
        sale.nftDescription || null,
        sale.marketplaceLogo || null,
        sale.currentUsdValue || null,
        sale.verifiedCollection ? 1 : 0
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
  async isSaleProcessed(tokenId: string): Promise<boolean> {
    if (!this.db) throw new Error('Database not initialized');

    try {
      const result = await this.db.get(
        'SELECT id FROM processed_sales WHERE token_id = ?',
        [tokenId]
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
          processed_at as processedAt, tweet_id as tweetId, posted,
          collection_name as collectionName, collection_logo as collectionLogo,
          nft_name as nftName, nft_image as nftImage, nft_description as nftDescription,
          marketplace_logo as marketplaceLogo, current_usd_value as currentUsdValue,
          verified_collection as verifiedCollection
        FROM processed_sales 
        ORDER BY block_number DESC 
        LIMIT ?
      `, [limit]);

      return rows.map(row => ({
        ...row,
        posted: !!row.posted,
        verifiedCollection: !!row.verifiedCollection
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
          processed_at as processedAt, tweet_id as tweetId, posted,
          collection_name as collectionName, collection_logo as collectionLogo,
          nft_name as nftName, nft_image as nftImage, nft_description as nftDescription,
          marketplace_logo as marketplaceLogo, current_usd_value as currentUsdValue,
          verified_collection as verifiedCollection
        FROM processed_sales 
        WHERE posted = 0 
        ORDER BY block_number DESC 
        LIMIT ?
      `, [limit]);

      return rows.map(row => ({
        ...row,
        posted: !!row.posted,
        verifiedCollection: !!row.verifiedCollection
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
   * Record a tweet post for rate limiting
   */
  async recordTweetPost(post: Omit<TwitterPost, 'id'>): Promise<number> {
    if (!this.db) throw new Error('Database not initialized');

    try {
      const result = await this.db.run(`
        INSERT INTO twitter_posts (sale_id, tweet_id, tweet_content, posted_at, success, error_message)
        VALUES (?, ?, ?, ?, ?, ?)
      `, [
        post.saleId || null,
        post.tweetId,
        post.tweetContent,
        post.postedAt,
        post.success ? 1 : 0,
        post.errorMessage || null
      ]);

      const id = result.lastID as number;
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
    if (!this.db) throw new Error('Database not initialized');

    try {
      const cutoffTime = new Date(Date.now() - hoursBack * 60 * 60 * 1000).toISOString();
      
      const posts = await this.db.all(`
        SELECT 
          id,
          sale_id as saleId,
          tweet_id as tweetId,
          tweet_content as tweetContent,
          posted_at as postedAt,
          success,
          error_message as errorMessage
        FROM twitter_posts 
        WHERE posted_at >= ?
        ORDER BY posted_at DESC
      `, [cutoffTime]);

      return posts.map(post => ({
        ...post,
        success: Boolean(post.success)
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
    if (!this.db) throw new Error('Database not initialized');

    try {
      const cutoffTime = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      
      const result = await this.db.get(`
        SELECT COUNT(*) as count 
        FROM twitter_posts 
        WHERE posted_at >= ? AND success = 1
      `, [cutoffTime]);

      return result?.count || 0;
    } catch (error: any) {
      logger.error('Failed to count tweet posts in last 24 hours:', error.message);
      throw error;
    }
  }

  /**
   * Reset database - clear all data and reset system state
   */
  async resetDatabase(): Promise<void> {
    if (!this.db) throw new Error('Database not initialized');

    try {
      logger.info('Starting database reset...');

      // Delete all data from tables
      await this.db.exec('DELETE FROM twitter_posts');
      await this.db.exec('DELETE FROM processed_sales');
      await this.db.exec('DELETE FROM system_state');

      // Reset auto-increment counters
      await this.db.exec('DELETE FROM sqlite_sequence WHERE name IN ("processed_sales", "twitter_posts")');

      logger.info('Database reset completed successfully');
    } catch (error: any) {
      logger.error('Failed to reset database:', error.message);
      throw error;
    }
  }

  /**
   * Migrate database schema - drop and recreate tables with new schema
   * This is needed to apply schema changes like unique constraint modifications
   */
  async migrateSchema(): Promise<void> {
    if (!this.db) throw new Error('Database not initialized');

    try {
      logger.info('Starting database schema migration...');

      // Drop existing tables
      await this.db.exec('DROP TABLE IF EXISTS processed_sales');
      await this.db.exec('DROP TABLE IF EXISTS twitter_posts');
      await this.db.exec('DROP TABLE IF EXISTS system_state');
      await this.db.exec('DROP TABLE IF EXISTS generated_images');

      // Recreate tables with new schema
      await this.createTables();

      logger.info('Database schema migration completed successfully');
    } catch (error: any) {
      logger.error('Failed to migrate database schema:', error.message);
      throw error;
    }
  }

  /**
   * Clear only sales table - keep tweets, settings, and system state
   */
  async clearSalesTable(): Promise<void> {
    if (!this.db) throw new Error('Database not initialized');

    try {
      logger.info('Starting sales table clear...');

      // Delete only sales data
      await this.db.exec('DELETE FROM processed_sales');

      // Reset auto-increment counter for sales table only
      await this.db.exec('DELETE FROM sqlite_sequence WHERE name = "processed_sales"');

      logger.info('Sales table cleared successfully');
    } catch (error: any) {
      logger.error('Failed to clear sales table:', error.message);
      throw error;
    }
  }

  /**
   * Store generated image in database
   */
  async storeGeneratedImage(filename: string, imageBuffer: Buffer, contentType: string = 'image/png'): Promise<void> {
    if (!this.db) throw new Error('Database not initialized');
    
    try {
      await this.db.run(
        'INSERT OR REPLACE INTO generated_images (filename, image_data, content_type) VALUES (?, ?, ?)',
        [filename, imageBuffer, contentType]
      );
      logger.info(`Stored generated image in database: ${filename}`);
    } catch (error: any) {
      logger.error('Failed to store generated image:', error.message);
      throw error;
    }
  }

  /**
   * Retrieve generated image from database
   */
  async getGeneratedImage(filename: string): Promise<{ buffer: Buffer; contentType: string } | null> {
    if (!this.db) throw new Error('Database not initialized');
    
    try {
      const row = await this.db.get(
        'SELECT image_data, content_type FROM generated_images WHERE filename = ?',
        [filename]
      );
      
      if (row) {
        return {
          buffer: row.image_data,
          contentType: row.content_type
        };
      }
      
      return null;
    } catch (error: any) {
      logger.error('Failed to retrieve generated image:', error.message);
      throw error;
    }
  }

  /**
   * Clean up old generated images (keep only last 100)
   */
  async cleanupOldImages(): Promise<void> {
    if (!this.db) throw new Error('Database not initialized');
    
    try {
      await this.db.run(`
        DELETE FROM generated_images 
        WHERE id NOT IN (
          SELECT id FROM generated_images 
          ORDER BY created_at DESC 
          LIMIT 100
        )
      `);
      logger.info('Cleaned up old generated images');
    } catch (error: any) {
      logger.error('Failed to cleanup old images:', error.message);
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
