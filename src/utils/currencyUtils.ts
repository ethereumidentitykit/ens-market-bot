import { logger } from './logger';

/**
 * Currency utilities for secure contract address to symbol mapping
 */
export class CurrencyUtils {
  // Known contract addresses (lowercase for consistent matching)
  private static readonly CONTRACT_TO_CURRENCY: { [contract: string]: string } = {
    // USDC
    '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48': 'USDC',
    
    // WETH (maps to ETH for display since they're essentially the same)
    '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2': 'ETH',
    
    // USDT
    '0xdac17f958d2ee523a2206206994597c13d831ec7': 'USDT',
    
    // DAI
    '0x6b175474e89094c44da98b954eedeac495271d0f': 'DAI',
    
    // Native ETH (various representations)
    '0x0000000000000000000000000000000000000000': 'ETH', // Zero address
    '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee': 'ETH', // Common placeholder for native ETH
    '': 'ETH', // Empty contract also means native ETH
  };

  /**
   * Get currency symbol from contract address (secure mapping)
   * Falls back to API symbol only if contract is unknown
   */
  static getCurrencySymbol(contractAddress: string, apiSymbol?: string): string {
    if (!contractAddress) {
      return 'ETH'; // Native ETH
    }

    const contractLower = contractAddress.toLowerCase();
    const knownCurrency = this.CONTRACT_TO_CURRENCY[contractLower];
    
    if (knownCurrency) {
      return knownCurrency;
    }
    
    // Unknown contract - log warning and fallback to API symbol
    if (apiSymbol) {
      logger.warn(`⚠️ Unknown currency contract: ${contractAddress}, using API symbol: ${apiSymbol}`);
      return apiSymbol;
    }
    
    logger.warn(`⚠️ Unknown currency contract: ${contractAddress}, defaulting to ETH`);
    return 'ETH';
  }

  /**
   * Check if a contract address represents ETH or WETH
   */
  static isETHEquivalent(contractAddress: string): boolean {
    const symbol = this.getCurrencySymbol(contractAddress);
    return symbol === 'ETH';
  }

  /**
   * Get user-friendly currency display name
   */
  static getDisplayName(symbol: string): string {
    const displayMap: { [key: string]: string } = {
      'ETH': 'ETH',
      'WETH': 'ETH', // Display WETH as ETH
      'USDC': 'USDC',
      'USDT': 'USDT',
      'DAI': 'DAI',
    };
    
    return displayMap[symbol.toUpperCase()] || symbol;
  }

  /**
   * Check if contract address is a known stablecoin
   */
  static isStablecoin(contractAddress: string): boolean {
    const symbol = this.getCurrencySymbol(contractAddress);
    return ['USDC', 'USDT', 'DAI'].includes(symbol);
  }
}
