import dotenv from 'dotenv';
import crypto from 'crypto';
import { Config } from '../types';
import { CONTRACT_ADDRESSES } from '../config/contracts';

// Load environment variables
dotenv.config();

export const config: Config = {
  alchemy: {
    apiKey: process.env.ALCHEMY_API_KEY || '',
    baseUrl: process.env.ALCHEMY_BASE_URL || 'https://eth-mainnet.g.alchemy.com',
  },
  bitquery: process.env.BITQUERY_TOKEN ? {
    token: process.env.BITQUERY_TOKEN,
    baseUrl: process.env.BITQUERY_BASE_URL || 'https://streaming.bitquery.io/graphql',
  } : undefined,
  twitter: {
    apiKey: process.env.TWITTER_API_KEY || '',
    apiSecret: process.env.TWITTER_API_SECRET || '',
    accessToken: process.env.TWITTER_ACCESS_TOKEN || '',
    accessTokenSecret: process.env.TWITTER_ACCESS_TOKEN_SECRET || '',
  },

  contracts: CONTRACT_ADDRESSES,
  port: parseInt(process.env.PORT || '3000', 10),
  nodeEnv: process.env.NODE_ENV || 'development',
  logLevel: process.env.LOG_LEVEL || 'info',
  wethPriceMultiplier: parseFloat(process.env.WETH_PRICE_MULTIPLIER || '1.0'),
  siwe: {
    adminWhitelist: process.env.ADMIN_WHITELIST?.split(',').map(addr => addr.toLowerCase().trim()) || [],
    sessionSecret: process.env.SESSION_SECRET || (() => {
      if (process.env.NODE_ENV === 'production') {
        throw new Error('SESSION_SECRET must be set in production environment');
      }
      // Generate random secret for development only
      const devSecret = crypto.randomBytes(32).toString('hex');
      console.warn('⚠️  Using generated session secret for development. Set SESSION_SECRET in production!');
      return devSecret;
    })(),
    domain: process.env.SIWE_DOMAIN || 'localhost'
  },
  quicknode: {
    salesWebhookSecret: process.env.QUICKNODE_SECRET_SALES || '',
    registrationsWebhookSecret: process.env.QUICKNODE_SECRET_REGISTRATIONS || ''
  },
  opensea: process.env.OPENSEA_API_KEY ? {
    apiKey: process.env.OPENSEA_API_KEY,
  } : undefined,
  ensSubgraph: {
    primaryUrl: process.env.ENS_SUBGRAPH_URL || 'https://ensnode-api-production-500f.up.railway.app/subgraph',
  }
};

// Validate required configuration
export function validateConfig(): void {
  const required = ['SESSION_SECRET'];
  const missing = required.filter((key) => !process.env[key]);
  
  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }

  // Validate admin whitelist
  if (!process.env.ADMIN_WHITELIST) {
    console.warn('⚠️  No ADMIN_WHITELIST set - no addresses will be able to access admin dashboard');
  } else {
    const addresses = process.env.ADMIN_WHITELIST.split(',');
    console.log(`🔐 SIWE admin whitelist configured with ${addresses.length} address(es)`);
  }
  
  // Validate QuickNode webhook secrets
  if (!process.env.QUICKNODE_SECRET_SALES) {
    console.warn('⚠️  No QUICKNODE_SECRET_SALES set - sales webhook signature verification will be disabled');
  } else {
    console.log('🔐 QuickNode sales webhook secret configured for signature verification');
  }
  
  if (!process.env.QUICKNODE_SECRET_REGISTRATIONS) {
    console.warn('⚠️  No QUICKNODE_SECRET_REGISTRATIONS set - registrations webhook signature verification will be disabled');
  } else {
    console.log('🔐 QuickNode registrations webhook secret configured for signature verification');
  }
}
