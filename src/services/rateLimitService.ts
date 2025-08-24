import { IDatabaseService, TwitterPost } from '../types';
import { logger } from '../utils/logger';

export interface RateLimitStatus {
  postsInLast24Hours: number;
  remainingPosts: number;
  limitReached: boolean;
  resetTime: string;
  canPost: boolean;
}

export class RateLimitService {
  private readonly DAILY_LIMIT = 100; // 100 posts per 24 hours (updated API plan)
  private databaseService: IDatabaseService;

  constructor(databaseService: IDatabaseService) {
    this.databaseService = databaseService;
  }

  /**
   * Get the daily limit for tweet posts
   */
  getDailyLimit(): number {
    return this.DAILY_LIMIT;
  }

  /**
   * Check if we can post a tweet (under rate limit)
   */
  async canPostTweet(): Promise<RateLimitStatus> {
    try {
      const postsInLast24Hours = await this.databaseService.getTweetPostsInLast24Hours();
      const remainingPosts = Math.max(0, this.DAILY_LIMIT - postsInLast24Hours);
      const limitReached = postsInLast24Hours >= this.DAILY_LIMIT;
      const canPost = !limitReached;

      // Calculate reset time (24 hours from the oldest post in the current window)
      const recentPosts = await this.databaseService.getRecentTweetPosts(24);
      let resetTime = new Date(Date.now() + 24 * 60 * 60 * 1000); // Default: 24 hours from now
      
      if (recentPosts.length > 0) {
        // Reset time is 24 hours after the oldest post in the current window
        const oldestPost = recentPosts[recentPosts.length - 1];
        resetTime = new Date(new Date(oldestPost.postedAt).getTime() + 24 * 60 * 60 * 1000);
      }

      const status: RateLimitStatus = {
        postsInLast24Hours,
        remainingPosts,
        limitReached,
        resetTime: resetTime.toISOString(),
        canPost
      };

      // Only log rate limit status when specifically requested (not for routine checks)
      return status;
    } catch (error: any) {
      logger.error('Failed to check rate limit status:', error.message);
      throw error;
    }
  }

  /**
   * Record a successful tweet post
   */
  async recordTweetPost(tweetId: string, tweetContent: string, saleId?: number): Promise<void> {
    try {
      const post: Omit<TwitterPost, 'id'> = {
        saleId,
        tweetId,
        tweetContent,
        postedAt: new Date().toISOString(),
        success: true
      };

      await this.databaseService.recordTweetPost(post);
      
      // Log rate limit status after posting a tweet
      const status = await this.canPostTweet();
      logger.info(`Tweet posted successfully: ${tweetId}`);
      logger.info(`Rate limit status: ${status.postsInLast24Hours}/${this.DAILY_LIMIT} posts used, ${status.remainingPosts} remaining`);
    } catch (error: any) {
      logger.error('Failed to record tweet post:', error.message);
      throw error;
    }
  }

  /**
   * Record a failed tweet post attempt
   */
  async recordFailedTweetPost(tweetContent: string, errorMessage: string, saleId?: number): Promise<void> {
    try {
      const post: Omit<TwitterPost, 'id'> = {
        saleId,
        tweetId: 'failed', // Use 'failed' as placeholder for failed posts
        tweetContent,
        postedAt: new Date().toISOString(),
        success: false,
        errorMessage
      };

      await this.databaseService.recordTweetPost(post);
      
      // Log rate limit status after failed tweet attempt
      const status = await this.canPostTweet();
      logger.warn(`Tweet posting failed: ${errorMessage}`);
      logger.info(`Rate limit status: ${status.postsInLast24Hours}/${this.DAILY_LIMIT} posts used, ${status.remainingPosts} remaining`);
    } catch (error: any) {
      logger.error('Failed to record failed tweet post:', error.message);
      throw error;
    }
  }

  /**
   * Get recent tweet posting history
   */
  async getRecentTweetHistory(hoursBack: number = 24): Promise<TwitterPost[]> {
    try {
      return await this.databaseService.getRecentTweetPosts(hoursBack);
    } catch (error: any) {
      logger.error('Failed to get recent tweet history:', error.message);
      throw error;
    }
  }

  /**
   * Get detailed rate limit information for admin dashboard
   */
  async getDetailedRateLimitInfo(): Promise<{
    status: RateLimitStatus;
    recentPosts: TwitterPost[];
    dailyLimit: number;
  }> {
    try {
      const status = await this.canPostTweet();
      const recentPosts = await this.getRecentTweetHistory(24);

      return {
        status,
        recentPosts: recentPosts.slice(0, 10), // Last 10 posts
        dailyLimit: this.DAILY_LIMIT
      };
    } catch (error: any) {
      logger.error('Failed to get detailed rate limit info:', error.message);
      throw error;
    }
  }

  /**
   * Validate if a tweet post is allowed (throws error if not)
   */
  async validateTweetPost(): Promise<void> {
    const status = await this.canPostTweet();
    
    if (!status.canPost) {
      const resetTimeFormatted = new Date(status.resetTime).toLocaleString();
      throw new Error(
        `Rate limit exceeded: ${status.postsInLast24Hours}/${this.DAILY_LIMIT} posts used in last 24 hours. ` +
        `Next post available after: ${resetTimeFormatted}`
      );
    }
  }

}
