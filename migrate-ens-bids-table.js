#!/usr/bin/env node

/**
 * Simple ENS Bids Table Migration
 * Drops and recreates ens_bids table with correct schema (preserves other tables)
 * No bid data to preserve - just get the schema right
 */

async function migrateEnsBidsTable() {
  console.log('🚀 ENS Bids Table Migration\n');

  try {
    // Use the exact same database detection logic as the main app
    const isPostgreSQL = process.env.DATABASE_URL?.startsWith('postgresql://');
    
    console.log(`📊 Environment: ${process.env.NODE_ENV || 'development'}`);
    console.log(`📊 Database: ${isPostgreSQL ? 'PostgreSQL' : 'SQLite'}`);
    
    let db;
    if (isPostgreSQL) {
      const { VercelDatabaseService } = require('./dist/services/vercelDatabaseService');
      db = new VercelDatabaseService();
    } else {
      const { DatabaseService } = require('./dist/services/databaseService');
      db = new DatabaseService('./data/sales.db');
    }

    await db.initialize();
    console.log('✅ Database connected');

    // Simple approach: Drop and recreate ens_bids table
    console.log('🗑️  Dropping existing ens_bids table (if exists)...');
    
    if (isPostgreSQL) {
      await db.pool.query('DROP TABLE IF EXISTS ens_bids CASCADE');
    } else {
      await db.db.run('DROP TABLE IF EXISTS ens_bids');
    }
    
    console.log('✅ Old ens_bids table dropped');

    // Recreate with proper schema using the exact same code as database initialization
    console.log('🔄 Creating new ens_bids table with correct schema...');
    
    if (isPostgreSQL) {
      // PostgreSQL schema (from VercelDatabaseService)
      await db.pool.query(`
        CREATE TABLE IF NOT EXISTS ens_bids (
          id SERIAL PRIMARY KEY,
          bid_id VARCHAR(255) NOT NULL UNIQUE,
          contract_address VARCHAR(42) NOT NULL,
          token_id VARCHAR(255),
          
          -- Bid Details
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
          ens_name VARCHAR(255),
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

      // Create indexes
      await db.pool.query('CREATE INDEX IF NOT EXISTS idx_bids_bid_id ON ens_bids(bid_id)');
      await db.pool.query('CREATE INDEX IF NOT EXISTS idx_bids_status ON ens_bids(status)');
      await db.pool.query('CREATE INDEX IF NOT EXISTS idx_bids_posted ON ens_bids(posted)');
      await db.pool.query('CREATE INDEX IF NOT EXISTS idx_bids_contract ON ens_bids(contract_address)');
      await db.pool.query('CREATE INDEX IF NOT EXISTS idx_bids_created_at ON ens_bids(created_at_api)');
      
    } else {
      // SQLite schema (from DatabaseService)  
      await db.db.exec(`
        CREATE TABLE IF NOT EXISTS ens_bids (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          bid_id TEXT NOT NULL UNIQUE,
          contract_address TEXT NOT NULL,
          token_id TEXT,
          
          -- Bid Details
          maker_address TEXT NOT NULL,
          taker_address TEXT,
          status TEXT NOT NULL,
          
          -- Pricing
          price_raw TEXT NOT NULL,
          price_decimal TEXT NOT NULL,
          price_usd TEXT,
          currency_contract TEXT NOT NULL,
          currency_symbol TEXT NOT NULL,
          
          -- Marketplace
          source_domain TEXT,
          source_name TEXT,
          marketplace_fee INTEGER,
          
          -- Timestamps & Duration
          created_at_api TEXT NOT NULL,
          updated_at_api TEXT NOT NULL,
          valid_from INTEGER NOT NULL,
          valid_until INTEGER NOT NULL,
          processed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          
          -- ENS Metadata
          ens_name TEXT,
          nft_image TEXT,
          nft_description TEXT,
          
          -- Tweet Tracking
          tweet_id TEXT,
          posted INTEGER DEFAULT 0,
          
          -- Audit
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        )
      `);

      // Create indexes
      await db.db.exec('CREATE INDEX IF NOT EXISTS idx_bids_bid_id ON ens_bids(bid_id)');
      await db.db.exec('CREATE INDEX IF NOT EXISTS idx_bids_status ON ens_bids(status)');
      await db.db.exec('CREATE INDEX IF NOT EXISTS idx_bids_posted ON ens_bids(posted)');
      await db.db.exec('CREATE INDEX IF NOT EXISTS idx_bids_contract ON ens_bids(contract_address)');
      await db.db.exec('CREATE INDEX IF NOT EXISTS idx_bids_created_at ON ens_bids(created_at_api)');
    }

    console.log('✅ New ens_bids table created with correct schema');

    // Verify the ens_name column exists
    console.log('🔍 Verifying ens_name column...');
    
    if (isPostgreSQL) {
      const verifyResult = await db.pool.query(`
        SELECT column_name 
        FROM information_schema.columns 
        WHERE table_name = 'ens_bids' AND column_name = 'ens_name'
      `);
      
      if (verifyResult.rows.length > 0) {
        console.log('✅ ens_name column verified');
      } else {
        throw new Error('ens_name column not found');
      }
    } else {
      const columns = await db.db.all("PRAGMA table_info(ens_bids)");
      const hasEnsName = columns.some(col => col.name === 'ens_name');
      
      if (hasEnsName) {
        console.log('✅ ens_name column verified');
      } else {
        throw new Error('ens_name column not found');
      }
    }

    await db.close();

    console.log('\n🎉 Migration Complete!');
    console.log('📊 What happened:');
    console.log('  • Dropped old ens_bids table (if existed)');
    console.log('  • Created new ens_bids table with ens_name column');
    console.log('  • All indexes created for performance');
    console.log('  • Other tables (sales, registrations) untouched');
    console.log('  • Ready for ENS bid data ingestion');

    console.log('\n🚀 Next: Restart your service and the ENS bids feature will be fully operational!');

  } catch (error) {
    console.error('❌ Migration failed:', error.message);
    console.error(error.stack);
    process.exit(1);
  }
}

migrateEnsBidsTable();
