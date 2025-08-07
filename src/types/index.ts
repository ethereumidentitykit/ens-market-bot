// NFT Sales API Response Types
export interface NFTSale {
  marketplace: string;
  contractAddress: string;
  tokenId: string;
  quantity: string;
  buyerAddress: string;
  sellerAddress: string;
  taker: 'BUYER' | 'SELLER';
  sellerFee: {
    amount: string;
    symbol: string;
    decimals: number;
  };
  protocolFee: {
    amount: string;
    symbol: string;
    decimals: number;
  };
  royaltyFee: {
    amount: string;
    symbol: string;
    decimals: number;
  };
  blockNumber: number;
  logIndex: number;
  bundleIndex: number;
  transactionHash: string;
}

export interface AlchemyNFTSalesResponse {
  nftSales: NFTSale[];
  pageKey?: string;
  validAt: {
    blockNumber: number;
    blockHash: string;
    blockTimestamp: string;
  };
}

// Database Models
export interface ProcessedSale {
  id?: number;
  transactionHash: string;
  contractAddress: string;
  tokenId: string;
  marketplace: string;
  buyerAddress: string;
  sellerAddress: string;
  priceEth: string;
  priceUsd?: string;
  blockNumber: number;
  blockTimestamp: string;
  processedAt: string;
  tweetId?: string;
  posted: boolean;
}

// Configuration
export interface Config {
  alchemy: {
    apiKey: string;
    baseUrl: string;
  };
  twitter: {
    apiKey: string;
    apiSecret: string;
    accessToken: string;
    accessTokenSecret: string;
  };
  database: {
    path: string;
  };
  contracts: string[];
  port: number;
  nodeEnv: string;
  logLevel: string;
}

// Database Interface
export interface IDatabaseService {
  initialize(): Promise<void>;
  insertSale(sale: Omit<ProcessedSale, 'id'>): Promise<number>;
  isSaleProcessed(transactionHash: string): Promise<boolean>;
  getRecentSales(limit?: number): Promise<ProcessedSale[]>;
  getUnpostedSales(limit?: number): Promise<ProcessedSale[]>;
  markAsPosted(id: number, tweetId: string): Promise<void>;
  getSystemState(key: string): Promise<string | null>;
  setSystemState(key: string, value: string): Promise<void>;
  getStats(): Promise<{
    totalSales: number;
    postedSales: number;
    unpostedSales: number;
    lastProcessedBlock: string | null;
  }>;
  close(): Promise<void>;
}

// API Response Types
export interface ApiResponse<T = any> {
  success: boolean;
  data?: T;
  error?: string;
  message?: string;
}
