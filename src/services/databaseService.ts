import { Pool } from 'pg';
import { config } from '../utils/config';
import { logger } from '../utils/logger';
import { ProcessedSale, IDatabaseService, TwitterPost, ENSRegistration, ENSBid, PriceTier, SiweSession, AIReply, NameResearch } from '../types';

/**
 * PostgreSQL database service 
 * Uses any PostgreSQL connection string (local or production)
 */
export class DatabaseService implements IDatabaseService {
  private pool: Pool | null = null;

  /**
   * Get the connection pool for use with external libraries like connect-pg-simple
   */
  get pgPool(): Pool {
    if (!this.pool) throw new Error('Database not initialized');
    return this.pool;
  }

  /**
   * Initialize the PostgreSQL connection
   */
  async initialize(): Promise<void> {
    try {
      // Create PostgreSQL connection pool
      this.pool = new Pool({
        connectionString: process.env.POSTGRES_URL || process.env.DATABASE_URL,
        // No SSL needed - database is on same VPS (localhost)
      });

      logger.info('PostgreSQL connection pool created');

      // Create tables if they don't exist
      await this.createTables();
      
      // Auto-setup database triggers for real-time processing
      await this.setupSaleNotificationTriggers();
      await this.setupRegistrationNotificationTriggers();
      await this.setupBidNotificationTriggers();
      await this.setupAIReplyNotificationTriggers();
      
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
          token_id VARCHAR(255) NOT NULL,
          marketplace VARCHAR(50) NOT NULL,
          buyer_address VARCHAR(42) NOT NULL,
          seller_address VARCHAR(42) NOT NULL,
          price_amount DECIMAL(18,8) NOT NULL,
          price_usd DECIMAL(12,2),
          currency_symbol VARCHAR(20) DEFAULT 'ETH',
          block_number INTEGER NOT NULL,
          block_timestamp TIMESTAMP NOT NULL,
          log_index INTEGER,
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
          updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
          CONSTRAINT unique_tx_log UNIQUE (transaction_hash, log_index)
        )
      `);

      // Create indexes for faster lookups
      await this.pool.query(`
        CREATE INDEX IF NOT EXISTS idx_transaction_hash ON processed_sales(transaction_hash);
        CREATE INDEX IF NOT EXISTS idx_contract_address ON processed_sales(contract_address);
        CREATE INDEX IF NOT EXISTS idx_block_number ON processed_sales(block_number);
        CREATE INDEX IF NOT EXISTS idx_posted ON processed_sales(posted);
      `);

      // Add fee recipient columns for broker/referral tracking
      await this.pool.query(`
        ALTER TABLE processed_sales ADD COLUMN IF NOT EXISTS fee_recipient_address VARCHAR(42);
        ALTER TABLE processed_sales ADD COLUMN IF NOT EXISTS fee_amount_wei VARCHAR(78);
        ALTER TABLE processed_sales ADD COLUMN IF NOT EXISTS fee_percent DECIMAL(5,2);
      `);

      // Rename price_eth → price_amount and add currency_symbol for multi-currency support
      const colCheck = await this.pool.query(`
        SELECT column_name FROM information_schema.columns 
        WHERE table_name = 'processed_sales' AND column_name = 'price_eth'
      `);
      if (colCheck.rows.length > 0) {
        await this.pool.query(`ALTER TABLE processed_sales RENAME COLUMN price_eth TO price_amount`);
        logger.info('Migrated processed_sales: price_eth → price_amount');
      }
      await this.pool.query(`
        ALTER TABLE processed_sales ADD COLUMN IF NOT EXISTS currency_symbol VARCHAR(20) DEFAULT 'ETH';
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

      // Create admin_sessions table for SIWE authentication
      await this.pool.query(`
        CREATE TABLE IF NOT EXISTS admin_sessions (
          id SERIAL PRIMARY KEY,
          address VARCHAR(42) NOT NULL,
          session_id VARCHAR(255) NOT NULL UNIQUE,
          created_at TIMESTAMP NOT NULL,
          expires_at TIMESTAMP NOT NULL
        )
      `);

      // Create index for session lookup
      await this.pool.query(`
        CREATE INDEX IF NOT EXISTS idx_admin_sessions_session_id ON admin_sessions(session_id);
      `);

      // Create ai_replies table for AI-generated contextual replies
      await this.pool.query(`
        CREATE TABLE IF NOT EXISTS ai_replies (
          id SERIAL PRIMARY KEY,
          sale_id INTEGER REFERENCES processed_sales(id),
          registration_id INTEGER REFERENCES ens_registrations(id),
          bid_id INTEGER REFERENCES ens_bids(id),
          original_tweet_id VARCHAR(255) NOT NULL,
          reply_tweet_id VARCHAR(255),
          transaction_type VARCHAR(20) NOT NULL CHECK (transaction_type IN ('sale', 'registration', 'bid')),
          transaction_hash VARCHAR(66),
          model_used VARCHAR(50) NOT NULL,
          prompt_tokens INTEGER NOT NULL,
          completion_tokens INTEGER NOT NULL,
          total_tokens INTEGER NOT NULL,
          cost_usd DECIMAL(10,6) NOT NULL,
          reply_text TEXT NOT NULL,
          name_research_id INTEGER REFERENCES name_research(id),
          name_research TEXT,
          status VARCHAR(20) NOT NULL CHECK (status IN ('pending', 'posted', 'failed', 'skipped')) DEFAULT 'pending',
          error_message TEXT,
          created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
          posted_at TIMESTAMP,
          CONSTRAINT check_transaction_ref CHECK (
            (sale_id IS NOT NULL AND registration_id IS NULL AND bid_id IS NULL) OR
            (sale_id IS NULL AND registration_id IS NOT NULL AND bid_id IS NULL) OR
            (sale_id IS NULL AND registration_id IS NULL AND bid_id IS NOT NULL)
          )
        )
      `);

      // Migrations for existing databases
      await this.pool.query(`
        DO $$ 
        BEGIN
          -- Add name_research column if it doesn't exist
          IF NOT EXISTS (
            SELECT 1 FROM information_schema.columns 
            WHERE table_name = 'ai_replies' AND column_name = 'name_research'
          ) THEN
            ALTER TABLE ai_replies ADD COLUMN name_research TEXT;
          END IF;
          
          -- Add bid_id column if it doesn't exist
          IF NOT EXISTS (
            SELECT 1 FROM information_schema.columns 
            WHERE table_name = 'ai_replies' AND column_name = 'bid_id'
          ) THEN
            ALTER TABLE ai_replies ADD COLUMN bid_id INTEGER REFERENCES ens_bids(id);
          END IF;
          
          -- Add name_research_id column if it doesn't exist
          IF NOT EXISTS (
            SELECT 1 FROM information_schema.columns 
            WHERE table_name = 'ai_replies' AND column_name = 'name_research_id'
          ) THEN
            ALTER TABLE ai_replies ADD COLUMN name_research_id INTEGER REFERENCES name_research(id);
          END IF;
          
          -- Make transaction_hash nullable (for bids that don't have txHash yet)
          ALTER TABLE ai_replies ALTER COLUMN transaction_hash DROP NOT NULL;
          
          -- Drop old check constraint if it exists
          ALTER TABLE ai_replies DROP CONSTRAINT IF EXISTS ai_replies_transaction_type_check;
          
          -- Add updated check constraint for transaction_type to include 'bid'
          ALTER TABLE ai_replies ADD CONSTRAINT ai_replies_transaction_type_check 
            CHECK (transaction_type IN ('sale', 'registration', 'bid'));
          
          -- Drop old transaction reference constraint if it exists
          ALTER TABLE ai_replies DROP CONSTRAINT IF EXISTS check_transaction_ref;
          
          -- Add updated transaction reference constraint to include bid_id
          ALTER TABLE ai_replies ADD CONSTRAINT check_transaction_ref CHECK (
            (sale_id IS NOT NULL AND registration_id IS NULL AND bid_id IS NULL) OR
            (sale_id IS NULL AND registration_id IS NOT NULL AND bid_id IS NULL) OR
            (sale_id IS NULL AND registration_id IS NULL AND bid_id IS NOT NULL)
          );
        END $$;
      `);

      // Create indexes for ai_replies
      await this.pool.query(`
        CREATE INDEX IF NOT EXISTS idx_ai_replies_sale_id ON ai_replies(sale_id);
        CREATE INDEX IF NOT EXISTS idx_ai_replies_registration_id ON ai_replies(registration_id);
        CREATE INDEX IF NOT EXISTS idx_ai_replies_bid_id ON ai_replies(bid_id);
        CREATE INDEX IF NOT EXISTS idx_ai_replies_name_research_id ON ai_replies(name_research_id);
        CREATE INDEX IF NOT EXISTS idx_ai_replies_original_tweet ON ai_replies(original_tweet_id);
        CREATE INDEX IF NOT EXISTS idx_ai_replies_reply_tweet ON ai_replies(reply_tweet_id);
        CREATE INDEX IF NOT EXISTS idx_ai_replies_status ON ai_replies(status);
        CREATE INDEX IF NOT EXISTS idx_ai_replies_created_at ON ai_replies(created_at);
      `);

      // Create token_prices table for caching token USD prices (1 hour TTL)
      await this.pool.query(`
        CREATE TABLE IF NOT EXISTS token_prices (
          id SERIAL PRIMARY KEY,
          network VARCHAR(50) NOT NULL,           -- 'eth-mainnet', 'base-mainnet', etc.
          token_address VARCHAR(42),              -- NULL for native tokens (ETH)
          symbol VARCHAR(20),                     -- 'USDC', 'WETH', 'ETH', etc.
          decimals INTEGER,                       -- Token decimals (18 for ETH)
          price_usd DECIMAL(20,10) NOT NULL,      -- USD price
          last_updated_at TIMESTAMP NOT NULL,     -- When price was fetched from Alchemy
          created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
          
          -- Composite unique constraint for network + token_address
          CONSTRAINT unique_token_network UNIQUE (network, token_address)
        );
      `);

      // Create indexes for token_prices
      await this.pool.query(`
        CREATE INDEX IF NOT EXISTS idx_token_prices_lookup ON token_prices(network, token_address);
        CREATE INDEX IF NOT EXISTS idx_token_prices_expiry ON token_prices(last_updated_at);
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
          buyer_address, seller_address, price_amount, price_usd, currency_symbol,
          block_number, block_timestamp, log_index, processed_at, posted,
          collection_name, collection_logo, nft_name, nft_image,
          nft_description, marketplace_logo, current_usd_value, verified_collection,
          fee_recipient_address, fee_amount_wei, fee_percent
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25)
        RETURNING id
      `, [
        sale.transactionHash,
        sale.contractAddress,
        sale.tokenId,
        sale.marketplace,
        sale.buyerAddress,
        sale.sellerAddress,
        parseFloat(sale.priceAmount),
        sale.priceUsd ? parseFloat(sale.priceUsd) : null,
        sale.currencySymbol || 'ETH',
        sale.blockNumber,
        new Date(sale.blockTimestamp),
        sale.logIndex || null,
        new Date(sale.processedAt),
        sale.posted,
        sale.collectionName || null,
        sale.collectionLogo || null,
        sale.nftName || null,
        sale.nftImage || null,
        sale.nftDescription || null,
        sale.marketplaceLogo || null,
        sale.currentUsdValue || null,
        sale.verifiedCollection || false,
        sale.feeRecipientAddress || null,
        sale.feeAmountWei || null,
        sale.feePercent || null
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
   * Uses transaction_hash + log_index for true uniqueness (allows multiple sales of same ENS name)
   */
  async isSaleProcessed(transactionHash: string, logIndex: number): Promise<boolean> {
    if (!this.pool) throw new Error('Database not initialized');

    try {
      const result = await this.pool.query(
        'SELECT id FROM processed_sales WHERE transaction_hash = $1 AND log_index = $2',
        [transactionHash, logIndex]
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
          seller_address as "sellerAddress", price_amount as "priceAmount", price_usd as "priceUsd",
          currency_symbol as "currencySymbol",
          block_number as "blockNumber", block_timestamp as "blockTimestamp", log_index as "logIndex",
          processed_at as "processedAt", tweet_id as "tweetId", posted,
          collection_name as "collectionName", collection_logo as "collectionLogo",
          nft_name as "nftName", nft_image as "nftImage", nft_description as "nftDescription",
          marketplace_logo as "marketplaceLogo", current_usd_value as "currentUsdValue",
          verified_collection as "verifiedCollection",
          fee_recipient_address as "feeRecipientAddress", fee_amount_wei as "feeAmountWei",
          fee_percent as "feePercent"
        FROM processed_sales 
        ORDER BY block_number DESC 
        LIMIT $1
      `, [limit]);

      return result.rows.map(row => ({
        ...row,
        priceAmount: row.priceAmount.toString(),
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
   * Get a specific sale by ID
   */
  async getSaleById(id: number): Promise<ProcessedSale | null> {
    if (!this.pool) throw new Error('Database not initialized');

    try {
      const result = await this.pool.query(`
        SELECT 
          id, transaction_hash as "transactionHash", contract_address as "contractAddress",
          token_id as "tokenId", marketplace, buyer_address as "buyerAddress",
          seller_address as "sellerAddress", price_amount as "priceAmount", price_usd as "priceUsd",
          currency_symbol as "currencySymbol",
          block_number as "blockNumber", block_timestamp as "blockTimestamp", log_index as "logIndex",
          processed_at as "processedAt", tweet_id as "tweetId", posted,
          collection_name as "collectionName", collection_logo as "collectionLogo",
          nft_name as "nftName", nft_image as "nftImage", nft_description as "nftDescription",
          marketplace_logo as "marketplaceLogo", current_usd_value as "currentUsdValue",
          verified_collection as "verifiedCollection",
          fee_recipient_address as "feeRecipientAddress", fee_amount_wei as "feeAmountWei",
          fee_percent as "feePercent"
        FROM processed_sales 
        WHERE id = $1
      `, [id]);

      if (result.rows.length === 0) {
        return null;
      }

      const row = result.rows[0];
      return {
        ...row,
        priceAmount: row.priceAmount.toString(),
        priceUsd: row.priceUsd ? row.priceUsd.toString() : undefined,
        blockTimestamp: row.blockTimestamp.toISOString(),
        processedAt: row.processedAt.toISOString()
      };
    } catch (error: any) {
      logger.error('Failed to get sale by ID:', error.message);
      throw error;
    }
  }

  /**
   * Get a specific registration by ID
   */
  async getRegistrationById(id: number): Promise<ENSRegistration | null> {
    if (!this.pool) throw new Error('Database not initialized');

    try {
      const result = await this.pool.query(`
        SELECT 
          id, transaction_hash as "transactionHash", contract_address as "contractAddress",
          token_id as "tokenId", ens_name as "ensName", full_name as "fullName",
          owner_address as "ownerAddress", cost_wei as "costWei", cost_eth as "costEth",
          cost_usd as "costUsd", block_number as "blockNumber", block_timestamp as "blockTimestamp",
          processed_at as "processedAt", image, description, tweet_id as "tweetId", 
          posted, expires_at as "expiresAt", created_at as "createdAt", updated_at as "updatedAt"
        FROM ens_registrations 
        WHERE id = $1
      `, [id]);

      if (result.rows.length === 0) {
        return null;
      }

      const row = result.rows[0];
      return {
        ...row,
        costEth: row.costEth ? row.costEth.toString() : undefined,
        costUsd: row.costUsd ? row.costUsd.toString() : undefined,
        blockTimestamp: row.blockTimestamp.toISOString(),
        processedAt: row.processedAt.toISOString(),
        expiresAt: row.expiresAt ? row.expiresAt.toISOString() : undefined,
        createdAt: row.createdAt ? row.createdAt.toISOString() : undefined,
        updatedAt: row.updatedAt ? row.updatedAt.toISOString() : undefined
      };

    } catch (error: any) {
      logger.error('Failed to get registration by ID:', error.message);
      throw error;
    }
  }

  /**
   * Get sales that haven't been posted to Twitter yet
   */
  async getUnpostedSales(limit: number = 10, maxAgeHours: number = 1): Promise<ProcessedSale[]> {
    if (!this.pool) throw new Error('Database not initialized');

    // Safety fallback: if maxAgeHours is invalid (0, null, undefined, etc.), use 24 hours
    const safeMaxAgeHours = maxAgeHours && maxAgeHours > 0 ? maxAgeHours : 24;
    
    if (safeMaxAgeHours !== maxAgeHours) {
      logger.warn(`Invalid sales maxAgeHours (${maxAgeHours}), using 24-hour fallback`);
    }

    try {
      const result = await this.pool.query(`
        SELECT 
          id, transaction_hash as "transactionHash", contract_address as "contractAddress",
          token_id as "tokenId", marketplace, buyer_address as "buyerAddress",
          seller_address as "sellerAddress", price_amount as "priceAmount", price_usd as "priceUsd",
          currency_symbol as "currencySymbol",
          block_number as "blockNumber", block_timestamp as "blockTimestamp", log_index as "logIndex",
          processed_at as "processedAt", tweet_id as "tweetId", posted,
          collection_name as "collectionName", collection_logo as "collectionLogo",
          nft_name as "nftName", nft_image as "nftImage", nft_description as "nftDescription",
          marketplace_logo as "marketplaceLogo", current_usd_value as "currentUsdValue",
          verified_collection as "verifiedCollection",
          fee_recipient_address as "feeRecipientAddress", fee_amount_wei as "feeAmountWei",
          fee_percent as "feePercent"
        FROM processed_sales 
        WHERE posted = FALSE 
          AND block_timestamp > NOW() - INTERVAL '1 hour' * $2
        ORDER BY block_number DESC 
        LIMIT $1
      `, [limit, safeMaxAgeHours]);

      logger.debug(`getUnpostedSales: Found ${result.rows.length} sales within ${safeMaxAgeHours} hours`);

      return result.rows.map(row => ({
        ...row,
        priceAmount: row.priceAmount.toString(),
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
   * AI Configuration Methods
   * Type-safe wrappers around system_state for AI settings
   */

  /**
   * Check if AI replies are globally enabled
   * @returns true if enabled, false otherwise
   */
  async isAIRepliesEnabled(): Promise<boolean> {
    const value = await this.getSystemState('ai_replies_enabled');
    return value === 'true'; // Default: false
  }

  /**
   * Enable or disable AI replies globally
   * @param enabled - true to enable, false to disable
   */
  async setAIRepliesEnabled(enabled: boolean): Promise<void> {
    await this.setSystemState('ai_replies_enabled', enabled.toString());
    logger.info(`AI replies ${enabled ? 'enabled' : 'disabled'}`);
  }

  /**
   * Get the OpenAI model to use for AI replies
   * @returns model name (default: "gpt-5")
   */
  async getAIModel(): Promise<string> {
    const value = await this.getSystemState('ai_openai_model');
    return value || 'gpt-5';
  }

  /**
   * Set the OpenAI model to use for AI replies
   * @param model - model name (e.g., "gpt-5", "o1")
   */
  async setAIModel(model: string): Promise<void> {
    await this.setSystemState('ai_openai_model', model);
    logger.info(`AI model set to: ${model}`);
  }

  /**
   * Get the temperature for AI generation
   * @returns temperature value (0.0-1.0, default: 0.7)
   */
  async getAITemperature(): Promise<number> {
    const value = await this.getSystemState('ai_temperature');
    return value ? parseFloat(value) : 0.7;
  }

  /**
   * Set the temperature for AI generation
   * @param temperature - temperature value (0.0-1.0)
   */
  async setAITemperature(temperature: number): Promise<void> {
    if (temperature < 0 || temperature > 1) {
      throw new Error('Temperature must be between 0 and 1');
    }
    await this.setSystemState('ai_temperature', temperature.toString());
    logger.info(`AI temperature set to: ${temperature}`);
  }

  /**
   * Get the maximum tokens for AI completion
   * @returns max tokens (default: 500 for ~800 char responses)
   */
  async getAIMaxTokens(): Promise<number> {
    const value = await this.getSystemState('ai_max_tokens');
    return value ? parseInt(value, 10) : 500; // Default 500 tokens for ~800 char responses
  }

  /**
   * Set the maximum tokens for AI completion
   * @param maxTokens - maximum completion tokens
   */
  async setAIMaxTokens(maxTokens: number): Promise<void> {
    if (maxTokens < 1) {
      throw new Error('Max tokens must be greater than 0');
    }
    await this.setSystemState('ai_max_tokens', maxTokens.toString());
    logger.info(`AI max tokens set to: ${maxTokens}`);
  }

  /**
   * Bid Blacklist Methods
   * Manages a list of ENS names to ignore during bid processing
   */

  /**
   * Get the current bid blacklist
   * @returns Array of blacklisted ENS names
   */
  async getBidBlacklist(): Promise<string[]> {
    const value = await this.getSystemState('bid_name_blacklist');
    if (!value) return [];
    try {
      return JSON.parse(value);
    } catch {
      logger.warn('Failed to parse bid blacklist, returning empty array');
      return [];
    }
  }

  /**
   * Set the entire bid blacklist (replaces existing)
   * @param names - Array of ENS names to blacklist
   */
  async setBidBlacklist(names: string[]): Promise<void> {
    // Normalize names (lowercase, trim)
    const normalized = names.map(n => n.toLowerCase().trim()).filter(n => n.length > 0);
    // Remove duplicates
    const unique = [...new Set(normalized)];
    await this.setSystemState('bid_name_blacklist', JSON.stringify(unique));
    logger.info(`Bid blacklist set to ${unique.length} names`);
  }

  /**
   * Add a name to the bid blacklist
   * @param name - ENS name to add
   */
  async addToBidBlacklist(name: string): Promise<void> {
    const normalized = name.toLowerCase().trim();
    if (!normalized) return;
    
    const current = await this.getBidBlacklist();
    if (!current.includes(normalized)) {
      current.push(normalized);
      await this.setSystemState('bid_name_blacklist', JSON.stringify(current));
      logger.info(`Added "${normalized}" to bid blacklist`);
    }
  }

  /**
   * Remove a name from the bid blacklist
   * @param name - ENS name to remove
   */
  async removeFromBidBlacklist(name: string): Promise<void> {
    const normalized = name.toLowerCase().trim();
    const current = await this.getBidBlacklist();
    const updated = current.filter(n => n !== normalized);
    
    if (updated.length !== current.length) {
      await this.setSystemState('bid_name_blacklist', JSON.stringify(updated));
      logger.info(`Removed "${normalized}" from bid blacklist`);
    }
  }

  /**
   * Check if a name is blacklisted
   * @param name - ENS name to check
   * @returns true if blacklisted
   */
  async isNameBlacklisted(name: string): Promise<boolean> {
    const normalized = name.toLowerCase().trim();
    const blacklist = await this.getBidBlacklist();
    return blacklist.includes(normalized);
  }

  /**
   * Address Blacklist Methods
   * Manages a list of wallet addresses to ignore during sales and bid posting
   * (prevents wash trade tweets from known bad actors)
   */

  /**
   * Get the current address blacklist
   * @returns Array of blacklisted wallet addresses (lowercase hex)
   */
  async getAddressBlacklist(): Promise<string[]> {
    const value = await this.getSystemState('address_blacklist');
    if (!value) return [];
    try {
      return JSON.parse(value);
    } catch {
      logger.warn('Failed to parse address blacklist, returning empty array');
      return [];
    }
  }

  /**
   * Set the entire address blacklist (replaces existing)
   * @param addresses - Array of wallet addresses to blacklist
   */
  async setAddressBlacklist(addresses: string[]): Promise<void> {
    // Normalize addresses (lowercase, trim)
    const normalized = addresses.map(a => a.toLowerCase().trim()).filter(a => a.length > 0);
    // Remove duplicates
    const unique = [...new Set(normalized)];
    await this.setSystemState('address_blacklist', JSON.stringify(unique));
    logger.info(`Address blacklist set to ${unique.length} addresses`);
  }

  /**
   * Add an address to the address blacklist
   * @param address - Wallet address to add
   */
  async addToAddressBlacklist(address: string): Promise<void> {
    const normalized = address.toLowerCase().trim();
    if (!normalized) return;
    
    const current = await this.getAddressBlacklist();
    if (!current.includes(normalized)) {
      current.push(normalized);
      await this.setSystemState('address_blacklist', JSON.stringify(current));
      logger.info(`Added "${normalized}" to address blacklist`);
    }
  }

  /**
   * Remove an address from the address blacklist
   * @param address - Wallet address to remove
   */
  async removeFromAddressBlacklist(address: string): Promise<void> {
    const normalized = address.toLowerCase().trim();
    const current = await this.getAddressBlacklist();
    const updated = current.filter(a => a !== normalized);
    
    if (updated.length !== current.length) {
      await this.setSystemState('address_blacklist', JSON.stringify(updated));
      logger.info(`Removed "${normalized}" from address blacklist`);
    }
  }

  /**
   * Check if a wallet address is blacklisted
   * @param address - Wallet address to check
   * @returns true if blacklisted
   */
  async isAddressBlacklisted(address: string): Promise<boolean> {
    const normalized = address.toLowerCase().trim();
    const blacklist = await this.getAddressBlacklist();
    return blacklist.includes(normalized);
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

  /**
   * Insert registration with source tracking and detailed duplicate logging
   */
  async insertRegistrationWithSourceTracking(
    registration: Omit<ENSRegistration, 'id'>, 
    source: 'quicknode' | 'moralis'
  ): Promise<number> {
    if (!this.pool) throw new Error('Database not initialized');

    try {
      // Check if already exists and get details for duplicate logging
      const existingResult = await this.pool.query(`
        SELECT 
          id, ens_name, processed_at, transaction_hash, 
          EXTRACT(EPOCH FROM (NOW() - processed_at)) as seconds_ago
        FROM ens_registrations 
        WHERE token_id = $1
      `, [registration.tokenId]);

      if (existingResult.rows.length > 0) {
        const existing = existingResult.rows[0];
        const secondsAgo = Math.round(existing.seconds_ago);
        
        // Determine original source based on transaction patterns or timing
        const originalSource = this.inferRegistrationSource(existing.transaction_hash, secondsAgo);
        
        logger.warn(`🔄 DUPLICATE REGISTRATION ATTEMPT: ${source.toUpperCase()} tried to add ${existing.ens_name}.eth, but it was already processed ${this.formatTimeAgo(secondsAgo)} ago by ${originalSource.toUpperCase()} (Original ID: ${existing.id})`);
        
        // Return the existing ID instead of throwing error
        return existing.id;
      }

      // No duplicate found, proceed with insert
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
      logger.info(`💾 ${source.toUpperCase()} successfully stored registration: ${registration.ensName}.eth (ID: ${id})`);
      return id;
    } catch (error: any) {
      logger.error(`Failed to insert ENS registration from ${source}:`, error.message);
      throw error;
    }
  }

  /**
   * Infer the original source of a registration based on patterns
   */
  private inferRegistrationSource(transactionHash: string, secondsAgo: number): string {
    // If it's very recent (< 10 seconds), likely QuickNode was first
    if (secondsAgo < 10) {
      return 'quicknode';
    }
    // For older registrations, we can't be certain, so use generic term
    return 'webhook';
  }

  /**
   * Format seconds into human-readable time
   */
  private formatTimeAgo(seconds: number): string {
    if (seconds < 60) {
      return `${seconds} second${seconds !== 1 ? 's' : ''}`;
    } else if (seconds < 3600) {
      const minutes = Math.floor(seconds / 60);
      return `${minutes} minute${minutes !== 1 ? 's' : ''}`;
    } else {
      const hours = Math.floor(seconds / 3600);
      return `${hours} hour${hours !== 1 ? 's' : ''}`;
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

  async getUnpostedRegistrations(limit: number = 10, maxAgeHours: number = 3): Promise<ENSRegistration[]> {
    if (!this.pool) throw new Error('Database not initialized');

    // Safety fallback: if maxAgeHours is invalid (0, null, undefined, etc.), use 24 hours
    const safeMaxAgeHours = maxAgeHours && maxAgeHours > 0 ? maxAgeHours : 24;
    
    if (safeMaxAgeHours !== maxAgeHours) {
      logger.warn(`Invalid maxAgeHours (${maxAgeHours}), using 24-hour fallback`);
    }

    try {
      // Add debug query to see what's in the database
      const debugResult = await this.pool.query(`
        SELECT id, ens_name, block_timestamp, processed_at, posted, 
               NOW() as current_time,
               NOW() - INTERVAL '1 hour' * $1 as cutoff_time,
               block_timestamp > NOW() - INTERVAL '1 hour' * $1 as within_range_block,
               processed_at > NOW() - INTERVAL '1 hour' * $1 as within_range_processed
        FROM ens_registrations 
        WHERE posted = FALSE 
        ORDER BY id DESC 
        LIMIT 3
      `, [safeMaxAgeHours]);
      
      logger.info(`DEBUG: Last 3 unposted registrations:`);
      debugResult.rows.forEach(row => {
        logger.info(`  ID ${row.id}: ${row.ens_name}, posted=${row.posted}`);
        logger.info(`    Block time: ${row.block_timestamp} (within range: ${row.within_range_block})`);
        logger.info(`    Processed: ${row.processed_at} (within range: ${row.within_range_processed})`);
        logger.info(`    Current: ${row.current_time}, Cutoff: ${row.cutoff_time}`);
      });

      const result = await this.pool.query(`
        SELECT * FROM ens_registrations 
        WHERE posted = FALSE 
          AND block_timestamp > NOW() - INTERVAL '1 hour' * $2
        ORDER BY block_number DESC 
        LIMIT $1
      `, [limit, safeMaxAgeHours]);

      logger.debug(`getUnpostedRegistrations: Found ${result.rows.length} registrations within ${safeMaxAgeHours} hours`);
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
  async getUnpostedBids(limit: number = 10, maxAgeHours: number = 24): Promise<ENSBid[]> {
    if (!this.pool) throw new Error('Database not initialized');

    // Safety fallback: if maxAgeHours is invalid (0, null, undefined, etc.), use 24 hours
    const safeMaxAgeHours = maxAgeHours && maxAgeHours > 0 ? maxAgeHours : 24;
    
    if (safeMaxAgeHours !== maxAgeHours) {
      logger.warn(`Invalid bids maxAgeHours (${maxAgeHours}), using 24-hour fallback`);
    }

    try {
      // First ensure status column exists and is migrated
      await this.pool.query(`
        ALTER TABLE ens_bids ADD COLUMN IF NOT EXISTS status VARCHAR(20) DEFAULT 'unposted'
      `);
      
      await this.pool.query(`
        UPDATE ens_bids 
        SET status = CASE 
          WHEN posted = TRUE AND (status IS NULL OR status = '') THEN 'posted'
          WHEN posted = FALSE AND (status IS NULL OR status = '') THEN 'unposted'
          ELSE COALESCE(status, 'unposted')
        END
        WHERE status IS NULL OR status = ''
      `);

      const result = await this.pool.query(`
        SELECT * FROM ens_bids 
        WHERE (status = 'unposted' OR (status IS NULL AND posted = FALSE))
          AND created_at_api > NOW() - INTERVAL '1 hour' * $2
        ORDER BY created_at_api DESC 
        LIMIT $1
      `, [limit, safeMaxAgeHours]);

      logger.debug(`getUnpostedBids: Found ${result.rows.length} bids within ${safeMaxAgeHours} hours`);

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
        SET posted = TRUE, status = 'posted', tweet_id = $1, updated_at = CURRENT_TIMESTAMP 
        WHERE id = $2
      `, [tweetId, id]);

      logger.debug(`Marked ENS bid ${id} as posted with tweet ID: ${tweetId}`);
    } catch (error: any) {
      logger.error('Failed to mark ENS bid as posted:', error.message);
      throw error;
    }
  }

  /**
   * Get bid by ID
   */
  async getBidById(id: number): Promise<ENSBid | null> {
    if (!this.pool) throw new Error('Database not initialized');

    try {
      const result = await this.pool.query(`
        SELECT 
          id, bid_id as "bidId", contract_address as "contractAddress",
          token_id as "tokenId", maker_address as "makerAddress", taker_address as "takerAddress",
          status, price_raw as "priceRaw", price_decimal as "priceDecimal",
          price_usd as "priceUsd", currency_contract as "currencyContract", 
          currency_symbol as "currencySymbol", source_domain as "sourceDomain",
          source_name as "sourceName", marketplace_fee as "marketplaceFee",
          valid_from as "validFrom", valid_until as "validUntil", created_at_api as "createdAtApi",
          processed_at as "processedAt", tweet_id as "tweetId", posted, ens_name as "ensName",
          nft_image as "nftImage", nft_description as "nftDescription"
        FROM ens_bids 
        WHERE id = $1
      `, [id]);

      if (result.rows.length === 0) {
        return null;
      }

      const bid = this.mapBidRows([result.rows[0]])[0];
      return bid;

    } catch (error: any) {
      logger.error(`Error fetching bid by ID ${id}:`, error.message);
      throw error;
    }
  }

  /**
   * Mark a bid as failed (validation failed, don't retry)
   */
  async markBidAsFailed(id: number, reason: string): Promise<void> {
    if (!this.pool) throw new Error('Database not initialized');

    try {
      // First check if status column exists, if not add it
      await this.pool.query(`
        ALTER TABLE ens_bids ADD COLUMN IF NOT EXISTS status VARCHAR(20) DEFAULT 'unposted'
      `);
      
      // Migrate existing data if needed (only once)
      await this.pool.query(`
        UPDATE ens_bids 
        SET status = CASE 
          WHEN posted = TRUE AND status IS NULL THEN 'posted'
          WHEN posted = FALSE AND status IS NULL THEN 'unposted'
          ELSE COALESCE(status, 'unposted')
        END
        WHERE status IS NULL OR status = ''
      `);

      // Mark this specific bid as failed
      await this.pool.query(`
        UPDATE ens_bids 
        SET status = 'failed', updated_at = CURRENT_TIMESTAMP 
        WHERE id = $1
      `, [id]);

      logger.warn(`🚫 Marked ENS bid ${id} as failed: ${reason}`);
    } catch (error: any) {
      logger.error('Failed to mark ENS bid as failed:', error.message);
      throw error;
    }
  }

  /**
   * Get last processed bid timestamp for incremental fetching
   */
  async getLastProcessedBidTimestamp(): Promise<number> {
    const result = await this.getSystemState('last_processed_bid_timestamp');
    if (!result) {
      // Default to current time (boundary logic will apply 1-hour cap)
      return Date.now();
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
      bidId: row.bidId || row.bid_id,
      contractAddress: row.contractAddress || row.contract_address,
      tokenId: row.tokenId || row.token_id,
      makerAddress: row.makerAddress || row.maker_address,
      takerAddress: row.takerAddress || row.taker_address,
      status: row.status,
      priceRaw: row.priceRaw || row.price_raw,
      priceDecimal: row.priceDecimal || row.price_decimal,
      priceUsd: row.priceUsd || row.price_usd,
      currencyContract: row.currencyContract || row.currency_contract,
      currencySymbol: row.currencySymbol || row.currency_symbol,
      sourceDomain: row.sourceDomain || row.source_domain,
      sourceName: row.sourceName || row.source_name,
      marketplaceFee: row.marketplaceFee || row.marketplace_fee,
      createdAtApi: row.createdAtApi || row.created_at_api,
      updatedAtApi: row.updatedAtApi || row.updated_at_api,
      validFrom: row.validFrom || row.valid_from,
      validUntil: row.validUntil || row.valid_until,
      processedAt: row.processedAt || row.processed_at,
      ensName: row.ensName || row.ens_name,
      nftImage: row.nftImage || row.nft_image,
      nftDescription: row.nftDescription || row.nft_description,
      tweetId: row.tweetId || row.tweet_id,
      posted: row.posted,
      createdAt: row.createdAt || row.created_at,
      updatedAt: row.updatedAt || row.updated_at
    }));
  }

  /**
   * Get name research by ENS name
   */
  async getNameResearch(ensName: string): Promise<NameResearch | null> {
    if (!this.pool) throw new Error('Database not initialized');

    try {
      const result = await this.pool.query(`
        SELECT 
          id, ens_name as "ensName", research_text as "researchText",
          researched_at as "researchedAt", updated_at as "updatedAt",
          source, created_at as "createdAt"
        FROM name_research
        WHERE ens_name = $1
      `, [ensName]);

      if (result.rows.length === 0) {
        return null;
      }

      const row = result.rows[0];
      return {
        id: row.id,
        ensName: row.ensName,
        researchText: row.researchText,
        researchedAt: row.researchedAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
        source: row.source,
        createdAt: row.createdAt ? row.createdAt.toISOString() : undefined
      };
    } catch (error: any) {
      logger.error('Failed to get name research:', error.message);
      throw error;
    }
  }

  /**
   * Insert new name research
   */
  async insertNameResearch(research: Omit<NameResearch, 'id' | 'createdAt' | 'updatedAt'>): Promise<number> {
    if (!this.pool) throw new Error('Database not initialized');

    try {
      const result = await this.pool.query(`
        INSERT INTO name_research (ens_name, research_text, researched_at, source)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (ens_name) 
        DO UPDATE SET 
          research_text = $2,
          researched_at = $3,
          updated_at = CURRENT_TIMESTAMP
        RETURNING id
      `, [research.ensName, research.researchText, research.researchedAt, research.source]);

      const id = result.rows[0].id;
      logger.info(`Stored name research for ${research.ensName} (ID: ${id})`);
      return id;
    } catch (error: any) {
      logger.error('Failed to insert name research:', error.message);
      throw error;
    }
  }

  /**
   * Update existing name research with fresh data
   */
  async updateNameResearch(ensName: string, researchText: string): Promise<void> {
    if (!this.pool) throw new Error('Database not initialized');

    try {
      await this.pool.query(`
        UPDATE name_research
        SET research_text = $1, researched_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
        WHERE ens_name = $2
      `, [researchText, ensName]);

      logger.info(`Updated name research for ${ensName}`);
    } catch (error: any) {
      logger.error('Failed to update name research:', error.message);
      throw error;
    }
  }

  /**
   * Get cached token price (if not expired - 1 hour TTL)
   * @returns null if not found or expired
   */
  async getTokenPrice(
    network: string,
    tokenAddress: string | null
  ): Promise<{ priceUsd: number; symbol: string; decimals: number; lastUpdatedAt: Date } | null> {
    if (!this.pool) throw new Error('Database not initialized');

    try {
      const result = await this.pool.query(`
        SELECT price_usd as "priceUsd", symbol, decimals, last_updated_at as "lastUpdatedAt"
        FROM token_prices
        WHERE network = $1 AND (token_address = $2 OR (token_address IS NULL AND $2 IS NULL))
          AND last_updated_at > NOW() - INTERVAL '1 hour'
      `, [network, tokenAddress]);

      if (result.rows.length === 0) {
        return null;
      }

      const row = result.rows[0];
      return {
        priceUsd: parseFloat(row.priceUsd),
        symbol: row.symbol,
        decimals: row.decimals,
        lastUpdatedAt: row.lastUpdatedAt
      };
    } catch (error: any) {
      logger.error('Failed to get token price from cache:', error.message);
      return null; // Graceful degradation - return null on error
    }
  }

  /**
   * Set/update token price in cache
   * Uses INSERT ... ON CONFLICT to upsert
   */
  async setTokenPrice(
    network: string,
    tokenAddress: string | null,
    symbol: string,
    decimals: number,
    priceUsd: number
  ): Promise<void> {
    if (!this.pool) throw new Error('Database not initialized');

    try {
      await this.pool.query(`
        INSERT INTO token_prices (network, token_address, symbol, decimals, price_usd, last_updated_at)
        VALUES ($1, $2, $3, $4, $5, NOW())
        ON CONFLICT (network, token_address)
        DO UPDATE SET
          symbol = $3,
          decimals = $4,
          price_usd = $5,
          last_updated_at = NOW()
      `, [network, tokenAddress, symbol, decimals, priceUsd]);

      logger.debug(`Cached price for ${symbol} on ${network}: $${priceUsd}`);
    } catch (error: any) {
      logger.error('Failed to set token price in cache:', error.message);
      // Don't throw - caching failure shouldn't break the flow
    }
  }

  /**
   * Batch set multiple token prices (more efficient)
   */
  async setTokenPricesBatch(
    prices: Array<{
      network: string;
      tokenAddress: string | null;
      symbol: string;
      decimals: number;
      priceUsd: number;
    }>
  ): Promise<void> {
    if (!this.pool) throw new Error('Database not initialized');
    if (prices.length === 0) return;

    try {
      // Build VALUES clause for batch insert
      const values: any[] = [];
      const placeholders: string[] = [];
      
      prices.forEach((price, idx) => {
        const offset = idx * 5;
        placeholders.push(`($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5}, NOW())`);
        values.push(price.network, price.tokenAddress, price.symbol, price.decimals, price.priceUsd);
      });

      await this.pool.query(`
        INSERT INTO token_prices (network, token_address, symbol, decimals, price_usd, last_updated_at)
        VALUES ${placeholders.join(', ')}
        ON CONFLICT (network, token_address)
        DO UPDATE SET
          symbol = EXCLUDED.symbol,
          decimals = EXCLUDED.decimals,
          price_usd = EXCLUDED.price_usd,
          last_updated_at = NOW()
      `, values);

      logger.debug(`Cached ${prices.length} token prices in batch`);
    } catch (error: any) {
      logger.error('Failed to batch set token prices:', error.message);
      // Don't throw - caching failure shouldn't break the flow
    }
  }

  /**
   * Cleanup expired token price cache entries (optional maintenance)
   * @param olderThanHours Delete entries older than X hours (default: 24)
   * @returns Number of entries deleted
   */
  async cleanupExpiredTokenPrices(olderThanHours: number = 24): Promise<number> {
    if (!this.pool) throw new Error('Database not initialized');

    try {
      const result = await this.pool.query(`
        DELETE FROM token_prices
        WHERE last_updated_at < NOW() - INTERVAL '${olderThanHours} hours'
      `);

      const deleted = result.rowCount || 0;
      if (deleted > 0) {
        logger.info(`Cleaned up ${deleted} expired token price entries`);
      }
      return deleted;
    } catch (error: any) {
      logger.error('Failed to cleanup expired token prices:', error.message);
      return 0;
    }
  }

  /**
   * Insert a new AI reply record
   */
  async insertAIReply(reply: Omit<AIReply, 'id' | 'createdAt' | 'postedAt'>): Promise<number> {
    if (!this.pool) throw new Error('Database not initialized');

    try {
      const result = await this.pool.query(`
        INSERT INTO ai_replies (
          sale_id, registration_id, bid_id, original_tweet_id, reply_tweet_id,
          transaction_type, transaction_hash, model_used,
          prompt_tokens, completion_tokens, total_tokens, cost_usd,
          reply_text, name_research_id, name_research, status, error_message
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
        RETURNING id
      `, [
        reply.saleId || null,
        reply.registrationId || null,
        reply.bidId || null,
        reply.originalTweetId,
        reply.replyTweetId || null,
        reply.transactionType,
        reply.transactionHash || null,
        reply.modelUsed,
        reply.promptTokens,
        reply.completionTokens,
        reply.totalTokens,
        reply.costUsd,
        reply.replyText,
        reply.nameResearchId || null,
        reply.nameResearch || null, // Keep for backward compatibility during migration
        reply.status,
        reply.errorMessage || null
      ]);

      logger.info(`AI reply inserted with ID: ${result.rows[0].id}`);
      return result.rows[0].id;
    } catch (error: any) {
      logger.error('Failed to insert AI reply:', error.message);
      throw error;
    }
  }

  /**
   * Get AI reply by sale ID
   */
  async getAIReplyBySaleId(saleId: number): Promise<AIReply | null> {
    if (!this.pool) throw new Error('Database not initialized');

    try {
      const result = await this.pool.query(`
        SELECT 
          id, sale_id as "saleId", registration_id as "registrationId", bid_id as "bidId",
          original_tweet_id as "originalTweetId", reply_tweet_id as "replyTweetId",
          transaction_type as "transactionType", transaction_hash as "transactionHash",
          model_used as "modelUsed", prompt_tokens as "promptTokens",
          completion_tokens as "completionTokens", total_tokens as "totalTokens",
          cost_usd as "costUsd", reply_text as "replyText", name_research as "nameResearch", status,
          error_message as "errorMessage", created_at as "createdAt",
          posted_at as "postedAt"
        FROM ai_replies
        WHERE sale_id = $1
      `, [saleId]);

      return result.rows.length > 0 ? result.rows[0] : null;
    } catch (error: any) {
      logger.error('Failed to get AI reply by sale ID:', error.message);
      throw error;
    }
  }

  /**
   * Get AI reply by registration ID
   */
  async getAIReplyByRegistrationId(registrationId: number): Promise<AIReply | null> {
    if (!this.pool) throw new Error('Database not initialized');

    try {
      const result = await this.pool.query(`
        SELECT 
          id, sale_id as "saleId", registration_id as "registrationId", bid_id as "bidId",
          original_tweet_id as "originalTweetId", reply_tweet_id as "replyTweetId",
          transaction_type as "transactionType", transaction_hash as "transactionHash",
          model_used as "modelUsed", prompt_tokens as "promptTokens",
          completion_tokens as "completionTokens", total_tokens as "totalTokens",
          cost_usd as "costUsd", reply_text as "replyText", name_research as "nameResearch", status,
          error_message as "errorMessage", created_at as "createdAt",
          posted_at as "postedAt"
        FROM ai_replies
        WHERE registration_id = $1
      `, [registrationId]);

      return result.rows.length > 0 ? result.rows[0] : null;
    } catch (error: any) {
      logger.error('Failed to get AI reply by registration ID:', error.message);
      throw error;
    }
  }

  /**
   * Get AI reply by bid ID
   */
  async getAIReplyByBidId(bidId: number): Promise<AIReply | null> {
    if (!this.pool) throw new Error('Database not initialized');

    try {
      const result = await this.pool.query(`
        SELECT 
          id, sale_id as "saleId", registration_id as "registrationId", bid_id as "bidId",
          original_tweet_id as "originalTweetId", reply_tweet_id as "replyTweetId",
          transaction_type as "transactionType", transaction_hash as "transactionHash",
          model_used as "modelUsed", prompt_tokens as "promptTokens",
          completion_tokens as "completionTokens", total_tokens as "totalTokens",
          cost_usd as "costUsd", reply_text as "replyText", name_research as "nameResearch", status,
          error_message as "errorMessage", created_at as "createdAt",
          posted_at as "postedAt"
        FROM ai_replies
        WHERE bid_id = $1
      `, [bidId]);

      return result.rows.length > 0 ? result.rows[0] : null;
    } catch (error: any) {
      logger.error('Failed to get AI reply by bid ID:', error.message);
      throw error;
    }
  }

  /**
   * Get AI reply by ID
   */
  async getAIReplyById(replyId: number): Promise<AIReply | null> {
    if (!this.pool) throw new Error('Database not initialized');

    try {
      const result = await this.pool.query(`
        SELECT 
          id, sale_id as "saleId", registration_id as "registrationId", bid_id as "bidId",
          original_tweet_id as "originalTweetId", reply_tweet_id as "replyTweetId",
          transaction_type as "transactionType", transaction_hash as "transactionHash",
          model_used as "modelUsed", prompt_tokens as "promptTokens",
          completion_tokens as "completionTokens", total_tokens as "totalTokens",
          cost_usd as "costUsd", reply_text as "replyText", name_research as "nameResearch", status,
          error_message as "errorMessage", created_at as "createdAt",
          posted_at as "postedAt"
        FROM ai_replies
        WHERE id = $1
      `, [replyId]);

      return result.rows.length > 0 ? result.rows[0] : null;
    } catch (error: any) {
      logger.error('Failed to get AI reply by ID:', error.message);
      throw error;
    }
  }

  /**
   * Get recent AI replies
   */
  async getRecentAIReplies(limit: number = 50): Promise<AIReply[]> {
    if (!this.pool) throw new Error('Database not initialized');

    try {
      const result = await this.pool.query(`
        SELECT 
          id, sale_id as "saleId", registration_id as "registrationId",
          original_tweet_id as "originalTweetId", reply_tweet_id as "replyTweetId",
          transaction_type as "transactionType", transaction_hash as "transactionHash",
          model_used as "modelUsed", prompt_tokens as "promptTokens",
          completion_tokens as "completionTokens", total_tokens as "totalTokens",
          cost_usd as "costUsd", reply_text as "replyText", name_research as "nameResearch", status,
          error_message as "errorMessage", created_at as "createdAt",
          posted_at as "postedAt"
        FROM ai_replies
        ORDER BY created_at DESC
        LIMIT $1
      `, [limit]);

      return result.rows;
    } catch (error: any) {
      logger.error('Failed to get recent AI replies:', error.message);
      throw error;
    }
  }

  /**
   * Update AI reply tweet ID (after posting)
   */
  async updateAIReplyTweetId(id: number, replyTweetId: string): Promise<void> {
    if (!this.pool) throw new Error('Database not initialized');

    try {
      await this.pool.query(`
        UPDATE ai_replies
        SET reply_tweet_id = $1, status = 'posted', posted_at = NOW()
        WHERE id = $2
      `, [replyTweetId, id]);

      logger.info(`AI reply ${id} marked as posted with tweet ID: ${replyTweetId}`);
    } catch (error: any) {
      logger.error('Failed to update AI reply tweet ID:', error.message);
      throw error;
    }
  }

  /**
   * Update AI reply status
   */
  async updateAIReplyStatus(id: number, status: AIReply['status'], errorMessage?: string): Promise<void> {
    if (!this.pool) throw new Error('Database not initialized');

    try {
      await this.pool.query(`
        UPDATE ai_replies
        SET status = $1, error_message = $2
        WHERE id = $3
      `, [status, errorMessage || null, id]);

      logger.info(`AI reply ${id} status updated to: ${status}`);
    } catch (error: any) {
      logger.error('Failed to update AI reply status:', error.message);
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

  // SIWE Admin Session Management Methods

  /**
   * Create a new admin session
   */
  async createAdminSession(session: Omit<SiweSession, 'id'>): Promise<void> {
    if (!this.pool) throw new Error('Database not initialized');

    const query = `
      INSERT INTO admin_sessions (address, session_id, created_at, expires_at)
      VALUES ($1, $2, $3, $4)
    `;
    
    await this.pool.query(query, [
      session.address,
      session.sessionId,
      session.createdAt,
      session.expiresAt
    ]);
  }

  /**
   * Get an admin session by session ID
   */
  async getAdminSession(sessionId: string): Promise<SiweSession | null> {
    if (!this.pool) throw new Error('Database not initialized');

    const query = 'SELECT * FROM admin_sessions WHERE session_id = $1';
    const result = await this.pool.query(query, [sessionId]);
    
    if (result.rows.length === 0) {
      return null;
    }

    const row = result.rows[0];
    return {
      id: row.id,
      address: row.address,
      sessionId: row.session_id,
      createdAt: row.created_at,
      expiresAt: row.expires_at
    };
  }

  /**
   * Delete an admin session
   */
  async deleteAdminSession(sessionId: string): Promise<void> {
    if (!this.pool) throw new Error('Database not initialized');

    const query = 'DELETE FROM admin_sessions WHERE session_id = $1';
    await this.pool.query(query, [sessionId]);
  }

  /**
   * Clean up expired admin sessions
   */
  async cleanupExpiredSessions(): Promise<void> {
    if (!this.pool) throw new Error('Database not initialized');

    const query = 'DELETE FROM admin_sessions WHERE expires_at < NOW()';
    const result = await this.pool.query(query);
    
    if (result.rowCount && result.rowCount > 0) {
      logger.info(`Cleaned up ${result.rowCount} expired admin session(s)`);
    }
  }

  /**
   * Set up PostgreSQL triggers for real-time sale notifications
   * Creates trigger function and trigger for instant processing
   */
  async setupSaleNotificationTriggers(): Promise<void> {
    if (!this.pool) throw new Error('Database not initialized');

    try {
      // Step 1: Create the trigger function
      const createFunctionQuery = `
        CREATE OR REPLACE FUNCTION notify_new_sale() 
        RETURNS TRIGGER AS $$
        BEGIN
          -- Only notify for unposted sales
          IF NEW.posted = FALSE THEN
            PERFORM pg_notify('new_sale', NEW.id::text);
          END IF;
          RETURN NEW;
        END;
        $$ LANGUAGE plpgsql;
      `;

      await this.pool.query(createFunctionQuery);
      logger.info('✅ Created notify_new_sale() trigger function');

      // Step 2: Create the trigger (if it doesn't exist)
      const createTriggerQuery = `
        DO $$
        BEGIN
          IF NOT EXISTS (
            SELECT 1 FROM pg_trigger WHERE tgname = 'new_sale_trigger'
          ) THEN
            CREATE TRIGGER new_sale_trigger 
              AFTER INSERT ON processed_sales 
              FOR EACH ROW EXECUTE FUNCTION notify_new_sale();
          END IF;
        END $$;
      `;

      await this.pool.query(createTriggerQuery);
      logger.info('✅ Created new_sale_trigger on processed_sales table');

      logger.info('🎯 Sale notification triggers setup complete - ready for real-time processing!');

    } catch (error: any) {
      logger.error('❌ Failed to setup sale notification triggers:', error.message);
      throw error;
    }
  }

  /**
   * Set up database notification triggers for real-time registration processing
   */
  async setupRegistrationNotificationTriggers(): Promise<void> {
    if (!this.pool) throw new Error('Database not initialized');

    try {
      // Step 1: Create the trigger function
      const createFunctionQuery = `
        CREATE OR REPLACE FUNCTION notify_new_registration() 
        RETURNS TRIGGER AS $$
        BEGIN
          -- Only notify for unposted registrations
          IF NEW.posted = FALSE THEN
            PERFORM pg_notify('new_registration', NEW.id::text);
          END IF;
          RETURN NEW;
        END;
        $$ LANGUAGE plpgsql;
      `;

      await this.pool.query(createFunctionQuery);
      logger.info('✅ Created notify_new_registration() trigger function');

      // Step 2: Create the trigger (if it doesn't exist)
      const createTriggerQuery = `
        DO $$
        BEGIN
          IF NOT EXISTS (
            SELECT 1 FROM pg_trigger WHERE tgname = 'new_registration_trigger'
          ) THEN
            CREATE TRIGGER new_registration_trigger 
              AFTER INSERT ON ens_registrations 
              FOR EACH ROW EXECUTE FUNCTION notify_new_registration();
          END IF;
        END $$;
      `;

      await this.pool.query(createTriggerQuery);
      logger.info('✅ Created new_registration_trigger on ens_registrations table');

      logger.info('🎯 Registration notification triggers setup complete - ready for real-time processing!');

    } catch (error: any) {
      logger.error('❌ Failed to setup registration notification triggers:', error.message);
      throw error;
    }
  }

  /**
   * Set up database notification triggers for real-time bid processing
   * Creates trigger function and trigger for instant processing
   */
  async setupBidNotificationTriggers(): Promise<void> {
    if (!this.pool) throw new Error('Database not initialized');

    try {
      // Step 1: Create the trigger function
      const createFunctionQuery = `
        CREATE OR REPLACE FUNCTION notify_new_bid() 
        RETURNS TRIGGER AS $$
        BEGIN
          -- Only notify for unposted bids
          IF NEW.status = 'unposted' THEN
            PERFORM pg_notify('new_bid', NEW.id::text);
          END IF;
          RETURN NEW;
        END;
        $$ LANGUAGE plpgsql;
      `;

      await this.pool.query(createFunctionQuery);
      logger.info('✅ Created notify_new_bid() trigger function');

      // Step 2: Create the trigger (if it doesn't exist)
      const createTriggerQuery = `
        DO $$
        BEGIN
          IF NOT EXISTS (
            SELECT 1 FROM pg_trigger WHERE tgname = 'new_bid_trigger'
          ) THEN
            CREATE TRIGGER new_bid_trigger 
              AFTER INSERT ON ens_bids 
              FOR EACH ROW EXECUTE FUNCTION notify_new_bid();
          END IF;
        END $$;
      `;

      await this.pool.query(createTriggerQuery);
      logger.info('✅ Created new_bid_trigger on ens_bids table');

      logger.info('🎯 Bid notification triggers setup complete - ready for real-time processing!');

    } catch (error: any) {
      logger.error('❌ Failed to setup bid notification triggers:', error.message);
      throw error;
    }
  }

  /**
   * Set up database notification triggers for AI reply generation
   * Triggers fire when tweets are successfully posted (posted = TRUE)
   * 
   * Phase 3.1: Auto-queue AI reply generation when sales/registrations are tweeted
   */
  async setupAIReplyNotificationTriggers(): Promise<void> {
    if (!this.pool) throw new Error('Database not initialized');

    try {
      // ===== SALES TRIGGER =====
      
      // Step 1a: Create the sale trigger function
      const createSaleFunctionQuery = `
        CREATE OR REPLACE FUNCTION notify_posted_sale() 
        RETURNS TRIGGER AS $$
        BEGIN
          -- Only notify when a sale is successfully posted to Twitter
          -- posted changes FALSE → TRUE and tweet_id exists
          IF NEW.posted = TRUE AND NEW.tweet_id IS NOT NULL THEN
            PERFORM pg_notify('posted_sale', NEW.id::text);
          END IF;
          RETURN NEW;
        END;
        $$ LANGUAGE plpgsql;
      `;

      await this.pool.query(createSaleFunctionQuery);
      logger.info('✅ Created notify_posted_sale() trigger function');

      // Step 1b: Create the sale trigger (UPDATE only, with WHEN condition)
      const createSaleTriggerQuery = `
        DO $$
        BEGIN
          -- Drop old trigger if it exists
          DROP TRIGGER IF EXISTS posted_sale_trigger ON processed_sales;
          
          -- Create new trigger with WHEN condition
          CREATE TRIGGER posted_sale_trigger 
            AFTER UPDATE ON processed_sales 
            FOR EACH ROW 
            WHEN (OLD.posted = FALSE AND NEW.posted = TRUE)
            EXECUTE FUNCTION notify_posted_sale();
        END $$;
      `;

      await this.pool.query(createSaleTriggerQuery);
      logger.info('✅ Created posted_sale_trigger on processed_sales table');

      // ===== REGISTRATION TRIGGER =====
      
      // Step 2a: Create the registration trigger function
      const createRegistrationFunctionQuery = `
        CREATE OR REPLACE FUNCTION notify_posted_registration() 
        RETURNS TRIGGER AS $$
        BEGIN
          -- Only notify when a registration is successfully posted to Twitter
          -- posted changes FALSE → TRUE and tweet_id exists
          IF NEW.posted = TRUE AND NEW.tweet_id IS NOT NULL THEN
            PERFORM pg_notify('posted_registration', NEW.id::text);
          END IF;
          RETURN NEW;
        END;
        $$ LANGUAGE plpgsql;
      `;

      await this.pool.query(createRegistrationFunctionQuery);
      logger.info('✅ Created notify_posted_registration() trigger function');

      // Step 2b: Create the registration trigger (UPDATE only, with WHEN condition)
      const createRegistrationTriggerQuery = `
        DO $$
        BEGIN
          -- Drop old trigger if it exists
          DROP TRIGGER IF EXISTS posted_registration_trigger ON ens_registrations;
          
          -- Create new trigger with WHEN condition
          CREATE TRIGGER posted_registration_trigger 
            AFTER UPDATE ON ens_registrations 
            FOR EACH ROW 
            WHEN (OLD.posted = FALSE AND NEW.posted = TRUE)
            EXECUTE FUNCTION notify_posted_registration();
        END $$;
      `;

      await this.pool.query(createRegistrationTriggerQuery);
      logger.info('✅ Created posted_registration_trigger on ens_registrations table');

      // ===== BID TRIGGER =====
      
      // Step 3a: Create the bid trigger function
      const createBidFunctionQuery = `
        CREATE OR REPLACE FUNCTION notify_posted_bid() 
        RETURNS TRIGGER AS $$
        BEGIN
          -- Only notify when a bid is successfully posted to Twitter
          -- posted changes FALSE → TRUE and tweet_id exists
          IF NEW.posted = TRUE AND NEW.tweet_id IS NOT NULL THEN
            PERFORM pg_notify('posted_bid', NEW.id::text);
          END IF;
          RETURN NEW;
        END;
        $$ LANGUAGE plpgsql;
      `;

      await this.pool.query(createBidFunctionQuery);
      logger.info('✅ Created notify_posted_bid() trigger function');

      // Step 3b: Create the bid trigger (UPDATE only, with WHEN condition)
      const createBidTriggerQuery = `
        DO $$
        BEGIN
          -- Drop old trigger if it exists
          DROP TRIGGER IF EXISTS posted_bid_trigger ON ens_bids;
          
          -- Create new trigger with WHEN condition
          CREATE TRIGGER posted_bid_trigger 
            AFTER UPDATE ON ens_bids 
            FOR EACH ROW 
            WHEN (OLD.posted = FALSE AND NEW.posted = TRUE)
            EXECUTE FUNCTION notify_posted_bid();
        END $$;
      `;

      await this.pool.query(createBidTriggerQuery);
      logger.info('✅ Created posted_bid_trigger on ens_bids table');

      logger.info('🎯 AI Reply notification triggers setup complete - ready for automatic AI reply generation!');

    } catch (error: any) {
      logger.error('❌ Failed to setup AI reply notification triggers:', error.message);
      throw error;
    }
  }

  /**
   * Check if sale notification triggers are properly set up
   */
  async checkSaleNotificationTriggers(): Promise<boolean> {
    if (!this.pool) throw new Error('Database not initialized');

    try {
      // Check if trigger function exists
      const functionCheck = await this.pool.query(`
        SELECT EXISTS (
          SELECT 1 FROM pg_proc 
          WHERE proname = 'notify_new_sale'
        ) as function_exists;
      `);

      // Check if trigger exists
      const triggerCheck = await this.pool.query(`
        SELECT EXISTS (
          SELECT 1 FROM pg_trigger 
          WHERE tgname = 'new_sale_trigger'
        ) as trigger_exists;
      `);

      const functionExists = functionCheck.rows[0].function_exists;
      const triggerExists = triggerCheck.rows[0].trigger_exists;

      logger.info(`🔍 Trigger status - Function: ${functionExists ? '✅' : '❌'}, Trigger: ${triggerExists ? '✅' : '❌'}`);

      return functionExists && triggerExists;
    } catch (error: any) {
      logger.error('❌ Failed to check trigger status:', error.message);
      return false;
    }
  }
}
