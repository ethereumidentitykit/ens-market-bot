/**
 * AutoTweetService - Handles automated posting of ENS sales to Twitter
 * Filters sales by timestamp, category, and ETH value before posting
 */

import { logger } from '../utils/logger';
import { ProcessedSale, IDatabaseService, ENSRegistration } from '../types';
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
  tweetId?: string;
  error?: string;
  skipped?: boolean;
  reason?: string;
  type?: 'sale' | 'registration'; // To distinguish between types
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
    
    if (registrationEthValue < settings.minEthRegistrations) {
      return {
        success: false,
        registrationId,
        skipped: true,
        reason: `${registration.costEth} ETH below minimum ${settings.minEthRegistrations} ETH for registrations`,
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
