#!/usr/bin/env node

/**
 * VPS Database Migration for ENS Bids
 * Adds ens_name column to existing ens_bids table
 * Works with both PostgreSQL and SQLite
 */

async function migrateVPS() {
  console.log('🚀 VPS ENS Bids Database Migration\n');

  try {
    // Auto-detect database type based on environment
    const isPostgreSQL = process.env.DATABASE_URL && process.env.DATABASE_URL.startsWith('postgresql://');
    
    console.log(`📊 Database type: ${isPostgreSQL ? 'PostgreSQL' : 'SQLite'}`);
    console.log(`📊 Environment: ${process.env.NODE_ENV || 'development'}`);

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

    // Check if ens_bids table exists at all
    try {
      if (isPostgreSQL) {
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
      } else {
        const tableCheck = await db.db.get("SELECT name FROM sqlite_master WHERE type='table' AND name='ens_bids';");
        if (!tableCheck) {
          console.log('📝 ens_bids table does not exist - will be created by app initialization');
          await db.close();
          return;
        }
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
      if (isPostgreSQL) {
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
      } else {
        const columnCheck = await db.db.get("PRAGMA table_info(ens_bids)");
        const columns = await db.db.all("PRAGMA table_info(ens_bids)");
        const hasEnsName = columns.some(col => col.name === 'ens_name');
        
        if (hasEnsName) {
          console.log('✅ ens_name column already exists - no migration needed');
          await db.close();
          return;
        }
      }
      
      console.log('📝 ens_name column missing - proceeding with migration');
    } catch (error) {
      console.log('⚠️  Could not check column existence, proceeding with migration attempt');
    }

    // Add ens_name column
    console.log('🔄 Adding ens_name column...');
    
    try {
      if (isPostgreSQL) {
        await db.pool.query('ALTER TABLE ens_bids ADD COLUMN ens_name VARCHAR(255)');
      } else {
        await db.db.run('ALTER TABLE ens_bids ADD COLUMN ens_name TEXT');
      }
      
      console.log('✅ ens_name column added successfully');
    } catch (error) {
      if (error.message.includes('already exists') || error.message.includes('duplicate column')) {
        console.log('✅ ens_name column already exists (concurrent migration)');
      } else {
        throw error;
      }
    }

    // Verify migration success
    console.log('🔍 Verifying migration...');
    
    if (isPostgreSQL) {
      const verifyResult = await db.pool.query(`
        SELECT column_name 
        FROM information_schema.columns 
        WHERE table_name = 'ens_bids' AND column_name = 'ens_name'
      `);
      
      if (verifyResult.rows.length > 0) {
        console.log('✅ Migration verified - ens_name column is present');
      } else {
        throw new Error('Migration verification failed');
      }
    } else {
      const columns = await db.db.all("PRAGMA table_info(ens_bids)");
      const hasEnsName = columns.some(col => col.name === 'ens_name');
      
      if (hasEnsName) {
        console.log('✅ Migration verified - ens_name column is present');
      } else {
        throw new Error('Migration verification failed');
      }
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
