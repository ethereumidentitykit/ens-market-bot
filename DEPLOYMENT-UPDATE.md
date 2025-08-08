# Deployment Update Guide

Your local environment is working perfectly, but the Vercel deployment needs the new database schema with NFT metadata columns.

## 🔄 **Database Update Required**

The new features require additional database columns for NFT metadata:
- `collection_name`, `collection_logo`
- `nft_name`, `nft_image`, `nft_description`  
- `marketplace_logo`, `current_usd_value`
- `verified_collection`

## 📋 **Option 1: Fresh Database (Recommended)**

**Easiest approach for early development:**

1. **Delete your current PostgreSQL database** in your provider (Neon/Supabase/etc.)
2. **Create a new database**
3. **Update `POSTGRES_URL`** in Vercel environment variables
4. **Redeploy** - new schema will be created automatically

## 🔧 **Option 2: Migration Script**

**If you want to preserve existing data:**

1. **Run the migration script:**
   ```bash
   # Set your production database URL
   export POSTGRES_URL="your_production_postgres_url"
   
   # Run migration
   node scripts/migrate-database.js
   ```

2. **Redeploy to Vercel**

## ⚡ **Changes Made**

### 🎯 **Block Number Updated**
- **Minimum block changed from 22M → 23M**
- More recent sales only
- Better performance

### 🎨 **Tweet Format Enhanced**
- ✅ Shows actual NFT names (e.g., "269.eth")
- ✅ Buyer/seller ENS resolution (e.g., "dld.eth")
- ✅ No hashtags, no marketplace
- ✅ Clean "ENS Sale" format

### 📊 **Database Viewer Enhanced**
- ✅ NFT Name column
- ✅ Collection information
- ✅ All metadata displayed

## 🚀 **Deploy Steps**

1. **Choose database option above**
2. **Commit and push your changes:**
   ```bash
   git add .
   git commit -m "Enhanced tweet format with NFT names and buyer/seller resolution"
   git push
   ```
3. **Vercel will auto-deploy**
4. **Test the `/api/process-sales` endpoint**
5. **Check the admin dashboard**

## ✅ **Verification**

After deployment, test:
- `/api/stats` - should show NFT names
- `/api/twitter/send-test-tweet` - should show enhanced format
- Admin dashboard - should display NFT Name column

The system will now create beautiful tweets like:
```
ENS Sale

💰 10.0000 ETH ($39,486.84)
🏷️ 269.eth
👤 dld.eth ← 0x8faa...631c

🔗 https://etherscan.io/tx/0x...
```
