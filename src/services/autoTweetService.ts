/**
 * AutoTweetService - Handles automated posting of ENS sales to Twitter
 * Filters sales by timestamp, category, and ETH value before posting
 */

import { logger } from '../utils/logger';
import { ProcessedSale, IDatabaseService, ENSRegistration, ENSBid } from '../types';
import { APIToggleService } from './apiToggleService';
import { NewTweetFormatter } from './newTweetFormatter';
import { TwitterService } from './twitterService';
import { RateLimitService } from './rateLimitService';
import { WorldTimeService } from './worldTimeService';

export interface AutoPostSettings {
  enabled: boolean;
  minEthDefault: number;
  minEth10kClub: number;
  minEth999Club: number;
  maxAgeHours: number;
  // Registration-specific settings
  registrationsEnabled: boolean;
  minEthRegistrations: number;
  maxAgeHoursRegistrations: number;
}

export interface PostResult {
  success: boolean;
  saleId?: number; // For sales
  registrationId?: number; // For registrations
  bidId?: number; // For bids
  tweetId?: string;
  error?: string;
  skipped?: boolean;
  reason?: string;
  type?: 'sale' | 'registration' | 'bid'; // To distinguish between types
}

export class AutoTweetService {
  private apiToggleService: APIToggleService;
  private newTweetFormatter: NewTweetFormatter;
  private twitterService: TwitterService;
  private rateLimitService: RateLimitService;
  private databaseService: IDatabaseService;
  private worldTimeService: WorldTimeService;

  // Category detection patterns
  private readonly CLUB_10K_PATTERN = /^\d{4}\.eth$/;  // e.g., 1234.eth
  private readonly CLUB_999_PATTERN = /^\d{3}\.eth$/;  // e.g., 123.eth

  constructor(
    newTweetFormatter: NewTweetFormatter,
    twitterService: TwitterService,
    rateLimitService: RateLimitService,
    databaseService: IDatabaseService,
    worldTimeService: WorldTimeService
  ) {
    this.apiToggleService = APIToggleService.getInstance();
    this.newTweetFormatter = newTweetFormatter;
    this.twitterService = twitterService;
    this.rateLimitService = rateLimitService;
    this.databaseService = databaseService;
    this.worldTimeService = worldTimeService;
  }

  /**
   * Process new sales for automated posting
   */
  async processNewSales(sales: ProcessedSale[], settings: AutoPostSettings): Promise<PostResult[]> {
    if (!settings.enabled) {
      logger.debug('Auto-posting is disabled');
      return [];
    }

    if (!this.apiToggleService.isTwitterEnabled()) {
      logger.warn('Cannot auto-post: Twitter API is disabled');
      return [];
    }

    if (!this.apiToggleService.isAutoPostingEnabled()) {
      logger.debug('Auto-posting is disabled via toggle');
      return [];
    }

    logger.info(`Processing ${sales.length} sales for auto-posting...`);
    
    const results: PostResult[] = [];
    
    for (const sale of sales) {
      try {
        const result = await this.processSingleSale(sale, settings);
        results.push(result);
        
        // Rate limiting: delay between posts to allow for image generation
        if (result.success) {
          logger.info('Tweet posted successfully, waiting 20 seconds before next post...');
          await this.delay(20000); // 20 second delay between successful posts (accounts for 5-8s image generation)
        }
      } catch (error: any) {
        logger.error(`Error processing sale ${sale.id}:`, error.message);
        results.push({
          success: false,
          saleId: sale.id!,
          error: error.message
        });
      }
    }

    const successful = results.filter(r => r.success).length;
    const skipped = results.filter(r => r.skipped).length;
    const failed = results.filter(r => !r.success && !r.skipped).length;

    logger.info(`Auto-posting results: ${successful} posted, ${skipped} skipped, ${failed} failed`);
    
    return results;
  }

  /**
   * Process new registrations for automated posting
   */
  async processNewRegistrations(registrations: ENSRegistration[], settings: AutoPostSettings): Promise<PostResult[]> {
    if (!settings.enabled || !settings.registrationsEnabled) {
      logger.debug('Registration auto-posting is disabled');
      return [];
    }

    if (!this.apiToggleService.isTwitterEnabled()) {
      logger.warn('Cannot auto-post registrations: Twitter API is disabled');
      return [];
    }

    if (!this.apiToggleService.isAutoPostingEnabled()) {
      logger.debug('Auto-posting is disabled via toggle');
      return [];
    }

    logger.info(`Processing ${registrations.length} registrations for auto-posting...`);
    
    const results: PostResult[] = [];
    
    for (const registration of registrations) {
      try {
        const result = await this.processSingleRegistration(registration, settings);
        results.push(result);
        
        // Rate limiting: delay between posts to allow for image generation
        if (result.success) {
          logger.info('Registration tweet posted successfully, waiting 20 seconds before next post...');
          await this.delay(20000); // 20 second delay between successful posts
        }
      } catch (error: any) {
        logger.error(`Error processing registration ${registration.id}:`, error.message);
        results.push({
          success: false,
          registrationId: registration.id!,
          error: error.message,
          type: 'registration'
        });
      }
    }

    const successful = results.filter(r => r.success).length;
    const skipped = results.filter(r => r.skipped).length;
    const failed = results.filter(r => !r.success && !r.skipped).length;

    logger.info(`Registration auto-posting results: ${successful} posted, ${skipped} skipped, ${failed} failed`);
    
    return results;
  }

  /**
   * Process a single sale for posting
   */
  private async processSingleSale(sale: ProcessedSale, settings: AutoPostSettings): Promise<PostResult> {
    const saleId = sale.id!;

    // Check if sale is too old
    if (!(await this.isWithinTimeLimit(sale, settings.maxAgeHours))) {
      return {
        success: false,
        saleId,
        skipped: true,
        reason: `Sale is older than ${settings.maxAgeHours} hours`,
        type: 'sale'
      };
    }

    // Check if sale meets ETH minimum requirements
    const ethMinimum = this.getEthMinimumForSale(sale, settings);
    const saleEthValue = parseFloat(sale.priceEth);
    
    if (saleEthValue < ethMinimum) {
      return {
        success: false,
        saleId,
        skipped: true,
        reason: `${sale.priceEth} ETH below minimum ${ethMinimum} ETH for ${this.getCategoryName(sale)}`,
        type: 'sale'
      };
    }

    // Check rate limits
    const rateLimitCheck = await this.rateLimitService.canPostTweet();
    if (!rateLimitCheck.canPost) {
      return {
        success: false,
        saleId,
        skipped: true,
        reason: `Rate limit exceeded: ${rateLimitCheck.postsInLast24Hours}/15 posts used`,
        type: 'sale'
      };
    }

    // Generate and post tweet
    logger.info(`Auto-posting sale: ${sale.nftName} for ${sale.priceEth} ETH`);
    
    try {
      // Generate tweet content and image
      const tweetData = await this.newTweetFormatter.generateTweet(sale);
      
      if (!tweetData.isValid) {
        return {
          success: false,
          saleId,
          error: 'Failed to generate valid tweet content',
          type: 'sale'
        };
      }

      // Post to Twitter
      const postResult = await this.twitterService.postTweet(
        tweetData.text, 
        tweetData.imageBuffer
      );

      if (postResult.success && postResult.tweetId) {
        // Record successful post
        await this.rateLimitService.recordTweetPost(
          postResult.tweetId,
          tweetData.text,
          saleId
        );

        logger.info(`Successfully auto-posted sale ${saleId} - Tweet ID: ${postResult.tweetId}`);
        
        return {
          success: true,
          saleId,
          tweetId: postResult.tweetId,
          type: 'sale'
        };
      } else {
        // Record failed post
        await this.rateLimitService.recordFailedTweetPost(
          tweetData.text,
          postResult.error || 'Unknown error',
          saleId
        );

        return {
          success: false,
          saleId,
          error: postResult.error || 'Failed to post tweet'
        };
      }
    } catch (error: any) {
      logger.error(`Error posting tweet for sale ${saleId}:`, error.message);
      return {
        success: false,
        saleId,
        error: error.message
      };
    }
  }

  /**
   * Process a single registration for posting
   */
  private async processSingleRegistration(registration: ENSRegistration, settings: AutoPostSettings): Promise<PostResult> {
    const registrationId = registration.id!;

    // Check if registration is too old
    if (!(await this.isWithinRegistrationTimeLimit(registration, settings.maxAgeHoursRegistrations))) {
      return {
        success: false,
        registrationId,
        skipped: true,
        reason: `Registration is older than ${settings.maxAgeHoursRegistrations} hours`,
        type: 'registration'
      };
    }

    // Check if registration meets ETH minimum requirements
    const registrationEthValue = parseFloat(registration.costEth || '0');
    const ethMinimum = this.getEthMinimumForRegistration(registration, settings);
    
    if (registrationEthValue < ethMinimum) {
      return {
        success: false,
        registrationId,
        skipped: true,
        reason: `${registration.costEth} ETH below minimum ${ethMinimum} ETH for ${this.getRegistrationCategoryName(registration)}`,
        type: 'registration'
      };
    }

    // Check rate limits
    const rateLimitCheck = await this.rateLimitService.canPostTweet();
    if (!rateLimitCheck.canPost) {
      return {
        success: false,
        registrationId,
        skipped: true,
        reason: `Rate limit exceeded: ${rateLimitCheck.postsInLast24Hours}/15 posts used`,
        type: 'registration'
      };
    }

    // Generate and post tweet
    logger.info(`Auto-posting registration: ${registration.ensName || registration.fullName} for ${registration.costEth} ETH`);
    
    try {
      // Generate tweet content and image
      const tweetData = await this.newTweetFormatter.generateRegistrationTweet(registration);
      
      if (!tweetData.isValid) {
        return {
          success: false,
          registrationId,
          error: 'Failed to generate valid registration tweet content',
          type: 'registration'
        };
      }

      // Post to Twitter
      const postResult = await this.twitterService.postTweet(
        tweetData.text, 
        tweetData.imageBuffer
      );

      if (postResult.success && postResult.tweetId) {
        // Record successful post
        await this.rateLimitService.recordTweetPost(
          postResult.tweetId,
          tweetData.text
        );

        // Mark registration as posted
        await this.databaseService.markRegistrationAsPosted(registrationId, postResult.tweetId);

        logger.info(`Successfully auto-posted registration ${registrationId} - Tweet ID: ${postResult.tweetId}`);
        
        return {
          success: true,
          registrationId,
          tweetId: postResult.tweetId,
          type: 'registration'
        };
      } else {
        // Record failed post
        await this.rateLimitService.recordFailedTweetPost(
          tweetData.text,
          postResult.error || 'Unknown error'
        );

        return {
          success: false,
          registrationId,
          error: postResult.error || 'Failed to post registration tweet',
          type: 'registration'
        };
      }
    } catch (error: any) {
      logger.error(`Error posting tweet for registration ${registrationId}:`, error.message);
      return {
        success: false,
        registrationId,
        error: error.message,
        type: 'registration'
      };
    }
  }

  /**
   * Check if sale is within the time limit using accurate UTC time
   */
  private async isWithinTimeLimit(sale: ProcessedSale, maxAgeHours: number): Promise<boolean> {
    const saleTimestamp = new Date(sale.blockTimestamp);
    const currentTime = await this.worldTimeService.getCurrentTime();
    const maxAgeMs = maxAgeHours * 60 * 60 * 1000;
    const ageMs = currentTime.getTime() - saleTimestamp.getTime();
    
    logger.debug(`Time check for sale ${sale.nftName || sale.tokenId}: sale=${saleTimestamp.toISOString()}, current=${currentTime.toISOString()}, age=${Math.round(ageMs/1000/60)}min, limit=${maxAgeHours}h`);
    
    return ageMs <= maxAgeMs;
  }

  /**
   * Check if registration is within the time limit using accurate UTC time
   */
  private async isWithinRegistrationTimeLimit(registration: ENSRegistration, maxAgeHours: number): Promise<boolean> {
    const registrationTimestamp = new Date(registration.blockTimestamp);
    const currentTime = await this.worldTimeService.getCurrentTime();
    const maxAgeMs = maxAgeHours * 60 * 60 * 1000;
    const ageMs = currentTime.getTime() - registrationTimestamp.getTime();
    
    logger.debug(`Time check for registration ${registration.ensName || registration.fullName}: registration=${registrationTimestamp.toISOString()}, current=${currentTime.toISOString()}, age=${Math.round(ageMs/1000/60)}min, limit=${maxAgeHours}h`);
    
    return ageMs <= maxAgeMs;
  }

  /**
   * Get ETH minimum requirement for a sale based on category
   */
  private getEthMinimumForSale(sale: ProcessedSale, settings: AutoPostSettings): number {
    const nftName = sale.nftName || '';
    
    if (this.CLUB_999_PATTERN.test(nftName)) {
      return settings.minEth999Club;
    } else if (this.CLUB_10K_PATTERN.test(nftName)) {
      return settings.minEth10kClub;
    } else {
      return settings.minEthDefault;
    }
  }

  /**
   * Get category name for logging/debugging
   */
  private getCategoryName(sale: ProcessedSale): string {
    const nftName = sale.nftName || '';
    
    if (this.CLUB_999_PATTERN.test(nftName)) {
      return '999 Club';
    } else if (this.CLUB_10K_PATTERN.test(nftName)) {
      return '10k Club';
    } else {
      return 'Standard';
    }
  }

  /**
   * Get ETH minimum requirement for a registration based on category
   */
  private getEthMinimumForRegistration(registration: ENSRegistration, settings: AutoPostSettings): number {
    const ensName = registration.fullName || registration.ensName || '';
    
    if (this.CLUB_999_PATTERN.test(ensName)) {
      return settings.minEth999Club;
    } else if (this.CLUB_10K_PATTERN.test(ensName)) {
      return settings.minEth10kClub;
    } else {
      return settings.minEthRegistrations; // Use registration-specific default
    }
  }

  /**
   * Get registration category name for logging/debugging
   */
  private getRegistrationCategoryName(registration: ENSRegistration): string {
    const ensName = registration.fullName || registration.ensName || '';
    
    if (this.CLUB_999_PATTERN.test(ensName)) {
      return '999 Club registration';
    } else if (this.CLUB_10K_PATTERN.test(ensName)) {
      return '10k Club registration';
    } else {
      return 'Standard registration';
    }
  }

  /**
   * Process array of ENS bids for auto-posting
   */
  async processNewBids(bids: ENSBid[], settings: AutoPostSettings): Promise<PostResult[]> {
    if (!settings.enabled) {
      logger.debug('Auto-posting is disabled');
      return [];
    }

    if (bids.length === 0) {
      logger.debug('No bids to process');
      return [];
    }

    logger.info(`🔄 Processing ${bids.length} new bids for auto-posting...`);
    const results: PostResult[] = [];

    for (const bid of bids) {
      if (!bid.id) {
        logger.warn('Skipping bid without ID:', bid);
        continue;
      }

      try {
        const result = await this.processSingleBid(bid, settings);
        results.push(result);
        
        // Rate limiting: delay between posts to allow for image generation
        if (result.success) {
          logger.info('Bid tweet posted successfully, waiting 20 seconds before next post...');
          await this.delay(20000);
        } else {
          // Still add a shorter delay for failed posts
          await this.delay(2000);
        }

      } catch (error: any) {
        logger.error(`Error processing bid ${bid.id}:`, error.message);
        results.push({
          success: false,
          bidId: bid.id,
          error: error.message,
          type: 'bid'
        });
      }
    }

    const successful = results.filter(r => r.success).length;
    const failed = results.filter(r => !r.success && !r.skipped).length;
    const skipped = results.filter(r => r.skipped).length;

    logger.info(`✅ Processed ${bids.length} bids: ${successful} posted, ${skipped} skipped, ${failed} failed`);
    return results;
  }

  /**
   * Process a single ENS bid for tweeting
   */
  private async processSingleBid(bid: ENSBid, settings: AutoPostSettings): Promise<PostResult> {
    const bidId = bid.id!;

    // Check if bid is too old (24 hours for bids - they're time-sensitive)
    if (!(await this.isWithinBidTimeLimit(bid, 24))) {
      return {
        success: false,
        bidId,
        skipped: true,
        reason: `Bid is older than 24 hours`,
        type: 'bid'
      };
    }

    // Check if bid meets ETH minimum requirements
    const bidEthValue = parseFloat(bid.priceDecimal);
    const ethMinimum = await this.getEthMinimumForBid(bid, settings);
    
    if (bidEthValue < ethMinimum) {
      return {
        success: false,
        bidId,
        skipped: true,
        reason: `Bid ETH value ${bidEthValue} below minimum ${ethMinimum} for ${await this.getBidCategoryName(bid)}`,
        type: 'bid'
      };
    }

    try {
      // Generate tweet content and image
      logger.info(`🔄 Generating tweet for bid ${bid.bidId}`);
      const tweetData = await this.newTweetFormatter.generateBidTweet(bid);

      if (!tweetData.isValid) {
        logger.error(`Invalid tweet generated for bid ${bidId}:`, tweetData.text);
        return {
          success: false,
          bidId,
          error: 'Generated tweet failed validation',
          type: 'bid'
        };
      }

      // Post to Twitter
      const postResult = await this.twitterService.postTweet(
        tweetData.text, 
        tweetData.imageBuffer
      );

      if (postResult.success && postResult.tweetId) {
        // Mark bid as posted
        await this.databaseService.markBidAsPosted(bidId, postResult.tweetId);

        logger.info(`✅ Successfully posted bid tweet: ${postResult.tweetId}`);
        
        return {
          success: true,
          bidId,
          tweetId: postResult.tweetId,
          type: 'bid'
        };
      } else {
        return {
          success: false,
          bidId,
          error: postResult.error || 'Failed to post bid tweet',
          type: 'bid'
        };
      }
    } catch (error: any) {
      logger.error(`Error posting tweet for bid ${bidId}:`, error.message);
      return {
        success: false,
        bidId,
        error: error.message,
        type: 'bid'
      };
    }
  }

  /**
   * Check if bid is within time limit (bids are time-sensitive)
   */
  private async isWithinBidTimeLimit(bid: ENSBid, maxAgeHours: number): Promise<boolean> {
    const bidTimestamp = new Date(bid.createdAtApi);
    const currentTime = await this.worldTimeService.getCurrentTime();
    const maxAgeMs = maxAgeHours * 60 * 60 * 1000;
    const ageMs = currentTime.getTime() - bidTimestamp.getTime();
    
    logger.debug(`Time check for bid ${bid.bidId}: created=${bidTimestamp.toISOString()}, current=${currentTime.toISOString()}, age=${Math.round(ageMs/1000/60)}min, limit=${maxAgeHours}h`);
    
    return ageMs <= maxAgeMs;
  }

  /**
   * Get ETH minimum requirement for a bid based on ENS name category
   */
  private async getEthMinimumForBid(bid: ENSBid, settings: AutoPostSettings): Promise<number> {
    try {
      // Get ENS name from bid (requires live lookup)
      let ensName = '';
      
      if (bid.tokenId) {
        try {
          const ensContract = '0x57f1887a8bf19b14fc0df6fd9b2acc9af147ea85';
          const metadataUrl = `https://metadata.ens.domains/mainnet/${ensContract}/${bid.tokenId}`;
          
          const response = await fetch(metadataUrl);
          if (response.ok) {
            const metadata = await response.json();
            ensName = metadata.name || '';
          }
        } catch (error) {
          // If resolution fails, use default threshold
          return settings.minEthDefault;
        }
      }

      // Apply club-aware logic (same patterns as sales/registrations)
      if (this.CLUB_999_PATTERN.test(ensName)) {
        return settings.minEth999Club;
      } else if (this.CLUB_10K_PATTERN.test(ensName)) {
        return settings.minEth10kClub;
      } else {
        return settings.minEthDefault; // Use general default for bids
      }

    } catch (error: any) {
      logger.warn(`Error determining ETH minimum for bid:`, error.message);
      return settings.minEthDefault;
    }
  }

  /**
   * Get bid category name for logging/debugging
   */
  private async getBidCategoryName(bid: ENSBid): Promise<string> {
    try {
      let ensName = '';
      
      if (bid.tokenId) {
        try {
          const ensContract = '0x57f1887a8bf19b14fc0df6fd9b2acc9af147ea85';
          const metadataUrl = `https://metadata.ens.domains/mainnet/${ensContract}/${bid.tokenId}`;
          
          const response = await fetch(metadataUrl);
          if (response.ok) {
            const metadata = await response.json();
            ensName = metadata.name || '';
          }
        } catch (error) {
          return 'Standard bid';
        }
      }

      if (this.CLUB_999_PATTERN.test(ensName)) {
        return '999 Club bid';
      } else if (this.CLUB_10K_PATTERN.test(ensName)) {
        return '10k Club bid';
      } else {
        return 'Standard bid';
      }

    } catch (error: any) {
      return 'Standard bid';
    }
  }

  /**
   * Simple delay utility
   */
  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Load auto-posting settings from database
   */
  async getSettings(): Promise<AutoPostSettings> {
    try {
      const minEthDefault = await this.databaseService.getSystemState('autopost_min_eth_default') || '0.1';
      const minEth10kClub = await this.databaseService.getSystemState('autopost_min_eth_10k') || '0.5';
      const minEth999Club = await this.databaseService.getSystemState('autopost_min_eth_999') || '5';
      const maxAgeHours = await this.databaseService.getSystemState('autopost_max_age_hours') || '1';
      
      // Registration-specific settings
      const registrationsEnabled = await this.databaseService.getSystemState('autopost_registrations_enabled') || 'true';
      const minEthRegistrations = await this.databaseService.getSystemState('autopost_min_eth_registrations') || '0.1';
      const maxAgeHoursRegistrations = await this.databaseService.getSystemState('autopost_max_age_hours_registrations') || '2';
      
      return {
        enabled: this.apiToggleService.isAutoPostingEnabled(),
        minEthDefault: parseFloat(minEthDefault),
        minEth10kClub: parseFloat(minEth10kClub),
        minEth999Club: parseFloat(minEth999Club),
        maxAgeHours: parseInt(maxAgeHours),
        // Registration settings
        registrationsEnabled: registrationsEnabled === 'true',
        minEthRegistrations: parseFloat(minEthRegistrations),
        maxAgeHoursRegistrations: parseInt(maxAgeHoursRegistrations)
      };
    } catch (error: any) {
      logger.warn('Failed to load auto-post settings from database, using defaults:', error.message);
      return {
        enabled: false,
        minEthDefault: 0.1,
        minEth10kClub: 0.5,
        minEth999Club: 0.3,
        maxAgeHours: 1,
        // Registration defaults
        registrationsEnabled: true,
        minEthRegistrations: 0.01,
        maxAgeHoursRegistrations: 2
      };
    }
  }

  /**
   * Get default settings (for backwards compatibility)
   */
  getDefaultSettings(): AutoPostSettings {
    return {
      enabled: false,
      minEthDefault: 0.1,
      minEth10kClub: 0.5,
      minEth999Club: 0.3,
      maxAgeHours: 1,
      registrationsEnabled: true,
      minEthRegistrations: 0.01,
      maxAgeHoursRegistrations: 2
    };
  }

  /**
   * Refresh NTP time cache (called by scheduler)
   */
  public async refreshTimeCache(): Promise<void> {
    await this.worldTimeService.refreshTime();
  }
}
