/**
 * Database Migration Script
 * Adds NFT metadata columns to existing PostgreSQL database
 * 
 * Usage:
 * 1. Set POSTGRES_URL environment variable
 * 2. Run: node scripts/migrate-database.js
 */

const { Pool } = require('pg');

async function migrateDatabase() {
  if (!process.env.POSTGRES_URL) {
    console.error('❌ POSTGRES_URL environment variable is required');
    process.exit(1);
  }

  const pool = new Pool({
    connectionString: process.env.POSTGRES_URL,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
  });

  try {
    console.log('🔄 Starting database migration...');

    // Check if columns already exist
    const columnsCheck = await pool.query(`
      SELECT column_name 
      FROM information_schema.columns 
      WHERE table_name = 'processed_sales' 
      AND column_name IN ('collection_name', 'nft_name', 'collection_logo', 'nft_image', 'nft_description', 'marketplace_logo', 'current_usd_value', 'verified_collection')
    `);

    if (columnsCheck.rows.length > 0) {
      console.log('⚠️  Some NFT metadata columns already exist. Checking individual columns...');
    }

    const existingColumns = columnsCheck.rows.map(row => row.column_name);
    const columnsToAdd = [
      'collection_name TEXT',
      'collection_logo TEXT', 
      'nft_name TEXT',
      'nft_image TEXT',
      'nft_description TEXT',
      'marketplace_logo TEXT',
      'current_usd_value TEXT',
      'verified_collection BOOLEAN DEFAULT FALSE'
    ];

    const columnNames = [
      'collection_name',
      'collection_logo',
      'nft_name', 
      'nft_image',
      'nft_description',
      'marketplace_logo',
      'current_usd_value',
      'verified_collection'
    ];

    for (let i = 0; i < columnNames.length; i++) {
      const columnName = columnNames[i];
      const columnDef = columnsToAdd[i];

      if (!existingColumns.includes(columnName)) {
        console.log(`➕ Adding column: ${columnName}`);
        await pool.query(`ALTER TABLE processed_sales ADD COLUMN ${columnDef}`);
      } else {
        console.log(`✅ Column already exists: ${columnName}`);
      }
    }

    console.log('✅ Database migration completed successfully!');
    console.log('📝 Added NFT metadata columns:');
    console.log('   - collection_name, collection_logo');
    console.log('   - nft_name, nft_image, nft_description');
    console.log('   - marketplace_logo, current_usd_value');
    console.log('   - verified_collection');

  } catch (error) {
    console.error('❌ Migration failed:', error.message);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

// Run migration
migrateDatabase().catch(console.error);
