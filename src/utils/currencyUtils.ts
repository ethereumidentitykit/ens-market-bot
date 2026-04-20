import { logger } from './logger';
import { CURRENCY_MAP } from './currencyConstants';
import { getCurrencyDisplayName } from './bidUtils';

/**
 * Currency utilities for secure contract address → symbol mapping.
 *
 * Address/symbol/decimals data lives in {@link CURRENCY_MAP} (./currencyConstants).
 * This class provides higher-level helpers with logging and fail-safe defaults.
 */
export class CurrencyUtils {
  /**
   * Get currency symbol from contract address (secure mapping).
   * Falls back to API-provided symbol if contract is unknown, logs a warning either way.
   */
  static getCurrencySymbol(contractAddress: string, apiSymbol?: string): string {
    if (!contractAddress) {
      return 'ETH'; // Native ETH (empty contract)
    }

    const knownCurrency = CURRENCY_MAP[contractAddress.toLowerCase()];
    if (knownCurrency) {
      return knownCurrency;
    }

    if (apiSymbol) {
      logger.warn(`⚠️ Unknown currency contract: ${contractAddress}, using API symbol: ${apiSymbol}`);
      return apiSymbol;
    }

    logger.warn(`⚠️ Unknown currency contract: ${contractAddress}, defaulting to ETH`);
    return 'ETH';
  }

  /**
   * Check if a contract address represents ETH or WETH.
   * Only returns true for explicitly known ETH/WETH contracts — unknown contracts return false.
   */
  static isETHEquivalent(contractAddress: string): boolean {
    if (!contractAddress) return true; // Native ETH
    return CURRENCY_MAP[contractAddress.toLowerCase()] === 'ETH';
  }

  /**
   * Get user-friendly currency display name.
   * Delegates to the canonical {@link getCurrencyDisplayName} in bidUtils.
   */
  static getDisplayName(symbol: string): string {
    return getCurrencyDisplayName(symbol);
  }

  /**
   * Check if contract address is a known stablecoin
   */
  static isStablecoin(contractAddress: string): boolean {
    const symbol = this.getCurrencySymbol(contractAddress);
    return ['USDC', 'USDT', 'DAI'].includes(symbol);
  }
}
