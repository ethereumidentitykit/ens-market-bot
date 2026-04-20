/**
 * Shared currency + ENS contract constants.
 *
 * Single source of truth for token metadata used across services.
 * Prefer adding new currencies here rather than duplicating in services.
 *
 * For higher-level helpers (getCurrencySymbol with fallback warnings,
 * isStablecoin, etc.) see {@link CurrencyUtils} in ./currencyUtils.
 */

/**
 * Currency address (lowercase) → symbol mapping.
 * Note: WETH maps to 'ETH' for display purposes; use the explicit WETH address
 * if you need to distinguish them.
 */
export const CURRENCY_MAP: Record<string, string> = {
  '0x0000000000000000000000000000000000000000': 'ETH',
  '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee': 'ETH',
  '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2': 'ETH', // WETH (displayed as ETH)
  '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48': 'USDC',
  '0xdac17f958d2ee523a2206206994597c13d831ec7': 'USDT',
  '0x6b175474e89094c44da98b954eedeac495271d0f': 'DAI',
};

/**
 * Currency symbol → decimals.
 * Used for converting raw wei amounts to decimal prices.
 * Defaults to 18 (ETH/WETH/DAI) for unknown currencies.
 */
export const CURRENCY_DECIMALS: Record<string, number> = {
  ETH: 18,
  WETH: 18,
  USDC: 6,
  USDT: 6,
  DAI: 18,
};

/**
 * Currency symbol → human-readable display name.
 */
export const CURRENCY_NAMES: Record<string, string> = {
  ETH: 'Ether',
  WETH: 'Wrapped Ether',
  USDC: 'USD Coin',
  USDT: 'Tether',
  DAI: 'Dai Stablecoin',
};

/**
 * ENS contract addresses (lowercase).
 */
export const ENS_NAMEWRAPPER = '0xd4416b13d2b3a9abae7acd5d6c2bbdbe25686401';
export const ENS_BASE_REGISTRAR = '0x57f1887a8bf19b14fc0df6fd9b2acc9af147ea85';
