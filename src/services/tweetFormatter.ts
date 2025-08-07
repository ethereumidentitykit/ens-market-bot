import { ProcessedSale } from '../types';
import { logger } from '../utils/logger';

export interface FormattedTweet {
  content: string;
  characterCount: number;
  isValid: boolean;
  truncated: boolean;
}

export interface TweetFormatOptions {
  includeUsdPrice?: boolean;
  includeBuyerSeller?: boolean;
  useShortFormat?: boolean;
  customHashtags?: string[];
}

export class TweetFormatter {
  private readonly MAX_TWEET_LENGTH = 280;
  private readonly ETHERSCAN_BASE_URL = 'https://etherscan.io/tx/';
  
  // Collection name mappings for better readability
  private readonly COLLECTION_NAMES: Record<string, { name: string; hashtag: string }> = {
    '0xd4416b13d2b3a9abae7acd5d6c2bbdbe25686401': {
      name: 'NameWrapper',
      hashtag: 'ENS'
    },
    '0x57f1887a8bf19b14fc0df6fd9b2acc9af147ea85': {
      name: 'ENS',
      hashtag: 'ENS'
    }
  };

  /**
   * Format an NFT sale into a tweet
   */
  formatSale(sale: ProcessedSale, options: TweetFormatOptions = {}): FormattedTweet {
    try {
      logger.info(`Formatting tweet for sale: ${sale.transactionHash}`);

      const collectionInfo = this.COLLECTION_NAMES[sale.contractAddress.toLowerCase()] || {
        name: 'NFT',
        hashtag: 'NFT'
      };

      // Try full format first
      let tweet = this.createFullFormatTweet(sale, collectionInfo, options);
      let truncated = false;

      // If too long, try medium format
      if (tweet.length > this.MAX_TWEET_LENGTH) {
        tweet = this.createMediumFormatTweet(sale, collectionInfo, options);
        truncated = true;
      }

      // If still too long, use short format
      if (tweet.length > this.MAX_TWEET_LENGTH) {
        tweet = this.createShortFormatTweet(sale, collectionInfo, options);
        truncated = true;
      }

      const result: FormattedTweet = {
        content: tweet,
        characterCount: tweet.length,
        isValid: tweet.length <= this.MAX_TWEET_LENGTH && tweet.length > 0,
        truncated
      };

      logger.info(`Tweet formatted: ${result.characterCount} chars, valid: ${result.isValid}, truncated: ${result.truncated}`);
      return result;

    } catch (error: any) {
      logger.error('Error formatting tweet:', error.message);
      return {
        content: '',
        characterCount: 0,
        isValid: false,
        truncated: false
      };
    }
  }

  /**
   * Create full format tweet with all details
   */
  private createFullFormatTweet(
    sale: ProcessedSale, 
    collectionInfo: { name: string; hashtag: string },
    options: TweetFormatOptions
  ): string {
    const priceEth = parseFloat(sale.priceEth).toFixed(4);
    const usdPart = sale.priceUsd && options.includeUsdPrice !== false 
      ? ` ($${parseFloat(sale.priceUsd).toLocaleString()})` 
      : '';
    
    const buyerShort = this.shortenAddress(sale.buyerAddress);
    const sellerShort = this.shortenAddress(sale.sellerAddress);
    const buyerSellerPart = options.includeBuyerSeller !== false 
      ? `\n👤 ${buyerShort} ← ${sellerShort}` 
      : '';

    const hashtags = options.customHashtags || [`#${collectionInfo.hashtag}`, '#NFT'];
    const hashtagPart = hashtags.join(' ');

    return `🚀 NFT Sale Alert!

💰 ${priceEth} ETH${usdPart}
🏷️ ${collectionInfo.name} #${this.formatTokenId(sale.tokenId)}
🛒 ${this.formatMarketplace(sale.marketplace)}${buyerSellerPart}

🔗 ${this.ETHERSCAN_BASE_URL}${sale.transactionHash}

${hashtagPart}`;
  }

  /**
   * Create medium format tweet (remove USD price if needed)
   */
  private createMediumFormatTweet(
    sale: ProcessedSale, 
    collectionInfo: { name: string; hashtag: string },
    options: TweetFormatOptions
  ): string {
    const priceEth = parseFloat(sale.priceEth).toFixed(4);
    const buyerShort = this.shortenAddress(sale.buyerAddress);
    const sellerShort = this.shortenAddress(sale.sellerAddress);

    return `🚀 NFT Sale Alert!

💰 ${priceEth} ETH
🏷️ ${collectionInfo.name} #${this.formatTokenId(sale.tokenId)}
🛒 ${this.formatMarketplace(sale.marketplace)}
👤 ${buyerShort} ← ${sellerShort}

🔗 ${this.ETHERSCAN_BASE_URL}${sale.transactionHash}

#${collectionInfo.hashtag} #NFT`;
  }

  /**
   * Create short format tweet (minimal details)
   */
  private createShortFormatTweet(
    sale: ProcessedSale, 
    collectionInfo: { name: string; hashtag: string },
    options: TweetFormatOptions
  ): string {
    const priceEth = parseFloat(sale.priceEth).toFixed(3);

    return `🚀 ${collectionInfo.name} #${this.formatTokenId(sale.tokenId)} sold for ${priceEth} ETH

🔗 ${this.ETHERSCAN_BASE_URL}${sale.transactionHash}

#${collectionInfo.hashtag} #NFT`;
  }

  /**
   * Format token ID for display (shorten very long IDs)
   */
  private formatTokenId(tokenId: string): string {
    if (!tokenId) return 'Unknown';
    
    // If token ID is very long (like ENS wrapped names), shorten it
    if (tokenId.length > 20) {
      return `${tokenId.substring(0, 8)}...${tokenId.substring(tokenId.length - 8)}`;
    }
    
    return tokenId;
  }

  /**
   * Shorten Ethereum address to readable format
   */
  private shortenAddress(address: string): string {
    if (!address || address.length < 10) return address;
    return `${address.substring(0, 6)}...${address.substring(address.length - 4)}`;
  }

  /**
   * Format marketplace name for display
   */
  private formatMarketplace(marketplace: string): string {
    const marketplaceMap: Record<string, string> = {
      'opensea': 'OpenSea',
      'seaport': 'OpenSea', // Seaport is OpenSea's protocol
      'blur': 'Blur',
      'x2y2': 'X2Y2',
      'looksrare': 'LooksRare',
      'foundation': 'Foundation',
      'superrare': 'SuperRare',
      'rarible': 'Rarible',
      'niftygateway': 'Nifty Gateway'
    };

    return marketplaceMap[marketplace.toLowerCase()] || marketplace;
  }

  /**
   * Validate tweet content
   */
  validateTweet(content: string): { valid: boolean; errors: string[] } {
    const errors: string[] = [];

    if (!content || content.trim().length === 0) {
      errors.push('Tweet content cannot be empty');
    }

    if (content.length > this.MAX_TWEET_LENGTH) {
      errors.push(`Tweet too long: ${content.length} characters (max ${this.MAX_TWEET_LENGTH})`);
    }

    // Check for required elements
    if (!content.includes('ETH')) {
      errors.push('Tweet should include price in ETH');
    }

    if (!content.includes('etherscan.io')) {
      errors.push('Tweet should include Etherscan link');
    }

    return {
      valid: errors.length === 0,
      errors
    };
  }

  /**
   * Preview multiple format options for a sale
   */
  previewFormats(sale: ProcessedSale): {
    full: FormattedTweet;
    medium: FormattedTweet;
    short: FormattedTweet;
    recommended: FormattedTweet;
  } {
    const full = this.formatSale(sale, { includeUsdPrice: true, includeBuyerSeller: true });
    const medium = this.formatSale(sale, { includeUsdPrice: false, includeBuyerSeller: true });
    const short = this.formatSale(sale, { useShortFormat: true });

    // Recommend the best format (full if it fits, otherwise medium, then short)
    let recommended = full;
    if (!full.isValid && medium.isValid) {
      recommended = medium;
    } else if (!medium.isValid && short.isValid) {
      recommended = short;
    }

    return { full, medium, short, recommended };
  }

  /**
   * Get collection info for a contract address
   */
  getCollectionInfo(contractAddress: string): { name: string; hashtag: string } {
    return this.COLLECTION_NAMES[contractAddress.toLowerCase()] || {
      name: 'NFT',
      hashtag: 'NFT'
    };
  }

  /**
   * Add custom collection mapping
   */
  addCollectionMapping(contractAddress: string, name: string, hashtag: string): void {
    this.COLLECTION_NAMES[contractAddress.toLowerCase()] = { name, hashtag };
    logger.info(`Added collection mapping: ${contractAddress} -> ${name} (#${hashtag})`);
  }
}
