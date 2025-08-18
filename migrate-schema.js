#!/usr/bin/env node

/**
 * Schema Migration Script
 * 
 * This script will trigger the database schema migration to fix the 
 * duplicate sales bug by changing the unique constraint from 
 * transaction_hash to token_id.
 * 
 * Usage: node migrate-schema.js
 */

const fetch = require('node-fetch');

async function migrateSchema() {
  try {
    console.log('🔄 Starting database schema migration...');
    console.log('⚠️  This will DROP and RECREATE all tables with the new schema');
    console.log('⚠️  All existing data will be lost!');
    console.log('');
    
    const response = await fetch('http://localhost:3000/api/database/migrate-schema', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      }
    });
    
    const result = await response.json();
    
    if (result.success) {
      console.log('✅ Schema migration completed successfully!');
      console.log('📝 Message:', result.message);
      console.log('');
      console.log('🎯 The database now has the correct schema:');
      console.log('   - token_id is now UNIQUE (instead of transaction_hash)');
      console.log('   - Multiple ENS domains in same transaction will now be stored');
      console.log('   - No more SQLITE_CONSTRAINT errors');
      console.log('');
      console.log('💡 Next steps:');
      console.log('   1. Process some sales to test the fix');
      console.log('   2. Look for transactions with multiple domains');
      console.log('   3. Verify no more constraint errors in logs');
    } else {
      console.error('❌ Schema migration failed:', result.error);
      process.exit(1);
    }
    
  } catch (error) {
    console.error('❌ Error during schema migration:', error.message);
    process.exit(1);
  }
}

// Check if server is running
async function checkServer() {
  try {
    const response = await fetch('http://localhost:3000/health');
    if (!response.ok) {
      throw new Error('Health check failed');
    }
    console.log('✅ Server is running');
    return true;
  } catch (error) {
    console.error('❌ Server is not running or not accessible');
    console.error('   Make sure your ENS bot is running on port 3000');
    console.error('   Then run this script again.');
    process.exit(1);
  }
}

async function main() {
  console.log('🛠️  ENS Sales Bot - Database Schema Migration');
  console.log('===========================================');
  console.log('');
  
  await checkServer();
  await migrateSchema();
}

main();
