import axios, { AxiosResponse } from 'axios';
import { logger } from '../utils/logger';
import { NFTSale } from '../types';
import { config } from '../utils/config';

/**
 * Bitquery GraphQL API Response Types
 */
interface BitqueryTrade {
  Block: {
    Time: string;
    Number: string;
  };
  Transaction: {
    Hash: string;
  };
  Trade: {
    Dex: {
      ProtocolFamily: string;
      ProtocolName: string;
      ProtocolVersion: string;
      SmartContract: string;
    };
    Buy: {
      Price: string;
      Buyer: string;
      Ids: string[];
      URIs: string[];
    };
    Sell: {
      Seller: string;
      Amount: string;
      Currency: {
        Symbol: string;
        SmartContract: string;
      };
    };
  };
}

interface BitqueryResponse {
  data: {
    EVM: {
      DEXTrades: BitqueryTrade[];
    };
  };
  errors?: Array<{
    message: string;
    locations?: Array<{ line: number; column: number }>;
    path?: string[];
  }>;
}

/**
 * Bitquery API Service for real-time NFT trade data
 * Replaces AlchemyService with more recent data
 */
export class BitqueryService {
  private readonly baseUrl: string;
  private readonly apiToken: string;

  constructor() {
    if (!config.bitquery?.token) {
      throw new Error('BITQUERY_TOKEN environment variable is required');
    }
    
    this.baseUrl = config.bitquery.baseUrl;
    this.apiToken = config.bitquery.token;
  }

  /**
   * Execute a GraphQL query against Bitquery API
   */
  private async executeQuery(query: string): Promise<BitqueryResponse | null> {
    try {
      logger.debug('Executing Bitquery GraphQL query');
      
      const response: AxiosResponse<BitqueryResponse> = await axios.post(
        this.baseUrl,
        { query },
        {
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${this.apiToken}`,
          },
          timeout: 30000, // 30 second timeout
        }
      );

      if (response.data.errors && response.data.errors.length > 0) {
        logger.error('Bitquery GraphQL errors:', response.data.errors);
        return null;
      }

      return response.data;

    } catch (error: any) {
      logger.error('Failed to execute Bitquery query:', error.message);
      
      if (error.response) {
        logger.error('Bitquery API response error:', {
          status: error.response.status,
          data: error.response.data
        });
      }
      
      return null;
    }
  }

  /**
   * Get recent NFT trades for a specific contract
   * @param contractAddress - NFT contract address to query
   * @param limit - Maximum number of trades to return
   * @param fromBlock - Optional starting block (for pagination)
   */
  async getNFTTrades(
    contractAddress: string,
    limit: number = 100,
    fromBlock?: string
  ): Promise<NFTSale[]> {
    try {
      logger.info(`Fetching NFT trades for contract: ${contractAddress} (limit: ${limit})`);

      // Build GraphQL query
      let whereClause = `{Trade: {Buy: {Currency: {SmartContract: {is: "${contractAddress}"}}}}}`;
      
      // Add block filter if specified
      if (fromBlock) {
        whereClause = `{Trade: {Buy: {Currency: {SmartContract: {is: "${contractAddress}"}}}}, Block: {Number: {gt: "${fromBlock}"}}}`;
      }

      const query = `{
        EVM(network: eth) {
          DEXTrades(
            orderBy: {descending: Block_Number}
            where: ${whereClause}
            limit: {count: ${limit}}
          ) {
            Block {
              Time
              Number
            }
            Transaction {
              Hash
            }
            Trade {
              Dex {
                ProtocolFamily
                ProtocolName
                ProtocolVersion
                SmartContract
              }
              Buy {
                Price
                Buyer
                Ids
                URIs
              }
              Sell {
                Seller
                Amount
                Currency {
                  Symbol
                  SmartContract
                }
              }
            }
          }
        }
      }`;

      const response = await this.executeQuery(query);
      
      if (!response || !response.data.EVM.DEXTrades) {
        logger.warn(`No trades found for contract ${contractAddress}`);
        return [];
      }

      const trades = response.data.EVM.DEXTrades;
      logger.info(`Successfully fetched ${trades.length} trades for contract ${contractAddress}`);

      // Convert to our NFTSale format
      return trades.map(trade => this.convertToNFTSale(trade, contractAddress));

    } catch (error: any) {
      logger.error(`Failed to fetch NFT trades for contract ${contractAddress}:`, error.message);
      return [];
    }
  }

  /**
   * Get recent NFT trades for all configured contracts
   * @param limit - Maximum number of trades per contract
   * @param fromBlock - Optional starting block
   */
  async getAllRecentTrades(limit: number = 100, fromBlock?: string): Promise<NFTSale[]> {
    const allTrades: NFTSale[] = [];

    for (const contractAddress of config.contracts) {
      logger.info(`Fetching recent trades for contract: ${contractAddress}`);
      
      const trades = await this.getNFTTrades(contractAddress, limit, fromBlock);
      
      if (trades.length > 0) {
        allTrades.push(...trades);
        logger.info(`Added ${trades.length} trades from contract ${contractAddress}`);
      } else {
        logger.info(`No recent trades found for contract ${contractAddress}`);
      }
    }

    // Sort all trades by block number (newest first)
    allTrades.sort((a, b) => b.blockNumber - a.blockNumber);
    
    logger.info(`Total recent trades found: ${allTrades.length}`);
    return allTrades;
  }

  /**
   * Convert Bitquery trade data to our NFTSale interface
   */
  private convertToNFTSale(trade: BitqueryTrade, contractAddress: string): NFTSale {
    const blockNumber = parseInt(trade.Block.Number);
    const blockTime = trade.Block.Time;
    const transactionHash = trade.Transaction.Hash;
    
    // Extract trade details
    const buyPrice = trade.Trade.Buy.Price;
    const buyerAddress = trade.Trade.Buy.Buyer;
    const sellerAddress = trade.Trade.Sell.Seller;
    const tokenIds = trade.Trade.Buy.Ids || [];
    const tokenId = tokenIds.length > 0 ? tokenIds[0] : '0';
    
    // Marketplace info
    const marketplace = this.normalizeMarketplaceName(trade.Trade.Dex.ProtocolName);
    
    // Currency info
    const sellCurrency = trade.Trade.Sell.Currency;
    const currencySymbol = sellCurrency.Symbol || 'ETH';
    
    // Convert price to wei format (Bitquery returns in ETH, we need wei)
    const priceInWei = this.ethToWei(buyPrice);

    return {
      blockNumber,
      blockTime,
      transactionHash,
      contractAddress,
      tokenId,
      marketplace,
      buyerAddress,
      sellerAddress,
      quantity: '1', // NFTs are typically quantity 1
      taker: 'BUYER', // Default assumption
      logIndex: 0, // Not provided by Bitquery
      bundleIndex: 0, // Not provided by Bitquery
      sellerFee: {
        amount: priceInWei,
        symbol: currencySymbol,
        decimals: 18
      },
      protocolFee: {
        amount: '0', // Bitquery provides total price, not separate fees
        symbol: currencySymbol,
        decimals: 18
      },
      royaltyFee: {
        amount: '0', // Bitquery provides total price, not separate fees
        symbol: currencySymbol,
        decimals: 18
      }
    };
  }

  /**
   * Convert ETH price to wei (18 decimals)
   */
  private ethToWei(ethAmount: string): string {
    try {
      const eth = parseFloat(ethAmount);
      if (isNaN(eth)) {
        logger.warn(`Invalid ETH amount: ${ethAmount}, defaulting to 0`);
        return '0';
      }
      
      // Convert to wei (multiply by 10^18)
      const wei = BigInt(Math.floor(eth * Math.pow(10, 18)));
      return wei.toString();
    } catch (error) {
      logger.warn(`Failed to convert ETH to wei: ${ethAmount}`, error);
      return '0';
    }
  }

  /**
   * Normalize marketplace names to match our existing format
   */
  private normalizeMarketplaceName(protocolName: string): string {
    const normalizedName = protocolName.toLowerCase();
    
    // Map Bitquery protocol names to our marketplace names
    if (normalizedName.includes('seaport')) {
      return 'seaport';
    } else if (normalizedName.includes('blur')) {
      return 'blur';
    } else if (normalizedName.includes('x2y2')) {
      return 'x2y2';
    } else if (normalizedName.includes('looksrare')) {
      return 'looksrare';
    } else if (normalizedName.includes('rarible')) {
      return 'rarible';
    } else {
      return protocolName.toLowerCase();
    }
  }

  /**
   * Test connection to Bitquery API
   */
  async testConnection(): Promise<boolean> {
    try {
      logger.info('Testing Bitquery API connection...');
      
      const query = `{
        EVM(network: eth) {
          DEXTrades(limit: {count: 1}) {
            Block {
              Number
            }
          }
        }
      }`;

      const response = await this.executeQuery(query);
      
      if (response && response.data.EVM.DEXTrades) {
        logger.info('✅ Bitquery API connection successful');
        return true;
      } else {
        logger.error('❌ Bitquery API connection failed - no data returned');
        return false;
      }
    } catch (error: any) {
      logger.error('❌ Bitquery API connection test failed:', error.message);
      return false;
    }
  }
}
