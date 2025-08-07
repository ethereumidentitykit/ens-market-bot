# Vercel Deployment Guide

## 📋 Prerequisites

1. **GitHub Repository**: Project already pushed to GitHub
2. **Vercel Account**: Sign up at [vercel.com](https://vercel.com) with GitHub
3. **Alchemy API Key**: Get from [alchemy.com](https://alchemy.com)

## 🗄️ Database Setup (PostgreSQL)

### Option 1: Vercel Postgres (Recommended)
1. Go to your Vercel project dashboard
2. Navigate to **Storage** tab
3. Click **Create Database** → **Postgres**
4. Choose a database name (e.g., `nft-sales-bot`)
5. Copy the connection strings provided

### Option 2: External PostgreSQL
- Use services like Railway, Supabase, or AWS RDS
- Get the connection string in format: `postgresql://user:password@host:port/database`

## 🚀 Vercel Deployment Steps

### Step 1: Import Project
1. Go to [vercel.com](https://vercel.com) and sign in with GitHub
2. Click **"New Project"**
3. Find and select your `twitterbot` repository
4. Click **"Import"**

### Step 2: Configure Build Settings
- **Framework Preset**: Other (should auto-detect)
- **Build Command**: `npm run vercel-build`
- **Output Directory**: `dist`
- **Install Command**: `npm install`
- **Node.js Version**: 18.x (default)

### Step 3: Environment Variables
Add these environment variables in Vercel project settings:

```
# Required - Alchemy API
ALCHEMY_API_KEY=your_actual_alchemy_api_key_here
ALCHEMY_BASE_URL=https://eth-mainnet.g.alchemy.com

# Required - Database
POSTGRES_URL=your_postgres_connection_string
DATABASE_URL=your_postgres_connection_string

# Required - Application
NODE_ENV=production
LOG_LEVEL=info
PORT=3000

# Required - Contract Monitoring
CONTRACT_ADDRESS_1=0xD4416b13d2b3a9aBae7AcD5D6C2BbDBE25686401
CONTRACT_ADDRESS_2=0x57f1887a8bf19b14fc0df6fd9b2acc9af147ea85

# Twitter API (add after OAuth setup)
TWITTER_API_KEY=your_twitter_api_key
TWITTER_API_SECRET=your_twitter_api_secret
TWITTER_ACCESS_TOKEN=your_twitter_access_token
TWITTER_ACCESS_TOKEN_SECRET=your_twitter_access_token_secret

# OAuth Callback
TWITTER_CALLBACK_URL=https://your-vercel-app.vercel.app/auth/twitter/callback
```

### Step 4: Deploy
1. Click **"Deploy"**
2. Wait for deployment to complete
3. Get your app URL: `https://your-app-name.vercel.app`

## 🐦 Twitter OAuth Setup

### Step 1: Configure Twitter App
1. Go to [developer.twitter.com](https://developer.twitter.com)
2. Navigate to your app (ID: 30234785)
3. Go to **"Settings"** tab
4. Enable **"OAuth 1.0a"** authentication
5. Set these URLs:
   - **Website URL**: `https://your-vercel-app.vercel.app`
   - **Callback URI**: `https://your-vercel-app.vercel.app/auth/twitter/callback`

### Step 2: Get API Keys
1. Go to **"Keys and tokens"** tab
2. Copy these 4 values:
   - **API Key** (Consumer Key)
   - **API Secret Key** (Consumer Secret)
   - **Access Token**
   - **Access Token Secret**
3. Add them to Vercel environment variables

## ✅ Testing Deployment

### Test Endpoints
After deployment, test these URLs:
- `https://your-app.vercel.app/` - Admin dashboard
- `https://your-app.vercel.app/health` - Health check
- `https://your-app.vercel.app/api/test-alchemy` - Alchemy connection
- `https://your-app.vercel.app/api/stats` - Database stats

### Expected Behavior
1. **Database**: PostgreSQL tables will be created automatically
2. **Scheduler**: May not work on Vercel serverless (we'll address this)
3. **Admin Dashboard**: Should load and show system stats
4. **API Endpoints**: Should respond with JSON data

## ⚠️ Known Limitations

### Scheduler Issue
Vercel serverless functions have execution time limits. The cron scheduler may not work as expected. Solutions:
1. Use Vercel Cron Jobs (beta feature)
2. Use external cron service (like GitHub Actions)
3. Manual processing only via admin dashboard

### Database Persistence
- ✅ PostgreSQL: Data persists between deployments
- ❌ SQLite: Would reset on each deployment (not used)

## 🔧 Troubleshooting

### Common Issues
1. **Build Fails**: Check TypeScript errors in build logs
2. **Database Connection**: Verify POSTGRES_URL is correct
3. **Environment Variables**: Ensure all required vars are set
4. **API Errors**: Check Alchemy API key is valid

### Logs
- View deployment logs in Vercel dashboard
- Check function logs for runtime errors
- Use `/health` endpoint to verify system status

## 📝 Next Steps After Deployment

1. ✅ Verify admin dashboard loads
2. ✅ Test Alchemy API connection  
3. ✅ Process some sales data
4. 🔄 Set up Twitter OAuth
5. 🔄 Implement Twitter posting features
6. 🔄 Address scheduler limitations

Your bot account **@BotMarket66066** will be ready to post once Twitter integration is complete!
