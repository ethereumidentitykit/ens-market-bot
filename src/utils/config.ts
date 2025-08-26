import dotenv from 'dotenv';
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
  moralis: process.env.MORALIS_API_KEY ? {
    apiKey: process.env.MORALIS_API_KEY,
    baseUrl: process.env.MORALIS_BASE_URL || 'https://deep-index.moralis.io/api/v2.2',
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
    sessionSecret: process.env.SESSION_SECRET || 'fallback-secret-change-in-production',
    domain: process.env.SIWE_DOMAIN || 'localhost:3000'
  }
};

// Validate required configuration
export function validateConfig(): void {
  const required = ['MORALIS_API_KEY', 'SESSION_SECRET'];
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
}
