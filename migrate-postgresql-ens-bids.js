#!/usr/bin/env node

/**
 * PostgreSQL-Only ENS Bids Migration
 * No detection, no SQLite fallback - PostgreSQL ONLY
 */

async function migratePostgreSQL() {
  console.log('🚀 PostgreSQL ENS Bids Migration (PostgreSQL ONLY)\n');

  try {
    // FORCE PostgreSQL - no detection, no fallback
    const { VercelDatabaseService } = require('./dist/services/vercelDatabaseService');
    const db = new VercelDatabaseService();

    console.log('📊 Using PostgreSQL service directly');
    console.log('🔄 Initializing PostgreSQL connection...');
    
    await db.initialize();
    console.log('✅ PostgreSQL connected');

    // Test PostgreSQL connection
    const testResult = await db.pool.query('SELECT NOW() as current_time');
    console.log(`✅ PostgreSQL test query: ${testResult.rows[0].current_time}`);

    // Drop old ens_bids table (no data loss since no production bid data yet)
    console.log('🗑️  Dropping old ens_bids table...');
    await db.pool.query('DROP TABLE IF EXISTS ens_bids CASCADE');
    console.log('✅ Old table dropped');

    // Create new table with correct schema
    console.log('🔄 Creating ens_bids table with ens_name column...');
    await db.pool.query(`
      CREATE TABLE ens_bids (
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
        
        -- ENS Metadata (THE IMPORTANT PART!)
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
    console.log('✅ ens_bids table created');

    // Create all indexes
    console.log('🔄 Creating indexes...');
    await db.pool.query('CREATE INDEX idx_bids_bid_id ON ens_bids(bid_id)');
    await db.pool.query('CREATE INDEX idx_bids_status ON ens_bids(status)');
    await db.pool.query('CREATE INDEX idx_bids_posted ON ens_bids(posted)');
    await db.pool.query('CREATE INDEX idx_bids_contract ON ens_bids(contract_address)');
    await db.pool.query('CREATE INDEX idx_bids_created_at ON ens_bids(created_at_api)');
    console.log('✅ All indexes created');

    // Verify ens_name column exists
    const verifyResult = await db.pool.query(`
      SELECT column_name 
      FROM information_schema.columns 
      WHERE table_name = 'ens_bids' AND column_name = 'ens_name'
    `);
    
    if (verifyResult.rows.length > 0) {
      console.log('✅ ens_name column verified in PostgreSQL');
    } else {
      throw new Error('FAILED: ens_name column not found after creation');
    }

    // Show table structure
    const tableInfo = await db.pool.query(`
      SELECT column_name, data_type 
      FROM information_schema.columns 
      WHERE table_name = 'ens_bids' 
      ORDER BY ordinal_position
    `);
    
    console.log('\n📊 Final table structure:');
    tableInfo.rows.forEach(row => {
      const marker = row.column_name === 'ens_name' ? ' ← NEW!' : '';
      console.log(`  • ${row.column_name} (${row.data_type})${marker}`);
    });

    await db.close();

    console.log('\n🎉 PostgreSQL Migration Complete!');
    console.log('✅ ens_bids table recreated with ens_name column');
    console.log('✅ All other tables preserved');
    console.log('✅ Ready for ENS bid data');

  } catch (error) {
    console.error('❌ PostgreSQL migration failed:', error.message);
    process.exit(1);
  }
}

migratePostgreSQL();
