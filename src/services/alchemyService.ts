import axios, { AxiosResponse } from 'axios';
import { config } from '../utils/config';
import { logger } from '../utils/logger';
import { AlchemyNFTSalesResponse, NFTSale, AlchemyPriceResponse } from '../types';
import { DatabaseService } from './databaseService';

// Supported networks for token balances and prices
const SUPPORTED_NETWORKS = [
  'eth-mainnet',
  'base-mainnet',
  'opt-mainnet',
  'arb-mainnet',
  'zksync-mainnet',
  'polygon-mainnet',
  'linea-mainnet'
] as const;

export type AlchemyNetwork = typeof SUPPORTED_NETWORKS[number];

// Whitelisted tokens to track (major stablecoins, WETH, etc.)
const WHITELISTED_TOKENS: Record<string, string[]> = {
  'eth-mainnet': [
    '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2', // WETH
    '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', // USDC
    '0xdac17f958d2ee523a2206206994597c13d831ec7', // USDT
    '0x6b175474e89094c44da98b954eedeac495271d0f', // DAI
    '0x2260fac5e5542a773aa44fbcfedf7c193bc2c599', // WBTC
    '0x7f39c581f595b53c5cb19bd0b3f8da6c935e2ca0', // wstETH
    '0x5a98fcbea516cf06857215779fd812ca3bef1b32', // LDO
    '0x514910771af9ca656af840dff83e8264ecf986ca', // LINK
    '0x1f9840a85d5af5bf1d1762f925bdaddc4201f984', // UNI
    '0x7fc66500c84a76ad7e9c93437bfc5ac33e2ddae9', // AAVE
    '0x9f8f72aa9304c8b593d555f12ef6589cc3a579a2', // MKR
    '0xc011a73ee8576fb46f5e1c5751ca3b9fe0af2a6f', // SNX
    '0xd533a949740bb3306d119cc777fa900ba034cd52', // CRV
    '0xc00e94cb662c3520282e6f5717214004a7f26888', // COMP
    '0xba100000625a3754423978a60c9317c58a424e3d', // BAL
    '0x5f98805a4e8be255a32880fdec7f6728c6568ba0', // LUSD
    '0x7d1afa7b718fb893db30a3abc0cfc608aacfebb0', // MATIC
    '0x111111111117dc0aa78b770fa6a738034120c302', // 1INCH
    '0xc18360217d8f7ab5e7c516566761ea12ce7f9d72', // ENS
    '0x40d16fc0246ad3160ccc09b8d0d3a2cd28ae6c2f'  // GHO
  ],
  'base-mainnet': [
    '0x4200000000000000000000000000000000000006', // WETH
    '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', // USDC
    '0xfde4c96c8593536e31f229ea8f37b2ada2699bb2', // USDT
    '0x50c5725949a6f0c72e6c4a641f24049a917db0cb', // DAI
    '0x0555e30da8f98308edb960aa94c0db47230d2b9c', // WBTC
    '0xc1cba3fcea344f92d9239c08c0568f6f2f0ee452', // wstETH
    '0xe432cec96a5948189ae00b93ce28d83027e4d151', // LDO
    '0x453884bbdd48a2ca281f10557bdb90bb4593a73d', // MKR
    '0x22e6966b799c4d5b13be962e1d117b56327fda66'  // SNX
  ],
  'opt-mainnet': [
    '0x4200000000000000000000000000000000000006', // WETH
    '0x0b2c639c533813f4aa9d7837caf62653d097ff85', // USDC
    '0x94b008aa00579c1307b0ef2c499ad98a8ce58e58', // USDT
    '0xda10009cbd5d07dd0cecc66161fc93d7c9000da1', // DAI
    '0x68f180fcce6836688e9084f035309e29bf0a2095', // WBTC
    '0x1f32b1c2345538c0c6f582fcb022739c4a194ebb', // wstETH
    '0xfdb794692724153d1488ccdb0c56c252596735f', // LDO
    '0x350a791bfc2c21f9ed5d10980dad2e2638ffa7f6', // LINK
    '0x4200000000000000000000000000000000000042', // OP
    '0xab7badef82e9fe11f6f33f87bc9bc2aa27f2fcb5', // MKR
    '0x8700daec35af8ff88c16bdf0418774cb3d7599b4', // SNX
    '0x0994206dfe8de6ec6920ff4d779b0d950605fb53', // CRV
    '0xfe8b128ba8c78aabc59d4c64cee7ff28e9379921', // BAL
    '0xc40f949f8a4e094d1b49a23ea9241d289b7b2819', // LUSD
    '0x111111111117dc0aa78b770fa6a738034120c302'  // 1INCH
  ],
  'arb-mainnet': [
    '0x82af49447d8a07e3bd95bd0d56f35241523fbab1', // WETH
    '0xaf88d065e77c8ccc2239327c5edb3a432268e5831', // USDC (note: this looks wrong in CSV, using as provided)
    '0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9', // USDT
    '0xda10009cbd5d07dd0cecc66161fc93d7c9000da1', // DAI
    '0x2f2a2543b76a4166549f7aab2e75bef0aefc5b0f', // WBTC
    '0x5979d7b546e38e414f7e9822514be443a4800529', // wstETH
    '0x13ad51ed4f1b7e9dc168d8a00cb3f4ddd85efa60', // LDO
    '0xfa7f8980b0f1e64a2062791cc3b0871572f1f7f0', // UNI
    '0xba5ddd1f9d7f570dc94a51479a000e3bce967196', // AAVE
    '0x912ce59144191c1204e64559fe8253a0e49e6548', // ARB
    '0x11cdb42b0eb46d95f990bedd4695a6e3fa034978', // CRV
    '0x354a6da3fcde098f8389cad84b0182725c6c91dc', // COMP
    '0x040d1edc9569d4bab2d15287dc5a4f10f56a56b8', // BAL
    '0x93b346b6bc2548da6a1e7d98e9a4217652b29aea', // LUSD
    '0x111111111117dc0aa78b770fa6a738034120c302'  // 1INCH
  ],
  'zksync-mainnet': [
    '0x5aea5775959fbc2557cc8789bc1bf90a239d9a91', // WETH
    '0x3355df6d4c9c3035724fd0e3914de96a5a83aaf4', // USDC
    '0x493257fd37edb34451f62edf8d2a0c418852ba4c', // USDT
    '0x4b9eb6c0b6ea15176bbf62841c6b2a8a398cb656'  // DAI
  ],
  'polygon-mainnet': [
    '0x7ceb23fd6bc0add59e62ac25578270cff1b9f619', // WETH
    '0x2791bca1f2de4661ed88a30c99a7a9449aa84174', // USDC
    '0xc2132d05d31c914a87c6611c10748aeb04b58e8f', // USDT
    '0x8f3cf7ad23cd3cadbd9735aff958023239c6a063', // DAI
    '0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6', // WBTC
    '0x1a1b87e058b8d9add50c8a1ede80376fde1e2e13', // wstETH
    '0xc3c7d422809852031b44ab29eec9f1eff2a58756', // LDO
    '0x6f7c932e7684666c9fd1d44527765433e01ff61d', // MKR
    '0x50b728d8d964fd00c2d0aad81718b71311fef68a', // SNX
    '0x172370d5cd63279efa6d502dab29171933a610af', // CRV
    '0x8505b9d2254ad4deb0916dd7d59ade791f0e25b4', // COMP
    '0x9a71012b13ca4d3d0cdc72a177df3ef03b0e76a3', // BAL
    '0x0000000000000000000000000000000000001010', // MATIC
    '0x111111111117dc0aa78b770fa6a738034120c302'  // 1INCH
  ],
  'linea-mainnet': [
    '0xe5d7c2a44ffddf6b295a15c148167daaaf5cf34f', // WETH
    '0x176211869ca2b568f2a7d4ee941e073a821ee1ff', // USDC
    '0xa219439258ca9da29e9cc4ce5596924745e12b93', // USDT
    '0x4af15ec2a0bd43db75dd04e62faa3b8ef36b00d5', // DAI
    '0x3aab2285ddcddad8edf438c1bab47e1a9d05a9b4', // WBTC
    '0x2442bd7ae83b51f6664de408a385375fe4a84f52'  // MKR
  ]
};

// Token metadata for known tokens (symbol, decimals)
const TOKEN_METADATA: Record<string, { symbol: string; decimals: number }> = {
  // Ethereum Mainnet
  'eth-mainnet:0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2': { symbol: 'WETH', decimals: 18 },
  'eth-mainnet:0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48': { symbol: 'USDC', decimals: 6 },
  'eth-mainnet:0xdac17f958d2ee523a2206206994597c13d831ec7': { symbol: 'USDT', decimals: 6 },
  'eth-mainnet:0x6b175474e89094c44da98b954eedeac495271d0f': { symbol: 'DAI', decimals: 18 },
  'eth-mainnet:0x2260fac5e5542a773aa44fbcfedf7c193bc2c599': { symbol: 'WBTC', decimals: 8 },
  'eth-mainnet:0x7f39c581f595b53c5cb19bd0b3f8da6c935e2ca0': { symbol: 'wstETH', decimals: 18 },
  'eth-mainnet:0x5a98fcbea516cf06857215779fd812ca3bef1b32': { symbol: 'LDO', decimals: 18 },
  'eth-mainnet:0x514910771af9ca656af840dff83e8264ecf986ca': { symbol: 'LINK', decimals: 18 },
  'eth-mainnet:0x1f9840a85d5af5bf1d1762f925bdaddc4201f984': { symbol: 'UNI', decimals: 18 },
  'eth-mainnet:0x7fc66500c84a76ad7e9c93437bfc5ac33e2ddae9': { symbol: 'AAVE', decimals: 18 },
  'eth-mainnet:0x9f8f72aa9304c8b593d555f12ef6589cc3a579a2': { symbol: 'MKR', decimals: 18 },
  'eth-mainnet:0xc011a73ee8576fb46f5e1c5751ca3b9fe0af2a6f': { symbol: 'SNX', decimals: 18 },
  'eth-mainnet:0xd533a949740bb3306d119cc777fa900ba034cd52': { symbol: 'CRV', decimals: 18 },
  'eth-mainnet:0xc00e94cb662c3520282e6f5717214004a7f26888': { symbol: 'COMP', decimals: 18 },
  'eth-mainnet:0xba100000625a3754423978a60c9317c58a424e3d': { symbol: 'BAL', decimals: 18 },
  'eth-mainnet:0x5f98805a4e8be255a32880fdec7f6728c6568ba0': { symbol: 'LUSD', decimals: 18 },
  'eth-mainnet:0x7d1afa7b718fb893db30a3abc0cfc608aacfebb0': { symbol: 'MATIC', decimals: 18 },
  'eth-mainnet:0x111111111117dc0aa78b770fa6a738034120c302': { symbol: '1INCH', decimals: 18 },
  'eth-mainnet:0xc18360217d8f7ab5e7c516566761ea12ce7f9d72': { symbol: 'ENS', decimals: 18 },
  'eth-mainnet:0x40d16fc0246ad3160ccc09b8d0d3a2cd28ae6c2f': { symbol: 'GHO', decimals: 18 },
  
  // Base
  'base-mainnet:0x4200000000000000000000000000000000000006': { symbol: 'WETH', decimals: 18 },
  'base-mainnet:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913': { symbol: 'USDC', decimals: 6 },
  'base-mainnet:0xfde4c96c8593536e31f229ea8f37b2ada2699bb2': { symbol: 'USDT', decimals: 6 },
  'base-mainnet:0x50c5725949a6f0c72e6c4a641f24049a917db0cb': { symbol: 'DAI', decimals: 18 },
  'base-mainnet:0x0555e30da8f98308edb960aa94c0db47230d2b9c': { symbol: 'WBTC', decimals: 8 },
  'base-mainnet:0xc1cba3fcea344f92d9239c08c0568f6f2f0ee452': { symbol: 'wstETH', decimals: 18 },
  'base-mainnet:0xe432cec96a5948189ae00b93ce28d83027e4d151': { symbol: 'LDO', decimals: 18 },
  'base-mainnet:0x453884bbdd48a2ca281f10557bdb90bb4593a73d': { symbol: 'MKR', decimals: 18 },
  'base-mainnet:0x22e6966b799c4d5b13be962e1d117b56327fda66': { symbol: 'SNX', decimals: 18 },
  
  // Optimism
  'opt-mainnet:0x4200000000000000000000000000000000000006': { symbol: 'WETH', decimals: 18 },
  'opt-mainnet:0x0b2c639c533813f4aa9d7837caf62653d097ff85': { symbol: 'USDC', decimals: 6 },
  'opt-mainnet:0x94b008aa00579c1307b0ef2c499ad98a8ce58e58': { symbol: 'USDT', decimals: 6 },
  'opt-mainnet:0xda10009cbd5d07dd0cecc66161fc93d7c9000da1': { symbol: 'DAI', decimals: 18 },
  'opt-mainnet:0x68f180fcce6836688e9084f035309e29bf0a2095': { symbol: 'WBTC', decimals: 8 },
  'opt-mainnet:0x1f32b1c2345538c0c6f582fcb022739c4a194ebb': { symbol: 'wstETH', decimals: 18 },
  'opt-mainnet:0xfdb794692724153d1488ccdb0c56c252596735f': { symbol: 'LDO', decimals: 18 },
  'opt-mainnet:0x350a791bfc2c21f9ed5d10980dad2e2638ffa7f6': { symbol: 'LINK', decimals: 18 },
  'opt-mainnet:0x4200000000000000000000000000000000000042': { symbol: 'OP', decimals: 18 },
  'opt-mainnet:0xab7badef82e9fe11f6f33f87bc9bc2aa27f2fcb5': { symbol: 'MKR', decimals: 18 },
  'opt-mainnet:0x8700daec35af8ff88c16bdf0418774cb3d7599b4': { symbol: 'SNX', decimals: 18 },
  'opt-mainnet:0x0994206dfe8de6ec6920ff4d779b0d950605fb53': { symbol: 'CRV', decimals: 18 },
  'opt-mainnet:0xfe8b128ba8c78aabc59d4c64cee7ff28e9379921': { symbol: 'BAL', decimals: 18 },
  'opt-mainnet:0xc40f949f8a4e094d1b49a23ea9241d289b7b2819': { symbol: 'LUSD', decimals: 18 },
  'opt-mainnet:0x111111111117dc0aa78b770fa6a738034120c302': { symbol: '1INCH', decimals: 18 },
  
  // Arbitrum
  'arb-mainnet:0x82af49447d8a07e3bd95bd0d56f35241523fbab1': { symbol: 'WETH', decimals: 18 },
  'arb-mainnet:0xaf88d065e77c8ccc2239327c5edb3a432268e5831': { symbol: 'USDC', decimals: 6 },
  'arb-mainnet:0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9': { symbol: 'USDT', decimals: 6 },
  'arb-mainnet:0xda10009cbd5d07dd0cecc66161fc93d7c9000da1': { symbol: 'DAI', decimals: 18 },
  'arb-mainnet:0x2f2a2543b76a4166549f7aab2e75bef0aefc5b0f': { symbol: 'WBTC', decimals: 8 },
  'arb-mainnet:0x5979d7b546e38e414f7e9822514be443a4800529': { symbol: 'wstETH', decimals: 18 },
  'arb-mainnet:0x13ad51ed4f1b7e9dc168d8a00cb3f4ddd85efa60': { symbol: 'LDO', decimals: 18 },
  'arb-mainnet:0xfa7f8980b0f1e64a2062791cc3b0871572f1f7f0': { symbol: 'UNI', decimals: 18 },
  'arb-mainnet:0xba5ddd1f9d7f570dc94a51479a000e3bce967196': { symbol: 'AAVE', decimals: 18 },
  'arb-mainnet:0x912ce59144191c1204e64559fe8253a0e49e6548': { symbol: 'ARB', decimals: 18 },
  'arb-mainnet:0x11cdb42b0eb46d95f990bedd4695a6e3fa034978': { symbol: 'CRV', decimals: 18 },
  'arb-mainnet:0x354a6da3fcde098f8389cad84b0182725c6c91dc': { symbol: 'COMP', decimals: 18 },
  'arb-mainnet:0x040d1edc9569d4bab2d15287dc5a4f10f56a56b8': { symbol: 'BAL', decimals: 18 },
  'arb-mainnet:0x93b346b6bc2548da6a1e7d98e9a4217652b29aea': { symbol: 'LUSD', decimals: 18 },
  'arb-mainnet:0x111111111117dc0aa78b770fa6a738034120c302': { symbol: '1INCH', decimals: 18 },
  
  // zkSync
  'zksync-mainnet:0x5aea5775959fbc2557cc8789bc1bf90a239d9a91': { symbol: 'WETH', decimals: 18 },
  'zksync-mainnet:0x3355df6d4c9c3035724fd0e3914de96a5a83aaf4': { symbol: 'USDC', decimals: 6 },
  'zksync-mainnet:0x493257fd37edb34451f62edf8d2a0c418852ba4c': { symbol: 'USDT', decimals: 6 },
  'zksync-mainnet:0x4b9eb6c0b6ea15176bbf62841c6b2a8a398cb656': { symbol: 'DAI', decimals: 18 },
  
  // Polygon
  'polygon-mainnet:0x7ceb23fd6bc0add59e62ac25578270cff1b9f619': { symbol: 'WETH', decimals: 18 },
  'polygon-mainnet:0x2791bca1f2de4661ed88a30c99a7a9449aa84174': { symbol: 'USDC', decimals: 6 },
  'polygon-mainnet:0xc2132d05d31c914a87c6611c10748aeb04b58e8f': { symbol: 'USDT', decimals: 6 },
  'polygon-mainnet:0x8f3cf7ad23cd3cadbd9735aff958023239c6a063': { symbol: 'DAI', decimals: 18 },
  'polygon-mainnet:0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6': { symbol: 'WBTC', decimals: 8 },
  'polygon-mainnet:0x1a1b87e058b8d9add50c8a1ede80376fde1e2e13': { symbol: 'wstETH', decimals: 18 },
  'polygon-mainnet:0xc3c7d422809852031b44ab29eec9f1eff2a58756': { symbol: 'LDO', decimals: 18 },
  'polygon-mainnet:0x6f7c932e7684666c9fd1d44527765433e01ff61d': { symbol: 'MKR', decimals: 18 },
  'polygon-mainnet:0x50b728d8d964fd00c2d0aad81718b71311fef68a': { symbol: 'SNX', decimals: 18 },
  'polygon-mainnet:0x172370d5cd63279efa6d502dab29171933a610af': { symbol: 'CRV', decimals: 18 },
  'polygon-mainnet:0x8505b9d2254ad4deb0916dd7d59ade791f0e25b4': { symbol: 'COMP', decimals: 18 },
  'polygon-mainnet:0x9a71012b13ca4d3d0cdc72a177df3ef03b0e76a3': { symbol: 'BAL', decimals: 18 },
  'polygon-mainnet:0x0000000000000000000000000000000000001010': { symbol: 'MATIC', decimals: 18 },
  'polygon-mainnet:0x111111111117dc0aa78b770fa6a738034120c302': { symbol: '1INCH', decimals: 18 },
  
  // Linea
  'linea-mainnet:0xe5d7c2a44ffddf6b295a15c148167daaaf5cf34f': { symbol: 'WETH', decimals: 18 },
  'linea-mainnet:0x176211869ca2b568f2a7d4ee941e073a821ee1ff': { symbol: 'USDC', decimals: 6 },
  'linea-mainnet:0xa219439258ca9da29e9cc4ce5596924745e12b93': { symbol: 'USDT', decimals: 6 },
  'linea-mainnet:0x4af15ec2a0bd43db75dd04e62faa3b8ef36b00d5': { symbol: 'DAI', decimals: 18 },
  'linea-mainnet:0x3aab2285ddcddad8edf438c1bab47e1a9d05a9b4': { symbol: 'WBTC', decimals: 8 },
  'linea-mainnet:0x2442bd7ae83b51f6664de408a385375fe4a84f52': { symbol: 'MKR', decimals: 18 }
};

// Token balance response from Alchemy
interface AlchemyTokenBalanceResponse {
  data: {
    tokens: Array<{
      address: string;
      network: string;
      tokenAddress: string | null; // null for native tokens (ETH)
      tokenBalance: string; // Hex string
    }>;
  };
}

// Token price response from Alchemy
interface AlchemyTokenPriceResponse {
  data: Array<{
    network: string;
    address: string;
    prices: Array<{
      currency: string;
      value: string;
      lastUpdatedAt: string;
    }>;
    error?: {
      message: string;
    };
  }>;
}

// Parsed token balance
export interface TokenBalance {
  network: string;
  tokenAddress: string | null; // null for native token
  balance: string; // Decimal string (converted from hex)
  balanceRaw: string; // Original hex string
  symbol?: string;
  decimals?: number;
}

// Parsed token price
export interface TokenPrice {
  network: string;
  tokenAddress: string | null;
  symbol?: string;
  decimals?: number;
  priceUsd: number;
  lastUpdatedAt: Date;
  source: 'cache' | 'api';
}

// Wallet portfolio summary
export interface WalletPortfolio {
  address: string;
  totalValueUsd: number;
  
  nativeTokens: Array<{
    network: string;
    symbol: string; // 'ETH'
    balance: number;
    valueUsd: number;
  }>;
  
  erc20Tokens: Array<{
    network: string;
    tokenAddress: string;
    symbol: string;
    balance: number;
    valueUsd: number;
  }>;
  
  topHoldings: Array<{
    symbol: string;
    totalValueUsd: number;
    networks: string[];
  }>;
  
  networksAnalyzed: string[];
  tokensWithoutPrices: number;
  incomplete: boolean;
}

export class AlchemyService {
  private baseUrl: string;
  private apiKey: string;
  private databaseService: DatabaseService;

  // ETH price cache (30-minute in-memory cache to avoid API abuse)
  private ethPriceCache: { price: number; timestamp: number } | null = null;
  private readonly CACHE_DURATION = 30 * 60 * 1000; // 30 minutes in milliseconds

  constructor(databaseService: DatabaseService) {
    this.baseUrl = config.alchemy.baseUrl;
    this.apiKey = config.alchemy.apiKey;
    this.databaseService = databaseService;
  }

  /**
   * Fetch NFT sales for a specific contract address with pagination support
   * @param contractAddress - The contract address to fetch sales for
   * @param fromBlock - Starting block number (optional)
   * @param toBlock - Ending block number (optional)
   * @param limit - Maximum number of results (default: 1000)
   * @param pageKey - Pagination key for next page (optional)
   */
  async getNFTSales(
    contractAddress: string,
    fromBlock?: string,
    toBlock?: string,
          limit: number = 1000,
    pageKey?: string
  ): Promise<AlchemyNFTSalesResponse | null> {
    try {
      const url = `${this.baseUrl}/nft/v3/${this.apiKey}/getNFTSales`;
      
      const params: any = {
        contractAddress,
        limit
        // Note: Alchemy API doesn't support 'order' parameter, sales are returned in natural order
      };

      if (fromBlock) {
        params.fromBlock = fromBlock;
      }
      
      if (toBlock) {
        params.toBlock = toBlock;
      }

      if (pageKey) {
        params.pageKey = pageKey;
      }

      logger.debug(`Fetching NFT sales for contract ${contractAddress}`, params);

      const response: AxiosResponse<AlchemyNFTSalesResponse> = await axios.get(url, {
        params,
        timeout: 30000, // 30 second timeout
      });

      logger.info(`Successfully fetched ${response.data.nftSales.length} sales for contract ${contractAddress}`);
      return response.data;

    } catch (error: any) {
      logger.error(`[Alchemy API] Failed to fetch NFT sales for contract ${contractAddress}:`, error.message);
      
      if (error.response) {
        logger.error('[Alchemy API] Response error:', {
          status: error.response.status,
          data: error.response.data
        });
      }
      
      return null;
    }
  }

  /**
   * Fetch all NFT sales for a contract with automatic pagination
   * @param contractAddress - The contract address to fetch sales for
   * @param fromBlock - Starting block number (optional)
   * @param maxResults - Maximum total results to fetch (default: 5000)
   */
  async getAllSalesForContract(
    contractAddress: string,
    fromBlock?: string,
    maxResults: number = 5000
  ): Promise<NFTSale[]> {
    const allSales: NFTSale[] = [];
    let pageKey: string | undefined;
    let totalFetched = 0;

    try {
      logger.info(`Fetching all sales for contract ${contractAddress} with pagination`);

      do {
        const batchSize = Math.min(1000, maxResults - totalFetched);
        const response = await this.getNFTSales(contractAddress, fromBlock, 'latest', batchSize, pageKey);
        
        if (!response || response.nftSales.length === 0) {
          break;
        }

        allSales.push(...response.nftSales);
        totalFetched += response.nftSales.length;
        pageKey = response.pageKey;

        logger.info(`Fetched ${response.nftSales.length} sales (total: ${totalFetched}) for contract ${contractAddress}`);

        // Safety check to prevent infinite loops
        if (totalFetched >= maxResults) {
          logger.info(`Reached maximum results limit (${maxResults}) for contract ${contractAddress}`);
          break;
        }

      } while (pageKey && totalFetched < maxResults);

      logger.info(`Completed fetching ${totalFetched} sales for contract ${contractAddress}`);
      return allSales;

    } catch (error: any) {
      logger.error(`[Alchemy API] Failed to fetch paginated sales for contract ${contractAddress}:`, error.message);
      return allSales; // Return what we have so far
    }
  }

  /**
   * Fetch recent NFT sales for all configured contract addresses
   * @param fromBlock - Starting block number (optional)
   * @param limit - Maximum number of results per contract (increased default)
   */
  async getAllRecentSales(fromBlock?: string, limit: number = 1000): Promise<NFTSale[]> {
    const allSales: NFTSale[] = [];

    for (const contractAddress of config.contracts) {
      logger.info(`Fetching recent sales for contract: ${contractAddress}`);
      
      const response = await this.getNFTSales(contractAddress, fromBlock, 'latest', limit);
      
      if (response && response.nftSales.length > 0) {
        allSales.push(...response.nftSales);
        logger.info(`Added ${response.nftSales.length} sales from contract ${contractAddress}`);
      } else {
        logger.info(`No recent sales found for contract ${contractAddress}`);
      }
    }

    // Sort all sales by block number (newest first)
    allSales.sort((a, b) => b.blockNumber - a.blockNumber);
    
    logger.info(`Total recent sales found: ${allSales.length}`);
    return allSales;
  }

  /**
   * Get the latest block number from the last sales fetch
   * This helps us track where to start the next fetch from
   */
  async getLatestValidBlock(): Promise<number | null> {
    try {
      // Fetch a minimal amount of data just to get the latest block info
      const response = await this.getNFTSales(config.contracts[0], undefined, 'latest', 1);
      
      if (response && response.validAt) {
        return response.validAt.blockNumber;
      }
      
      return null;
    } catch (error: any) {
      logger.error('[Alchemy API] Failed to get latest valid block:', error.message);
      return null;
    }
  }

  /**
   * Get owners for a specific NFT token
   * @param contractAddress - The contract address (e.g., ENS contract)
   * @param tokenId - The token ID to get owners for
   */
  async getOwnersForToken(contractAddress: string, tokenId: string): Promise<string[]> {
    try {
      const url = `${this.baseUrl}/nft/v2/${this.apiKey}/getOwnersForToken`;
      
      const params = {
        contractAddress,
        tokenId
      };

      logger.debug(`Fetching owners for token ${tokenId} on contract ${contractAddress}`);

      const response: AxiosResponse<{ owners: string[] }> = await axios.get(url, {
        params,
        timeout: 10000, // 10 second timeout
      });

      const owners = response.data.owners || [];
      logger.debug(`Found ${owners.length} owners for token ${tokenId}`);
      return owners;

    } catch (error: any) {
      logger.error(`[Alchemy API] Failed to fetch owners for token ${tokenId} on contract ${contractAddress}:`, error.message);
      
      if (error.response) {
        logger.error('[Alchemy API] Response error:', {
          status: error.response.status,
          data: error.response.data
        });
      }
      
      return []; // Return empty array on failure
    }
  }

  /**
   * Get current ETH price in USD with 30-minute caching to avoid API abuse
   * Uses Alchemy's prices API endpoint
   */
  async getETHPriceUSD(): Promise<number | null> {
    try {
      // Check for cached price first (30-minute cache)
      const cachedPrice = await this.getCachedETHPrice();
      if (cachedPrice) {
        return cachedPrice;
      }

      logger.debug('ETH price cache expired, fetching fresh price from Alchemy API');
      
      const response: AxiosResponse<AlchemyPriceResponse> = await axios.get(
        `https://api.g.alchemy.com/prices/v1/${this.apiKey}/tokens/by-symbol`,
        {
          params: {
            symbols: 'ETH'
          },
          timeout: 10000, // 10 second timeout
          headers: {
            'Accept': 'application/json',
            'User-Agent': 'ENS-TwitterBot/1.0'
          }
        }
      );

      const ethData = response.data.data[0]; // First token in response
      if (!ethData || ethData.symbol !== 'ETH') {
        throw new Error('ETH price data not found in response');
      }

      const usdPrice = ethData.prices.find(p => p.currency === 'usd');
      if (!usdPrice) {
        throw new Error('USD price not found for ETH');
      }

      const priceValue = parseFloat(usdPrice.value);
      logger.debug(`ETH price fetched: $${priceValue} (last updated: ${usdPrice.lastUpdatedAt})`);
      
      // Cache the fresh price for 30 minutes
      await this.cacheETHPrice(priceValue);
      
      return priceValue;
    } catch (error: any) {
      logger.warn('[Alchemy API] Failed to fetch ETH price:', error.message);
      
      // Fallback to $4000 if API is unavailable
      const fallbackPrice = 4000;
      logger.info(`💰 Using fallback ETH price: $${fallbackPrice} (API unavailable)`);
      
      // Cache the fallback price to avoid repeated API attempts
      await this.cacheETHPrice(fallbackPrice);
      
      return fallbackPrice;
    }
  }

  /**
   * Check for cached ETH price (30-minute cache)
   * Returns null if cache is expired or missing
   */
  private async getCachedETHPrice(): Promise<number | null> {
    try {
      if (!this.ethPriceCache) {
        return null;
      }

      const now = Date.now();
      const age = now - this.ethPriceCache.timestamp;
      
      if (age > this.CACHE_DURATION) {
        logger.debug('ETH price cache expired, will fetch fresh');
        this.ethPriceCache = null;
        return null;
      }

      const cacheAgeMinutes = Math.floor(age / 60000);
      logger.debug(`Using cached ETH price: $${this.ethPriceCache.price} (${cacheAgeMinutes}m old)`);
      return this.ethPriceCache.price;
    } catch (error: any) {
      logger.debug('Failed to get cached ETH price:', error.message);
      return null;
    }
  }

  /**
   * Cache ETH price with timestamp for 30-minute expiry
   */
  private async cacheETHPrice(price: number): Promise<void> {
    try {
      this.ethPriceCache = {
        price: price,
        timestamp: Date.now()
      };
      logger.debug(`ETH price cached: $${price} (will expire in 30 minutes)`);
    } catch (error: any) {
      logger.debug('Failed to cache ETH price:', error.message);
    }
  }

  /**
   * Test the API connection and configuration
   */
  async testConnection(): Promise<boolean> {
    try {
      logger.info('Testing Alchemy API connection...');
      
      const response = await this.getNFTSales(config.contracts[0], undefined, 'latest', 1);
      
      if (response) {
        logger.info('Alchemy API connection test successful');
        return true;
      } else {
        logger.error('[Alchemy API] Connection test failed - no response');
        return false;
      }
    } catch (error: any) {
      logger.error('[Alchemy API] Connection test failed:', error.message);
      return false;
    }
  }

  /**
   * Get whitelisted token addresses for specific networks
   * @param networks Networks to get tokens for
   * @returns Array of {network, tokenAddress} pairs for whitelisted tokens
   */
  private getWhitelistedTokens(networks: AlchemyNetwork[]): Array<{ network: string; tokenAddress: string }> {
    const tokens: Array<{ network: string; tokenAddress: string }> = [];
    
    networks.forEach(network => {
      const networkTokens = WHITELISTED_TOKENS[network] || [];
      networkTokens.forEach(tokenAddress => {
        tokens.push({ network, tokenAddress });
      });
    });
    
    return tokens;
  }

  /**
   * Get token metadata (symbol, decimals) for a token
   * @param network Network name
   * @param tokenAddress Token address (null for native)
   * @returns Metadata or undefined if not found
   */
  private getTokenMetadata(network: string, tokenAddress: string | null): { symbol: string; decimals: number } | undefined {
    if (tokenAddress === null) {
      return { symbol: 'ETH', decimals: 18 };
    }
    
    const key = `${network}:${tokenAddress.toLowerCase()}`;
    return TOKEN_METADATA[key];
  }

  /**
   * Get token balances for an address across multiple chains
   * Only fetches whitelisted tokens (major stablecoins, WETH, etc.)
   * @param address Ethereum address
   * @param networks Array of networks to check (defaults to all supported)
   * @returns Array of token balances (only whitelisted tokens)
   */
  async getTokenBalances(
    address: string,
    networks: AlchemyNetwork[] = [...SUPPORTED_NETWORKS]
  ): Promise<TokenBalance[]> {
    try {
      // Get whitelisted tokens for the requested networks
      const whitelistedTokens = this.getWhitelistedTokens(networks);
      
      logger.info(`🔍 Fetching balances for ${address.slice(0, 10)}... (${whitelistedTokens.length} whitelisted tokens across ${networks.length} networks)`);

      const url = `https://api.g.alchemy.com/data/v1/${this.apiKey}/assets/tokens/balances/by-address`;
      
      const response: AxiosResponse<AlchemyTokenBalanceResponse> = await axios.post(url, {
        addresses: [
          {
            address: address,
            networks: networks
          }
        ],
        includeNativeTokens: true,
        includeErc20Tokens: true
      }, {
        headers: {
          'Content-Type': 'application/json'
        },
        timeout: 30000
      });

      const allTokens = response.data.data.tokens;
      
      // Filter to only whitelisted tokens + native tokens
      const whitelistSet = new Set(whitelistedTokens.map(t => `${t.network}:${t.tokenAddress.toLowerCase()}`));
      const filteredTokens = allTokens.filter(token => {
        if (token.tokenAddress === null) {
          return true; // Always include native tokens (ETH)
        }
        const key = `${token.network}:${token.tokenAddress.toLowerCase()}`;
        return whitelistSet.has(key);
      });
      
      logger.info(`✅ Found ${filteredTokens.length} whitelisted tokens (filtered from ${allTokens.length} total)`);

      // Parse hex balances to decimal and attach metadata
      const balances: TokenBalance[] = filteredTokens.map(token => {
        const balanceHex = token.tokenBalance;
        const balanceBigInt = BigInt(balanceHex);
        const metadata = this.getTokenMetadata(token.network, token.tokenAddress);
        
        return {
          network: token.network,
          tokenAddress: token.tokenAddress,
          balance: balanceBigInt.toString(),
          balanceRaw: balanceHex,
          symbol: metadata?.symbol,
          decimals: metadata?.decimals
        };
      });

      return balances;
    } catch (error: any) {
      logger.error(`Failed to fetch token balances for ${address}:`, error.message);
      if (error.response) {
        logger.error('Response error:', error.response.data);
      }
      return []; // Return empty array on error (graceful degradation)
    }
  }

  /**
   * Get token prices from Alchemy (batch request)
   * Uses database cache with 1 hour TTL
   * @param tokens Array of {network, address} pairs
   * @returns Array of token prices
   */
  async getTokenPrices(
    tokens: Array<{ network: string; address: string | null }>
  ): Promise<TokenPrice[]> {
    if (tokens.length === 0) return [];

    try {
      logger.info(`💰 Fetching prices for ${tokens.length} tokens`);

      // Check cache first
      const prices: TokenPrice[] = [];
      const tokensToFetch: Array<{ network: string; address: string | null }> = [];

      for (const token of tokens) {
        const cached = await this.databaseService.getTokenPrice(token.network, token.address);
        if (cached) {
          prices.push({
            network: token.network,
            tokenAddress: token.address,
            symbol: cached.symbol,
            decimals: cached.decimals,
            priceUsd: cached.priceUsd,
            lastUpdatedAt: cached.lastUpdatedAt,
            source: 'cache'
          });
        } else {
          tokensToFetch.push(token);
        }
      }

      logger.debug(`   Cache: ${prices.length} hits, ${tokensToFetch.length} misses`);

      // Handle native ETH tokens separately - use ETH price
      const nativeTokens = tokensToFetch.filter(t => t.address === null);
      const erc20Tokens = tokensToFetch.filter(t => t.address !== null);
      
      if (nativeTokens.length > 0) {
        // Get ETH price
        const ethPrice = await this.getETHPriceUSD();
        
        if (ethPrice && ethPrice > 0) {
          // Add ETH price for all native tokens
          nativeTokens.forEach(token => {
            prices.push({
              network: token.network,
              tokenAddress: null,
              symbol: 'ETH',
              decimals: 18,
              priceUsd: ethPrice,
              lastUpdatedAt: new Date(),
              source: 'api'
            });
          });
          logger.debug(`   Added ETH price ($${ethPrice}) for ${nativeTokens.length} native tokens`);
        }
      }

      // Fetch missing prices from API for ERC20 tokens
      // Note: Alchemy limits to 3 distinct networks per request, so we need to batch
      if (erc20Tokens.length > 0) {
        const url = `https://api.g.alchemy.com/prices/v1/${this.apiKey}/tokens/by-address`;
        
        // Group tokens by network
        const tokensByNetwork = new Map<string, Array<{ network: string; address: string | null }>>();
        erc20Tokens.forEach(token => {
          if (!tokensByNetwork.has(token.network)) {
            tokensByNetwork.set(token.network, []);
          }
          tokensByNetwork.get(token.network)!.push(token);
        });
        
        // Process in batches of 3 networks max
        const networks = Array.from(tokensByNetwork.keys());
        const batches: Array<Array<{ network: string; address: string | null }>> = [];
        
        for (let i = 0; i < networks.length; i += 3) {
          const batchNetworks = networks.slice(i, i + 3);
          const batchTokens: Array<{ network: string; address: string | null }> = [];
          batchNetworks.forEach(net => {
            batchTokens.push(...tokensByNetwork.get(net)!);
          });
          batches.push(batchTokens);
        }
        
        logger.debug(`   Batching ${erc20Tokens.length} ERC20 tokens across ${batches.length} API requests (3 networks max per request)`);
        
        // Fetch all batches
        for (const batch of batches) {
          const requestBody = {
            addresses: batch
              .filter(t => t.address !== null) // Skip native tokens - they don't have prices in this API
              .map(t => ({
                network: t.network,
                address: t.address!
              }))
          };
          
          if (requestBody.addresses.length === 0) {
            continue; // Skip if only native tokens in this batch
          }

          const response = await axios.post(url, requestBody, {
            headers: {
              'Content-Type': 'application/json'
            },
            timeout: 30000
          }).catch((error: any) => {
            logger.error(`Price API batch request failed:`, error.response?.data || error.message);
            return null;
          }) as AxiosResponse<AlchemyTokenPriceResponse> | null;
          
          if (!response) continue;

          // Parse response and cache prices
          const pricesToCache: Array<{
            network: string;
            tokenAddress: string | null;
            symbol: string;
            decimals: number;
            priceUsd: number;
          }> = [];

          for (const priceData of response.data.data) {
            if (priceData.error) {
              logger.debug(`   No price for ${priceData.network}:${priceData.address} - ${priceData.error.message}`);
              continue;
            }

            if (priceData.prices.length > 0) {
              const usdPrice = priceData.prices.find(p => p.currency === 'usd');
              if (usdPrice) {
                const tokenAddress = priceData.address;
                const priceUsd = parseFloat(usdPrice.value);
                
                // Price API doesn't return symbol/decimals - use address prefix for ERC20
                const symbol = tokenAddress.slice(0, 8) + '...';
                const decimals = 18; // Default to 18 for all tokens

                prices.push({
                  network: priceData.network,
                  tokenAddress,
                  symbol,
                  decimals,
                  priceUsd,
                  lastUpdatedAt: new Date(usdPrice.lastUpdatedAt),
                  source: 'api'
                });

                pricesToCache.push({
                  network: priceData.network,
                  tokenAddress,
                  symbol,
                  decimals,
                  priceUsd
                });
              }
            }
          }

          // Cache the fetched prices
          if (pricesToCache.length > 0) {
            await this.databaseService.setTokenPricesBatch(pricesToCache);
            logger.debug(`   Cached ${pricesToCache.length} prices from batch`);
          }
        }
        
        logger.info(`✅ Fetched ${prices.filter(p => p.source === 'api').length} prices from API, cached for 1 hour`);
      }

      return prices;
    } catch (error: any) {
      logger.error(`Failed to fetch token prices:`, error.message);
      if (error.response) {
        logger.error('Response error:', error.response.data);
      }
      return []; // Return empty array on error (graceful degradation)
    }
  }

  /**
   * Get complete wallet portfolio with balances and prices
   * @param address Ethereum address
   * @param networks Networks to analyze (defaults to all)
   * @returns Complete wallet portfolio
   */
  async getWalletPortfolio(
    address: string,
    networks: AlchemyNetwork[] = [...SUPPORTED_NETWORKS]
  ): Promise<WalletPortfolio> {
    try {
      logger.info(`📊 Building portfolio for ${address.slice(0, 10)}... across ${networks.length} networks`);

      // Get token balances (only whitelisted tokens)
      const balances = await this.getTokenBalances(address, networks);

      // Filter out zero balances
      const nonZeroBalances = balances.filter(b => BigInt(b.balance) > 0n);
      
      logger.debug(`   ${nonZeroBalances.length} non-zero whitelisted balances found`);

      // Prepare tokens for price lookup
      const tokensForPricing = nonZeroBalances.map(b => ({
        network: b.network,
        address: b.tokenAddress
      }));

      // Get prices (with caching)
      const prices = await this.getTokenPrices(tokensForPricing);

      // Build price map for easy lookup
      const priceMap = new Map<string, TokenPrice>();
      prices.forEach(p => {
        const key = `${p.network}:${p.tokenAddress || 'native'}`;
        priceMap.set(key, p);
      });

      // Calculate portfolio
      const nativeTokens: WalletPortfolio['nativeTokens'] = [];
      const erc20Tokens: WalletPortfolio['erc20Tokens'] = [];
      let totalValueUsd = 0;
      let tokensWithoutPrices = 0;

      for (const balance of nonZeroBalances) {
        const key = `${balance.network}:${balance.tokenAddress || 'native'}`;
        const price = priceMap.get(key);

        if (!price) {
          tokensWithoutPrices++;
          continue;
        }

        // Convert balance from raw to decimal using token decimals
        const balanceDecimal = Number(BigInt(balance.balance)) / Math.pow(10, price.decimals || 18);
        const valueUsd = balanceDecimal * price.priceUsd;

        if (balance.tokenAddress === null) {
          // Native token (ETH)
          nativeTokens.push({
            network: balance.network,
            symbol: price.symbol || 'ETH',
            balance: balanceDecimal,
            valueUsd
          });
        } else {
          // ERC20 token (use address as symbol since API doesn't provide it)
          erc20Tokens.push({
            network: balance.network,
            tokenAddress: balance.tokenAddress,
            symbol: price.symbol || balance.tokenAddress.slice(0, 8) + '...',
            balance: balanceDecimal,
            valueUsd
          });
        }

        totalValueUsd += valueUsd;
      }

      // Sort by value
      erc20Tokens.sort((a, b) => b.valueUsd - a.valueUsd);

      // Build top holdings (aggregated across chains)
      const holdingsMap = new Map<string, { totalValueUsd: number; networks: string[] }>();
      
      [...nativeTokens, ...erc20Tokens].forEach(token => {
        const symbol = token.symbol;
        if (!holdingsMap.has(symbol)) {
          holdingsMap.set(symbol, { totalValueUsd: 0, networks: [] });
        }
        const holding = holdingsMap.get(symbol)!;
        holding.totalValueUsd += token.valueUsd;
        if (!holding.networks.includes(token.network)) {
          holding.networks.push(token.network);
        }
      });

      const topHoldings = Array.from(holdingsMap.entries())
        .map(([symbol, data]) => ({
          symbol,
          totalValueUsd: data.totalValueUsd,
          networks: data.networks
        }))
        .sort((a, b) => b.totalValueUsd - a.totalValueUsd)
        .slice(0, 10);

      const portfolio: WalletPortfolio = {
        address,
        totalValueUsd,
        nativeTokens,
        erc20Tokens: erc20Tokens.slice(0, 5), // Top 5 ERC20 holdings
        topHoldings,
        networksAnalyzed: networks,
        tokensWithoutPrices,
        incomplete: false
      };

      logger.info(`✅ Portfolio built: $${totalValueUsd.toLocaleString()} across ${nativeTokens.length} native + ${erc20Tokens.length} ERC20 tokens`);

      return portfolio;
    } catch (error: any) {
      logger.error(`Failed to build portfolio for ${address}:`, error.message);
      
      // Return minimal portfolio on error
      return {
        address,
        totalValueUsd: 0,
        nativeTokens: [],
        erc20Tokens: [],
        topHoldings: [],
        networksAnalyzed: networks,
        tokensWithoutPrices: 0,
        incomplete: true
      };
    }
  }
}
