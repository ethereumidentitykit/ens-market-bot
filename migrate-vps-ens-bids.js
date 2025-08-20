#!/usr/bin/env node

/**
 * VPS Database Migration for ENS Bids
 * Adds ens_name column to existing ens_bids table
 * Works with both PostgreSQL and SQLite
 */

async function migrateVPS() {
  console.log('🚀 VPS ENS Bids Database Migration\n');

  try {
    // Debug environment variables
    console.log('🔍 Environment Debug:');
    console.log(`  NODE_ENV: ${process.env.NODE_ENV || 'not set'}`);
    console.log(`  DATABASE_URL: ${process.env.DATABASE_URL ? 'Set (' + process.env.DATABASE_URL.substring(0, 20) + '...)' : 'Not set'}`);
    
    // Force PostgreSQL detection
    const isPostgreSQL = process.env.DATABASE_URL && (
      process.env.DATABASE_URL.startsWith('postgresql://') || 
      process.env.DATABASE_URL.startsWith('postgres://')
    );
    
    console.log(`📊 Database type: ${isPostgreSQL ? 'PostgreSQL' : 'SQLite'}`);
    
    if (!isPostgreSQL) {
      console.log('❌ ERROR: PostgreSQL DATABASE_URL not detected!');
      console.log('💡 This script should only run on VPS with PostgreSQL');
      console.log('💡 Make sure DATABASE_URL environment variable is set');
      console.log('💡 Check: echo $DATABASE_URL');
      console.log('❌ Exiting to prevent SQLite creation');
      process.exit(1);
    }
    
    console.log('✅ PostgreSQL detected - proceeding with migration');

    // Use PostgreSQL service (script only runs if PostgreSQL detected)
    const { VercelDatabaseService } = require('./dist/services/vercelDatabaseService');
    const db = new VercelDatabaseService();

    await db.initialize();
    console.log('✅ Database connected');

    // Check if ens_bids table exists at all
    try {
      const tableCheck = await db.pool.query(`
        SELECT EXISTS (
          SELECT FROM information_schema.tables 
          WHERE table_schema = 'public' 
          AND table_name = 'ens_bids'
        );
      `);
      
      if (!tableCheck.rows[0].exists) {
        console.log('📝 ens_bids table does not exist - will be created by app initialization');
        await db.close();
        return;
      }
      
      console.log('✅ ens_bids table exists');
    } catch (error) {
      console.log('📝 Table check failed, assuming table needs creation by app');
      await db.close();
      return;
    }

    // Check if ens_name column exists
    console.log('🔍 Checking for ens_name column...');
    
    try {
      const columnCheck = await db.pool.query(`
        SELECT column_name 
        FROM information_schema.columns 
        WHERE table_name = 'ens_bids' AND column_name = 'ens_name'
      `);
      
      if (columnCheck.rows.length > 0) {
        console.log('✅ ens_name column already exists - no migration needed');
        await db.close();
        return;
      }
      
      console.log('📝 ens_name column missing - proceeding with migration');
    } catch (error) {
      console.log('⚠️  Could not check column existence, proceeding with migration attempt');
      console.log(`⚠️  Error: ${error.message}`);
    }

    // Add ens_name column
    console.log('🔄 Adding ens_name column...');
    
    try {
      await db.pool.query('ALTER TABLE ens_bids ADD COLUMN ens_name VARCHAR(255)');
      console.log('✅ ens_name column added successfully');
    } catch (error) {
      if (error.message.includes('already exists') || error.message.includes('duplicate column') || error.code === '42701') {
        console.log('✅ ens_name column already exists (concurrent migration)');
      } else {
        throw error;
      }
    }

    // Verify migration success
    console.log('🔍 Verifying migration...');
    
    const verifyResult = await db.pool.query(`
      SELECT column_name 
      FROM information_schema.columns 
      WHERE table_name = 'ens_bids' AND column_name = 'ens_name'
    `);
    
    if (verifyResult.rows.length > 0) {
      console.log('✅ Migration verified - ens_name column is present');
    } else {
      throw new Error('Migration verification failed - ens_name column not found after addition');
    }

    await db.close();

    console.log('\n🎉 VPS Migration Complete!');
    console.log('📊 Changes Applied:');
    console.log('  • Added ens_name VARCHAR(255) column to ens_bids table');
    console.log('  • Column will store resolved ENS names for performance');
    console.log('  • Existing bid data preserved');

    console.log('\n🚀 Next Steps:');
    console.log('  1. Restart your Node.js service (PM2/systemd)');
    console.log('  2. Check dashboard: http://your-vps-ip:3000');
    console.log('  3. Verify ENS Bids tab works');
    console.log('  4. Test Enhanced Tweet Generation with ✋ Bids');
    console.log('  5. Enable scheduler for automated processing');

  } catch (error) {
    console.error('❌ VPS migration failed:', error.message);
    console.error(error.stack);
    process.exit(1);
  }
}

migrateVPS();
