import OAuth from 'oauth-1.0a';
import * as crypto from 'crypto-js';
import https from 'https';
import { config } from '../utils/config';
import { logger } from '../utils/logger';

export interface TwitterPostResult {
  success: boolean;
  tweetId?: string;
  error?: string;
}

export interface TwitterUser {
  id: string;
  username: string;
  name: string;
}

export class TwitterService {
  private oauth: OAuth;

  constructor() {
    this.oauth = new OAuth({
      consumer: { 
        key: config.twitter.apiKey, 
        secret: config.twitter.apiSecret 
      },
      signature_method: 'HMAC-SHA1',
      hash_function(base_string: string, key: string): string {
        return crypto.HmacSHA1(base_string, key).toString(crypto.enc.Base64);
      },
    });
  }

  /**
   * Test Twitter API connection by verifying credentials
   */
  async testConnection(): Promise<{ success: boolean; user?: TwitterUser; error?: string }> {
    try {
      logger.info('Testing Twitter API connection...');
      
      const requestData = {
        url: 'https://api.twitter.com/2/users/me',
        method: 'GET',
      };

      const token = {
        key: config.twitter.accessToken,
        secret: config.twitter.accessTokenSecret,
      };

      const authHeader = this.oauth.toHeader(this.oauth.authorize(requestData, token));
      
      const response = await this.makeRequest(requestData.url, 'GET', authHeader.Authorization);
      
      if (response.success && response.data) {
        const responseData = JSON.parse(response.data);
        if (responseData.data) {
          const user: TwitterUser = {
            id: responseData.data.id,
            username: responseData.data.username,
            name: responseData.data.name,
          };
          
          logger.info(`Twitter API connection successful - authenticated as @${user.username}`);
          return { success: true, user };
        } else {
          logger.error('Unexpected Twitter API response format:', response.data);
          return { success: false, error: 'Unexpected API response format' };
        }
      } else {
        logger.error('Twitter API connection failed:', response.error);
        return { success: false, error: response.error };
      }
    } catch (error: any) {
      logger.error('Error testing Twitter connection:', error.message);
      return { success: false, error: error.message };
    }
  }

  /**
   * Post a tweet to Twitter
   */
  async postTweet(content: string): Promise<TwitterPostResult> {
    try {
      // Validate content length
      if (content.length > 280) {
        const error = `Tweet content too long: ${content.length} characters (max 280)`;
        logger.error(error);
        return { success: false, error };
      }

      if (content.trim().length === 0) {
        const error = 'Tweet content cannot be empty';
        logger.error(error);
        return { success: false, error };
      }

      logger.info(`Posting tweet: "${content.substring(0, 50)}..."`);

      const requestData = {
        url: 'https://api.twitter.com/2/tweets',
        method: 'POST',
      };

      const token = {
        key: config.twitter.accessToken,
        secret: config.twitter.accessTokenSecret,
      };

      const authHeader = this.oauth.toHeader(this.oauth.authorize(requestData, token));
      
      const postData = JSON.stringify({ text: content });
      
      const response = await this.makeRequest(
        requestData.url, 
        'POST', 
        authHeader.Authorization,
        postData,
        { 'Content-Type': 'application/json' }
      );
      
      if (response.success && response.data) {
        const responseData = JSON.parse(response.data);
        
        if (responseData.data && responseData.data.id) {
          const tweetId = responseData.data.id;
          logger.info(`Tweet posted successfully - ID: ${tweetId}`);
          return { success: true, tweetId };
        } else {
          logger.error('Unexpected Twitter API response format:', response.data);
          return { success: false, error: 'Unexpected API response format' };
        }
      } else {
        logger.error('Failed to post tweet:', response.error);
        return { success: false, error: response.error };
      }
    } catch (error: any) {
      logger.error('Error posting tweet:', error.message);
      return { success: false, error: error.message };
    }
  }

  /**
   * Make HTTP request with OAuth authentication
   */
  private makeRequest(
    url: string, 
    method: 'GET' | 'POST', 
    authHeader: string,
    postData?: string,
    additionalHeaders?: Record<string, string>
  ): Promise<{ success: boolean; data?: string; error?: string }> {
    return new Promise((resolve) => {
      const urlObj = new URL(url);
      
      const options = {
        hostname: urlObj.hostname,
        path: urlObj.pathname + urlObj.search,
        method,
        headers: {
          'Authorization': authHeader,
          'User-Agent': 'NFT-Sales-Bot/1.0',
          ...additionalHeaders,
        } as Record<string, string>,
      };

      if (postData) {
        options.headers['Content-Length'] = Buffer.byteLength(postData).toString();
      }

      const req = https.request(options, (res) => {
        let data = '';
        
        res.on('data', (chunk) => {
          data += chunk;
        });
        
        res.on('end', () => {
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
            resolve({ success: true, data });
          } else {
            const error = `HTTP ${res.statusCode}: ${data}`;
            logger.error(`Twitter API error: ${error}`);
            resolve({ success: false, error });
          }
        });
      });

      req.on('error', (err) => {
        const error = `Request error: ${err.message}`;
        logger.error(`Twitter API request error: ${error}`);
        resolve({ success: false, error });
      });

      if (postData) {
        req.write(postData);
      }
      
      req.end();
    });
  }

  /**
   * Validate Twitter API configuration
   */
  validateConfig(): { valid: boolean; missingFields: string[] } {
    const requiredFields = [
      { field: 'apiKey', value: config.twitter.apiKey },
      { field: 'apiSecret', value: config.twitter.apiSecret },
      { field: 'accessToken', value: config.twitter.accessToken },
      { field: 'accessTokenSecret', value: config.twitter.accessTokenSecret },
    ];

    const missingFields = requiredFields
      .filter(({ value }) => !value || value.trim().length === 0)
      .map(({ field }) => field);

    return {
      valid: missingFields.length === 0,
      missingFields,
    };
  }
}
