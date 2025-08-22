import { Pool } from 'pg';
import { config } from '../utils/config';
import { logger } from '../utils/logger';
import { ProcessedSale, IDatabaseService, TwitterPost, ENSRegistration, ENSBid, PriceTier } from '../types';

/**
 * PostgreSQL database service 
 * Uses any PostgreSQL connection string (local or production)
 */
export class DatabaseService implements IDatabaseService {
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
          transaction_hash VARCHAR(66) NOT NULL,
          contract_address VARCHAR(42) NOT NULL,
          token_id VARCHAR(255) NOT NULL UNIQUE,
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
          collection_name TEXT,
          collection_logo TEXT,
          nft_name TEXT,
          nft_image TEXT,
          nft_description TEXT,
          marketplace_logo TEXT,
          current_usd_value TEXT,
          verified_collection BOOLEAN DEFAULT FALSE,
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

      // Create ens_registrations table
      await this.pool.query(`
        CREATE TABLE IF NOT EXISTS ens_registrations (
          id SERIAL PRIMARY KEY,
          transaction_hash VARCHAR(66) NOT NULL,
          contract_address VARCHAR(42) NOT NULL,
          token_id VARCHAR(255) NOT NULL UNIQUE,
          ens_name VARCHAR(255) NOT NULL,
          full_name VARCHAR(255) NOT NULL,
          owner_address VARCHAR(42) NOT NULL,
          cost_wei VARCHAR(100) NOT NULL,
          cost_eth DECIMAL(18,8),
          cost_usd DECIMAL(12,2),
          block_number INTEGER NOT NULL,
          block_timestamp TIMESTAMP NOT NULL,
          processed_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
          image TEXT,
          description TEXT,
          tweet_id VARCHAR(255),
          posted BOOLEAN DEFAULT FALSE,
          expires_at TIMESTAMP,
          created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
        )
      `);

      // Create indexes for faster lookups on ens_registrations
      await this.pool.query(`
        CREATE INDEX IF NOT EXISTS idx_ens_transaction_hash ON ens_registrations(transaction_hash)
      `);
      await this.pool.query(`
        CREATE INDEX IF NOT EXISTS idx_ens_token_id ON ens_registrations(token_id)
      `);
      await this.pool.query(`
        CREATE INDEX IF NOT EXISTS idx_ens_posted ON ens_registrations(posted)
      `);

      // Create ens_bids table
      await this.pool.query(`
        CREATE TABLE IF NOT EXISTS ens_bids (
          id SERIAL PRIMARY KEY,
          bid_id VARCHAR(255) NOT NULL UNIQUE,
          contract_address VARCHAR(42) NOT NULL,
          token_id VARCHAR(255),
          
          -- Bid Details (hex addresses only - live lookup ENS names)
          maker_address VARCHAR(42) NOT NULL,
          taker_address VARCHAR(42),
          status VARCHAR(50) NOT NULL,
          
          -- Pricing
          price_raw VARCHAR(100) NOT NULL,
          price_decimal DECIMAL(18,8) NOT NULL,
          price_usd DECIMAL(12,2),
          currency_contract VARCHAR(42) NOT NULL,
          currency_symbol VARCHAR(20) NOT NULL,
          
          -- Marketplace
          source_domain VARCHAR(255),
          source_name VARCHAR(100),
          marketplace_fee INTEGER,
          
          -- Timestamps & Duration
          created_at_api TIMESTAMP NOT NULL,
          updated_at_api TIMESTAMP NOT NULL,
          valid_from INTEGER NOT NULL,
          valid_until INTEGER NOT NULL,
          processed_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
          
          -- ENS Metadata
          ens_name VARCHAR(255), -- Resolved ENS name (e.g., "317.eth")
          nft_image TEXT,
          nft_description TEXT,
          
          -- Tweet Tracking
          tweet_id VARCHAR(255),
          posted BOOLEAN DEFAULT FALSE,
          
          -- Audit
          created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
        )
      `);

      // Create indexes for faster lookups on ens_bids
      await this.pool.query(`
        CREATE INDEX IF NOT EXISTS idx_bids_bid_id ON ens_bids(bid_id)
      `);
      await this.pool.query(`
        CREATE INDEX IF NOT EXISTS idx_bids_status ON ens_bids(status)
      `);
      await this.pool.query(`
        CREATE INDEX IF NOT EXISTS idx_bids_posted ON ens_bids(posted)
      `);
      await this.pool.query(`
        CREATE INDEX IF NOT EXISTS idx_bids_contract ON ens_bids(contract_address)
      `);
      await this.pool.query(`
        CREATE INDEX IF NOT EXISTS idx_bids_created_at ON ens_bids(created_at_api)
      `);

      // Create generated_images table for storing images in serverless environment
      await this.pool.query(`
        CREATE TABLE IF NOT EXISTS generated_images (
          id SERIAL PRIMARY KEY,
          filename VARCHAR(255) NOT NULL UNIQUE,
          image_data BYTEA NOT NULL,
          content_type VARCHAR(50) NOT NULL DEFAULT 'image/png',
          created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
        )
      `);

      // Create price_tiers table with transaction_type support (skip if already exists with correct structure)
      try {
        await this.pool.query(`
          CREATE TABLE IF NOT EXISTS price_tiers (
            id SERIAL PRIMARY KEY,
            transaction_type VARCHAR(20) NOT NULL CHECK (transaction_type IN ('sales', 'registrations', 'bids')),
            tier_level INTEGER NOT NULL CHECK (tier_level >= 1 AND tier_level <= 4),
            min_usd DECIMAL(12,2) NOT NULL,
            max_usd DECIMAL(12,2),
            description VARCHAR(255),
            created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
            CONSTRAINT unique_type_level UNIQUE (transaction_type, tier_level),
            CONSTRAINT check_min_max CHECK (max_usd IS NULL OR max_usd > min_usd)
          )
        `);
      } catch (error: any) {
        // If table already exists with different structure, that's okay - we'll work with what exists
        if (!error.message.includes('already exists')) {
          throw error;
        }
      }

      // Insert default price tiers for each transaction type (skip if already exists)
      try {
        await this.pool.query(`
          INSERT INTO price_tiers (transaction_type, tier_level, min_usd, max_usd, description)
          VALUES 
            -- Sales tiers
            ('sales', 1, 5000, 10000, 'Sales Grey border tier'),
            ('sales', 2, 10000, 40000, 'Sales Blue border tier'),
            ('sales', 3, 40000, 100000, 'Sales Purple border tier'),
            ('sales', 4, 100000, NULL, 'Sales Red border tier (premium)'),
            -- Registrations tiers
            ('registrations', 1, 5000, 10000, 'Registrations Grey border tier'),
            ('registrations', 2, 10000, 40000, 'Registrations Blue border tier'),
            ('registrations', 3, 40000, 100000, 'Registrations Purple border tier'),
            ('registrations', 4, 100000, NULL, 'Registrations Red border tier (premium)'),
            -- Bids tiers
            ('bids', 1, 5000, 10000, 'Bids Grey border tier'),
            ('bids', 2, 10000, 40000, 'Bids Blue border tier'),
            ('bids', 3, 40000, 100000, 'Bids Purple border tier'),
            ('bids', 4, 100000, NULL, 'Bids Red border tier (premium)')
          ON CONFLICT (transaction_type, tier_level) DO NOTHING
        `);
      } catch (error: any) {
        // If insertion fails due to constraint issues, that's okay - data might already exist
        logger.warn('Could not insert default price tiers (likely already exist):', error.message);
      }

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
          block_number, block_timestamp, processed_at, posted,
          collection_name, collection_logo, nft_name, nft_image,
          nft_description, marketplace_logo, current_usd_value, verified_collection
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20)
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
        sale.posted,
        sale.collectionName || null,
        sale.collectionLogo || null,
        sale.nftName || null,
        sale.nftImage || null,
        sale.nftDescription || null,
        sale.marketplaceLogo || null,
        sale.currentUsdValue || null,
        sale.verifiedCollection || false
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
  async isSaleProcessed(tokenId: string): Promise<boolean> {
    if (!this.pool) throw new Error('Database not initialized');

    try {
      const result = await this.pool.query(
        'SELECT id FROM processed_sales WHERE token_id = $1',
        [tokenId]
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
          processed_at as "processedAt", tweet_id as "tweetId", posted,
          collection_name as "collectionName", collection_logo as "collectionLogo",
          nft_name as "nftName", nft_image as "nftImage", nft_description as "nftDescription",
          marketplace_logo as "marketplaceLogo", current_usd_value as "currentUsdValue",
          verified_collection as "verifiedCollection"
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
          processed_at as "processedAt", tweet_id as "tweetId", posted,
          collection_name as "collectionName", collection_logo as "collectionLogo",
          nft_name as "nftName", nft_image as "nftImage", nft_description as "nftDescription",
          marketplace_logo as "marketplaceLogo", current_usd_value as "currentUsdValue",
          verified_collection as "verifiedCollection"
        FROM processed_sales 
        WHERE posted = FALSE 
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
   * Reset database - clear all data and reset system state
   */
  async resetDatabase(): Promise<void> {
    if (!this.pool) throw new Error('Database not initialized');

    try {
      logger.info('Starting database reset...');

      // Delete all data from tables (order matters due to foreign keys)
      await this.pool.query('DELETE FROM twitter_posts');
      await this.pool.query('DELETE FROM processed_sales');
      await this.pool.query('DELETE FROM system_state');

      // Reset sequences (PostgreSQL equivalent of auto-increment)
      await this.pool.query('ALTER SEQUENCE processed_sales_id_seq RESTART WITH 1');
      await this.pool.query('ALTER SEQUENCE twitter_posts_id_seq RESTART WITH 1');

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
    if (!this.pool) throw new Error('Database not initialized');

    try {
      logger.info('Starting database schema migration...');

      // Drop existing tables (order matters due to foreign keys)
      await this.pool.query('DROP TABLE IF EXISTS generated_images');
      await this.pool.query('DROP TABLE IF EXISTS twitter_posts');
      await this.pool.query('DROP TABLE IF EXISTS processed_sales');
      await this.pool.query('DROP TABLE IF EXISTS system_state');

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
    if (!this.pool) throw new Error('Database not initialized');

    try {
      logger.info('Starting sales table clear...');

      // Delete only sales data
      await this.pool.query('DELETE FROM processed_sales');

      // Reset sequence for sales table only
      await this.pool.query('ALTER SEQUENCE processed_sales_id_seq RESTART WITH 1');

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
    if (!this.pool) throw new Error('Database not initialized');
    
    try {
      await this.pool.query(
        'INSERT INTO generated_images (filename, image_data, content_type) VALUES ($1, $2, $3) ON CONFLICT (filename) DO UPDATE SET image_data = $2, content_type = $3, created_at = CURRENT_TIMESTAMP',
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
    if (!this.pool) throw new Error('Database not initialized');
    
    try {
      const result = await this.pool.query(
        'SELECT image_data, content_type FROM generated_images WHERE filename = $1',
        [filename]
      );
      
      if (result.rows.length > 0) {
        const row = result.rows[0];
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
    if (!this.pool) throw new Error('Database not initialized');
    
    try {
      await this.pool.query(`
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

  // Price Tier methods
  async getPriceTiers(transactionType?: string): Promise<PriceTier[]> {
    if (!this.pool) throw new Error('Database not initialized');
    
    try {
      let query = 'SELECT * FROM price_tiers';
      const params: any[] = [];
      
      if (transactionType) {
        query += ' WHERE transaction_type = $1';
        params.push(transactionType);
      }
      
      query += ' ORDER BY transaction_type, tier_level ASC';
      
      const result = await this.pool.query(query, params);
      
      return result.rows.map(row => ({
        id: row.id,
        transactionType: row.transaction_type,
        tierLevel: row.tier_level,
        minUsd: parseFloat(row.min_usd),
        maxUsd: row.max_usd ? parseFloat(row.max_usd) : null,
        description: row.description,
        createdAt: new Date(row.created_at),
        updatedAt: new Date(row.updated_at)
      }));
    } catch (error: any) {
      logger.error('Failed to get price tiers:', error.message);
      throw error;
    }
  }

  async updatePriceTier(transactionType: string, tierLevel: number, minUsd: number, maxUsd: number | null): Promise<void> {
    if (!this.pool) throw new Error('Database not initialized');
    
    try {
      await this.pool.query(
        `UPDATE price_tiers 
         SET min_usd = $3, max_usd = $4, updated_at = CURRENT_TIMESTAMP 
         WHERE transaction_type = $1 AND tier_level = $2`,
        [transactionType, tierLevel, minUsd, maxUsd]
      );
      logger.info(`Updated ${transactionType} price tier ${tierLevel}: $${minUsd} - ${maxUsd ? `$${maxUsd}` : 'unlimited'}`);
    } catch (error: any) {
      logger.error('Failed to update price tier:', error.message);
      throw error;
    }
  }

  async getPriceTierForAmount(transactionType: string, usdAmount: number): Promise<PriceTier | null> {
    if (!this.pool) throw new Error('Database not initialized');
    
    try {
      const result = await this.pool.query(
        `SELECT * FROM price_tiers 
         WHERE transaction_type = $1 AND $2 >= min_usd AND ($2 < max_usd OR max_usd IS NULL)
         ORDER BY tier_level ASC
         LIMIT 1`,
        [transactionType, usdAmount]
      );
      
      if (result.rows.length === 0) {
        // If no tier matches, check if amount is below minimum tier
        const lowestTier = await this.pool.query(
          'SELECT * FROM price_tiers WHERE transaction_type = $1 ORDER BY min_usd ASC LIMIT 1',
          [transactionType]
        );
        
        if (lowestTier.rows.length > 0 && usdAmount < parseFloat(lowestTier.rows[0].min_usd)) {
          // Return null for amounts below the minimum tier
          return null;
        }
        
        // Return highest tier for amounts above all tiers
        const highestTier = await this.pool.query(
          'SELECT * FROM price_tiers WHERE transaction_type = $1 ORDER BY tier_level DESC LIMIT 1',
          [transactionType]
        );
        
        if (highestTier.rows.length > 0) {
          const row = highestTier.rows[0];
          return {
            id: row.id,
            transactionType: row.transaction_type,
            tierLevel: row.tier_level,
            minUsd: parseFloat(row.min_usd),
            maxUsd: row.max_usd ? parseFloat(row.max_usd) : null,
            description: row.description,
            createdAt: new Date(row.created_at),
            updatedAt: new Date(row.updated_at)
          };
        }
        
        return null;
      }
      
      const row = result.rows[0];
      return {
        id: row.id,
        transactionType: row.transaction_type,
        tierLevel: row.tier_level,
        minUsd: parseFloat(row.min_usd),
        maxUsd: row.max_usd ? parseFloat(row.max_usd) : null,
        description: row.description,
        createdAt: new Date(row.created_at),
        updatedAt: new Date(row.updated_at)
      };
    } catch (error: any) {
      logger.error('Failed to get price tier for amount:', error.message);
      return null;
    }
  }

  // ENS Registration methods
  async insertRegistration(registration: Omit<ENSRegistration, 'id'>): Promise<number> {
    if (!this.pool) throw new Error('Database not initialized');

    try {
      const result = await this.pool.query(`
        INSERT INTO ens_registrations (
          transaction_hash, contract_address, token_id, ens_name, full_name,
          owner_address, cost_wei, cost_eth, cost_usd, block_number, 
          block_timestamp, processed_at, image, description, expires_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
        RETURNING id
      `, [
        registration.transactionHash,
        registration.contractAddress,
        registration.tokenId,
        registration.ensName,
        registration.fullName,
        registration.ownerAddress,
        registration.costWei,
        registration.costEth || null,
        registration.costUsd || null,
        registration.blockNumber,
        registration.blockTimestamp,
        registration.processedAt,
        registration.image || null,
        registration.description || null,
        registration.expiresAt || null
      ]);

      const id = result.rows[0].id;
      logger.debug(`Inserted ENS registration: ${registration.ensName} (ID: ${id})`);
      return id;
    } catch (error: any) {
      logger.error('Failed to insert ENS registration:', error.message);
      throw error;
    }
  }

  async isRegistrationProcessed(tokenId: string): Promise<boolean> {
    if (!this.pool) throw new Error('Database not initialized');

    try {
      const result = await this.pool.query(
        'SELECT COUNT(*) as count FROM ens_registrations WHERE token_id = $1',
        [tokenId]
      );
      
      return parseInt(result.rows[0].count) > 0;
    } catch (error: any) {
      logger.error('Failed to check if ENS registration processed:', error.message);
      throw error;
    }
  }

  async getRecentRegistrations(limit: number = 10): Promise<ENSRegistration[]> {
    if (!this.pool) throw new Error('Database not initialized');

    try {
      const result = await this.pool.query(`
        SELECT * FROM ens_registrations 
        ORDER BY block_number DESC 
        LIMIT $1
      `, [limit]);

      return this.mapRegistrationRows(result.rows);
    } catch (error: any) {
      logger.error('Failed to get recent ENS registrations:', error.message);
      throw error;
    }
  }

  async getUnpostedRegistrations(limit: number = 10): Promise<ENSRegistration[]> {
    if (!this.pool) throw new Error('Database not initialized');

    try {
      const result = await this.pool.query(`
        SELECT * FROM ens_registrations 
        WHERE posted = FALSE 
        ORDER BY block_number ASC 
        LIMIT $1
      `, [limit]);

      return this.mapRegistrationRows(result.rows);
    } catch (error: any) {
      logger.error('Failed to get unposted ENS registrations:', error.message);
      throw error;
    }
  }

  async markRegistrationAsPosted(id: number, tweetId: string): Promise<void> {
    if (!this.pool) throw new Error('Database not initialized');

    try {
      await this.pool.query(`
        UPDATE ens_registrations 
        SET posted = TRUE, tweet_id = $1, updated_at = CURRENT_TIMESTAMP 
        WHERE id = $2
      `, [tweetId, id]);

      logger.debug(`Marked ENS registration ${id} as posted with tweet ID: ${tweetId}`);
    } catch (error: any) {
      logger.error('Failed to mark ENS registration as posted:', error.message);
      throw error;
    }
  }

  private mapRegistrationRows(rows: any[]): ENSRegistration[] {
    return rows.map((row: any) => ({
      id: row.id,
      transactionHash: row.transaction_hash,
      contractAddress: row.contract_address,
      tokenId: row.token_id,
      ensName: row.ens_name,
      fullName: row.full_name,
      ownerAddress: row.owner_address,
      costWei: row.cost_wei,
      costEth: row.cost_eth,
      costUsd: row.cost_usd,
      blockNumber: row.block_number,
      blockTimestamp: row.block_timestamp,
      processedAt: row.processed_at,
      image: row.image,
      description: row.description,
      tweetId: row.tweet_id,
      posted: row.posted,
      expiresAt: row.expires_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    }));
  }

  // ENS Bids Methods

  /**
   * Insert a new ENS bid into the database
   */
  async insertBid(bid: Omit<ENSBid, 'id'>): Promise<number> {
    if (!this.pool) throw new Error('Database not initialized');

    try {
      const result = await this.pool.query(`
        INSERT INTO ens_bids (
          bid_id, contract_address, token_id, maker_address, taker_address,
          status, price_raw, price_decimal, price_usd, currency_contract,
          currency_symbol, source_domain, source_name, marketplace_fee,
          created_at_api, updated_at_api, valid_from, valid_until,
          processed_at, ens_name, nft_image, nft_description
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22)
        RETURNING id
      `, [
        bid.bidId,
        bid.contractAddress,
        bid.tokenId,
        bid.makerAddress,
        bid.takerAddress,
        bid.status,
        bid.priceRaw,
        bid.priceDecimal,
        bid.priceUsd,
        bid.currencyContract,
        bid.currencySymbol,
        bid.sourceDomain,
        bid.sourceName,
        bid.marketplaceFee,
        bid.createdAtApi,
        bid.updatedAtApi,
        bid.validFrom,
        bid.validUntil,
        bid.processedAt,
        bid.ensName,
        bid.nftImage,
        bid.nftDescription
      ]);

      const insertedId = result.rows[0].id;
      logger.debug(`Inserted ENS bid ${bid.bidId} with ID: ${insertedId}`);
      return insertedId;
    } catch (error: any) {
      if (error.code === '23505') { // PostgreSQL unique constraint violation
        logger.debug(`ENS bid ${bid.bidId} already exists, skipping`);
        throw new Error(`Bid ${bid.bidId} already processed`);
      }
      logger.error('Failed to insert ENS bid:', error.message);
      throw error;
    }
  }

  /**
   * Check if a bid has already been processed
   */
  async isBidProcessed(bidId: string): Promise<boolean> {
    if (!this.pool) throw new Error('Database not initialized');

    try {
      const result = await this.pool.query(
        'SELECT COUNT(*) as count FROM ens_bids WHERE bid_id = $1',
        [bidId]
      );
      return parseInt(result.rows[0].count, 10) > 0;
    } catch (error: any) {
      logger.error('Failed to check if bid is processed:', error.message);
      throw error;
    }
  }

  /**
   * Get recent ENS bids with optional limit
   */
  async getRecentBids(limit: number = 10): Promise<ENSBid[]> {
    if (!this.pool) throw new Error('Database not initialized');

    try {
      const result = await this.pool.query(`
        SELECT * FROM ens_bids 
        ORDER BY created_at_api DESC 
        LIMIT $1
      `, [limit]);

      return this.mapBidRows(result.rows);
    } catch (error: any) {
      logger.error('Failed to get recent bids:', error.message);
      throw error;
    }
  }

  /**
   * Get unposted ENS bids for tweet generation
   */
  async getUnpostedBids(limit: number = 10): Promise<ENSBid[]> {
    if (!this.pool) throw new Error('Database not initialized');

    try {
      const result = await this.pool.query(`
        SELECT * FROM ens_bids 
        WHERE posted = FALSE
        ORDER BY created_at_api DESC 
        LIMIT $1
      `, [limit]);

      return this.mapBidRows(result.rows);
    } catch (error: any) {
      logger.error('Failed to get unposted bids:', error.message);
      throw error;
    }
  }

  /**
   * Mark a bid as posted to Twitter
   */
  async markBidAsPosted(id: number, tweetId: string): Promise<void> {
    if (!this.pool) throw new Error('Database not initialized');

    try {
      await this.pool.query(`
        UPDATE ens_bids 
        SET posted = TRUE, tweet_id = $1, updated_at = CURRENT_TIMESTAMP 
        WHERE id = $2
      `, [tweetId, id]);

      logger.debug(`Marked ENS bid ${id} as posted with tweet ID: ${tweetId}`);
    } catch (error: any) {
      logger.error('Failed to mark ENS bid as posted:', error.message);
      throw error;
    }
  }

  /**
   * Get last processed bid timestamp for incremental fetching
   */
  async getLastProcessedBidTimestamp(): Promise<number> {
    const result = await this.getSystemState('last_processed_bid_timestamp');
    if (!result) {
      // Default to 7 days ago if no timestamp is set
      const defaultTimestamp = Date.now() - (7 * 24 * 60 * 60 * 1000);
      return defaultTimestamp;
    }
    return parseInt(result, 10);
  }

  /**
   * Set last processed bid timestamp
   */
  async setLastProcessedBidTimestamp(timestamp: number): Promise<void> {
    await this.setSystemState('last_processed_bid_timestamp', timestamp.toString());
  }

  /**
   * Map database rows to ENSBid objects
   */
  private mapBidRows(rows: any[]): ENSBid[] {
    return rows.map((row: any) => ({
      id: row.id,
      bidId: row.bid_id,
      contractAddress: row.contract_address,
      tokenId: row.token_id,
      makerAddress: row.maker_address,
      takerAddress: row.taker_address,
      status: row.status,
      priceRaw: row.price_raw,
      priceDecimal: row.price_decimal,
      priceUsd: row.price_usd,
      currencyContract: row.currency_contract,
      currencySymbol: row.currency_symbol,
      sourceDomain: row.source_domain,
      sourceName: row.source_name,
      marketplaceFee: row.marketplace_fee,
      createdAtApi: row.created_at_api,
      updatedAtApi: row.updated_at_api,
      validFrom: row.valid_from,
      validUntil: row.valid_until,
      processedAt: row.processed_at,
      ensName: row.ens_name,
      nftImage: row.nft_image,
      nftDescription: row.nft_description,
      tweetId: row.tweet_id,
      posted: row.posted,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    }));
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
