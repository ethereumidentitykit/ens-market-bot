import { logger } from './logger';

/**
 * Time utilities for contextual tweet enhancements
 */
export class TimeUtils {
  /**
   * Calculate days between a timestamp and now
   */
  static calculateDaysSince(timestamp: number): number {
    const now = Math.floor(Date.now() / 1000); // Current Unix timestamp
    const diffSeconds = now - timestamp;
    const days = Math.floor(diffSeconds / (24 * 60 * 60));
    return Math.max(0, days); // Ensure non-negative
  }

  /**
   * Format time period for tweet display
   * Examples: "today", "1 day ago", "15 days ago", "2 months ago", "1 year ago"
   */
  static formatTimePeriod(days: number): string {
    if (days === 0) return 'today';
    if (days === 1) return '1 day ago';
    if (days < 30) return `${days} days ago`;
    if (days < 60) return '1 month ago';
    if (days < 365) {
      const months = Math.floor(days / 30);
      return `${months} month${months > 1 ? 's' : ''} ago`;
    }
    const years = Math.floor(days / 365);
    return `${years} year${years > 1 ? 's' : ''} ago`;
  }

  /**
   * Format historical event for tweet display with dynamic label
   * Example: "Last Sale: 0.25 ETH, 19 Mar 2024" or "Last Reg: 0.25 ETH, 19 Mar 2024"
   */
  static formatHistoricalEvent(priceEth: number, timestamp: number, eventType: 'sale' | 'mint'): string {
    const dateString = TimeUtils.formatDateForTweet(timestamp);
    const formattedPrice = priceEth.toFixed(2);
    const label = eventType === 'sale' ? 'Last Sale:' : 'Last Reg:';
    
    const result = `${label} ${formattedPrice} ETH, ${dateString}`;
    logger.debug(`🕒 Formatted historical event (${eventType}): ${result}`);
    return result;
  }

  /**
   * Format timestamp as "19 Mar 2024" for tweet display
   */
  static formatDateForTweet(timestamp: number): string {
    const date = new Date(timestamp * 1000); // Convert Unix timestamp to milliseconds
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    
    const day = date.getDate();
    const month = months[date.getMonth()];
    const year = date.getFullYear();
    
    return `${day} ${month} ${year}`;
  }

  /**
   * Format listing price for bid tweets
   * Example: "$1,234.56 (0.75 ETH)"
   */
  static formatListingPrice(priceEth: number, priceUsd?: number): string {
    const formattedEth = priceEth.toFixed(2);
    
    if (priceUsd && priceUsd > 0) {
      const formattedUsd = `$${priceUsd.toLocaleString('en-US', { 
        minimumFractionDigits: 2, 
        maximumFractionDigits: 2 
      })}`;
      return `${formattedUsd} (${formattedEth} ETH)`;
    }
    
    return `${formattedEth} ETH`;
  }
}
