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
  twitter: {
    apiKey: process.env.TWITTER_API_KEY || '',
    apiSecret: process.env.TWITTER_API_SECRET || '',
    accessToken: process.env.TWITTER_ACCESS_TOKEN || '',
    accessTokenSecret: process.env.TWITTER_ACCESS_TOKEN_SECRET || '',
  },
  database: {
    path: process.env.DATABASE_PATH || './data/sales.db',
  },
  contracts: CONTRACT_ADDRESSES,
  port: parseInt(process.env.PORT || '3000', 10),
  nodeEnv: process.env.NODE_ENV || 'development',
  logLevel: process.env.LOG_LEVEL || 'info',
};

// Validate required configuration
export function validateConfig(): void {
  const required = ['ALCHEMY_API_KEY'];
  const missing = required.filter((key) => !process.env[key]);
  
  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }
}
