/**
 * Shared bid utility functions.
 */

export function calculateBidDuration(validFrom: number, validUntil: number): string {
  const durationMs = (validUntil - validFrom) * 1000;
  const minutes = Math.floor(durationMs / (1000 * 60));
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  const weeks = Math.floor(days / 7);
  const months = Math.floor(days / 30);

  if (months >= 6) return `${months} months`;
  if (months >= 1) return `${months} month${months > 1 ? 's' : ''}`;
  if (weeks >= 1) return `${weeks} week${weeks > 1 ? 's' : ''}`;
  if (days >= 1) return `${days} day${days > 1 ? 's' : ''}`;
  if (hours >= 1) return `${hours} hour${hours > 1 ? 's' : ''}`;
  if (minutes >= 1) return `${minutes} minute${minutes > 1 ? 's' : ''}`;
  return 'less than 1 minute';
}

const CURRENCY_DISPLAY: Record<string, string> = {
  'WETH': 'ETH',
  'USDC': 'USDC',
  'USDT': 'USDT',
};

export function getCurrencyDisplayName(symbol: string): string {
  return CURRENCY_DISPLAY[symbol.toUpperCase()] || symbol;
}
