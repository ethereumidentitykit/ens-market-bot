import axios, { AxiosResponse } from 'axios';
import { config } from '../utils/config';
import { logger } from '../utils/logger';
import { AlchemyNFTSalesResponse, NFTSale, AlchemyPriceResponse } from '../types';
import { DatabaseService } from './databaseService';
import { WHITELISTED_TOKENS, TOKEN_METADATA } from '../config/portfolio-tokens';

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

// Native token symbols by network
const NATIVE_TOKEN_SYMBOLS: Record<AlchemyNetwork, string> = {
  'eth-mainnet': 'ETH',
  'base-mainnet': 'ETH',
  'opt-mainnet': 'ETH',
  'arb-mainnet': 'ETH',
  'zksync-mainnet': 'ETH',
  'polygon-mainnet': 'POL', // Polygon uses POL as native token
  'linea-mainnet': 'ETH'
};

// WETH contract addresses across all chains (lowercase for comparison)
// WETH should always use ETH price (1:1 peg)
const WETH_ADDRESSES = new Set([
  '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2', // ETH mainnet
  '0x4200000000000000000000000000000000000006', // Base, Optimism
  '0x82af49447d8a07e3bd95bd0d56f35241523fbab1', // Arbitrum
  '0x5aea5775959fbc2557cc8789bc1bf90a239d9a91', // zkSync
  '0x7ceb23fd6bc0add59e62ac25578270cff1b9f619', // Polygon
  '0xe5d7c2a44ffddf6b295a15c148167daaaf5cf34f', // Linea
]);

// Token balance response from Alchemy
interface AlchemyTokenBalanceResponse {
  data: {
    tokens: Array<{
      address: string;
      network: string;
      tokenAddress: string | null; // null for native tokens (ETH)
      tokenBalance: string; // Hex string
    }>;
    pageKey?: string; // For pagination when more than 100 tokens
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
  source: 'cache' | 'api' | 'eth-price';
}

// Wallet portfolio summary
export interface WalletPortfolio {
  address: string;
  totalValueUsd: number;
  
  nativeTokens: Array<{
    network: string;
    symbol: string; // 'ETH', 'MATIC', etc. (network-specific native token)
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
   * Get token price by symbol (e.g., MATIC, USDC) in USD
   * Uses Alchemy's prices API endpoint
   * @param symbol Token symbol (e.g., 'MATIC')
   * @returns Price in USD or null on failure
   */
  async getTokenPriceBySymbol(symbol: string): Promise<number | null> {
    try {
      logger.debug(`Fetching ${symbol} price from Alchemy API`);
      
      const response: AxiosResponse<AlchemyPriceResponse> = await axios.get(
        `https://api.g.alchemy.com/prices/v1/${this.apiKey}/tokens/by-symbol`,
        {
          params: {
            symbols: symbol
          },
          timeout: 10000,
          headers: {
            'Accept': 'application/json',
            'User-Agent': 'ENS-TwitterBot/1.0'
          }
        }
      );

      const tokenData = response.data.data[0];
      if (!tokenData || tokenData.symbol !== symbol) {
        throw new Error(`${symbol} price data not found in response`);
      }

      const usdPrice = tokenData.prices.find(p => p.currency === 'usd');
      if (!usdPrice) {
        throw new Error(`USD price not found for ${symbol}`);
      }

      const priceValue = parseFloat(usdPrice.value);
      logger.debug(`${symbol} price fetched: $${priceValue} (last updated: ${usdPrice.lastUpdatedAt})`);
      
      return priceValue;
    } catch (error: any) {
      logger.warn(`[Alchemy API] Failed to fetch ${symbol} price:`, error.message);
      return null;
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
      // Return correct native token symbol for the network
      const symbol = NATIVE_TOKEN_SYMBOLS[network as AlchemyNetwork] || 'ETH';
      return { symbol, decimals: 18 };
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
      
      // Paginate through all results
      let allTokens: any[] = [];
      let pageKey: string | undefined = undefined;
      let pageCount = 0;

      do {
        const requestBody: any = {
          addresses: [
            {
              address: address,
              networks: networks
            }
          ],
          includeNativeTokens: true,
          includeErc20Tokens: true,
          maxCount: 100 // Explicitly set max (API default)
        };

        if (pageKey) {
          requestBody.pageKey = pageKey;
        }

        const response: AxiosResponse<AlchemyTokenBalanceResponse> = await axios.post(url, requestBody, {
          headers: {
            'Content-Type': 'application/json'
          },
          timeout: 30000
        });

        const pageTokens = response.data.data.tokens;
        allTokens = allTokens.concat(pageTokens);
        pageKey = response.data.data.pageKey;
        pageCount++;

        logger.debug(`   📄 Page ${pageCount}: ${pageTokens.length} tokens, pageKey: ${pageKey ? 'yes' : 'no'}`);
      } while (pageKey);

      logger.info(`✅ Fetched ${allTokens.length} total tokens across ${pageCount} page(s)`);
      
      // Filter to only whitelisted tokens + native tokens
      const whitelistSet = new Set(whitelistedTokens.map(t => `${t.network}:${t.tokenAddress.toLowerCase()}`));
      const filteredTokens = allTokens.filter(token => {
        if (token.tokenAddress === null) {
          return true; // Always include native tokens (ETH)
        }
        const key = `${token.network}:${token.tokenAddress.toLowerCase()}`;
        return whitelistSet.has(key);
      });
      
      // Log WETH specifically for debugging
      const wethMainnetKey = 'eth-mainnet:0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2';
      const wethToken = filteredTokens.find(t => 
        t.network === 'eth-mainnet' && 
        t.tokenAddress?.toLowerCase() === '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2'
      );
      if (wethToken) {
        logger.debug(`   🔍 WETH on mainnet found: balance=${wethToken.tokenBalance} (${BigInt(wethToken.tokenBalance).toString()} wei)`);
      } else {
        logger.debug(`   ⚠️ WETH on mainnet NOT found in Alchemy response after ${pageCount} page(s)`);
      }
      
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

      // Separate tokens by type
      const nativeTokens = tokensToFetch.filter(t => t.address === null);
      const wethTokens = tokensToFetch.filter(t => 
        t.address !== null && WETH_ADDRESSES.has(t.address.toLowerCase())
      );
      const otherErc20Tokens = tokensToFetch.filter(t => 
        t.address !== null && !WETH_ADDRESSES.has(t.address.toLowerCase())
      );
      
      // Handle native tokens - fetch correct price per network
      if (nativeTokens.length > 0) {
        // Group native tokens by symbol (ETH, POL, etc.)
        const nativeBySymbol = new Map<string, Array<{ network: string; address: string | null }>>();
        nativeTokens.forEach(token => {
          const symbol = NATIVE_TOKEN_SYMBOLS[token.network as AlchemyNetwork] || 'ETH';
          if (!nativeBySymbol.has(symbol)) {
            nativeBySymbol.set(symbol, []);
          }
          nativeBySymbol.get(symbol)!.push(token);
        });
        
        // Fetch price for each unique native token symbol
        for (const [symbol, tokens] of nativeBySymbol.entries()) {
          let nativePrice: number | null = null;
          
          // Fetch price based on symbol
          if (symbol === 'ETH') {
            nativePrice = await this.getETHPriceUSD();
          } else if (symbol === 'MATIC') {
            nativePrice = await this.getTokenPriceBySymbol('MATIC');
          }
          
          if (nativePrice && nativePrice > 0) {
            // Add price for all networks using this native token
            tokens.forEach(token => {
              prices.push({
                network: token.network,
                tokenAddress: null,
                symbol: symbol,
                decimals: 18,
                priceUsd: nativePrice!,
                lastUpdatedAt: new Date(),
                source: 'api'
              });
            });
            
            logger.debug(`   Added ${symbol} price ($${nativePrice}) for ${tokens.length} native token(s)`);
          }
        }
      }
      
      // Handle WETH - always uses ETH price (1:1 peg)
      if (wethTokens.length > 0) {
        const ethPrice = await this.getETHPriceUSD();
        
        if (ethPrice && ethPrice > 0) {
          const wethPricesToCache: Array<{
            network: string;
            tokenAddress: string | null;
            symbol: string;
            decimals: number;
            priceUsd: number;
          }> = [];
          
          wethTokens.forEach(token => {
            prices.push({
              network: token.network,
              tokenAddress: token.address,
              symbol: 'WETH',
              decimals: 18,
              priceUsd: ethPrice,
              lastUpdatedAt: new Date(),
              source: 'eth-price'
            });
            
            // Cache WETH price
            wethPricesToCache.push({
              network: token.network,
              tokenAddress: token.address,
              symbol: 'WETH',
              decimals: 18,
              priceUsd: ethPrice
            });
          });
          
          // Cache WETH prices
          if (wethPricesToCache.length > 0) {
            await this.databaseService.setTokenPricesBatch(wethPricesToCache);
          }
          
          logger.debug(`   Added ETH price ($${ethPrice}) for ${wethTokens.length} WETH token(s)`);
        }
      }

      // Fetch missing prices from API for other ERC20 tokens (non-WETH)
      // Note: Alchemy limits to 3 distinct networks per request, so we need to batch
      if (otherErc20Tokens.length > 0) {
        const url = `https://api.g.alchemy.com/prices/v1/${this.apiKey}/tokens/by-address`;
        
        // Group tokens by network
        const tokensByNetwork = new Map<string, Array<{ network: string; address: string | null }>>();
        otherErc20Tokens.forEach(token => {
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
        
        logger.debug(`   Batching ${otherErc20Tokens.length} ERC20 tokens across ${batches.length} API requests (3 networks max per request)`);
        
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
          // Native token (ETH, MATIC, etc. - network-specific)
          nativeTokens.push({
            network: balance.network,
            symbol: price.symbol || NATIVE_TOKEN_SYMBOLS[balance.network as AlchemyNetwork] || 'ETH',
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
