import OAuth from 'oauth-1.0a';
import * as crypto from 'crypto-js';
import https from 'https';
import { config } from '../utils/config';
import { logger } from '../utils/logger';
import { APIToggleService } from './apiToggleService';

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
  private apiToggleService: APIToggleService;

  constructor() {
    this.apiToggleService = APIToggleService.getInstance();
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
   * Check if Twitter API is enabled via admin toggle
   */
  private checkApiEnabled(): boolean {
    if (!this.apiToggleService.isTwitterEnabled()) {
      logger.warn('Twitter API call blocked - API disabled via admin toggle');
      return false;
    }
    return true;
  }

  /**
   * Test Twitter API connection by verifying credentials
   */
  async testConnection(): Promise<{ success: boolean; user?: TwitterUser; error?: string }> {
    if (!this.checkApiEnabled()) {
      return { 
        success: false, 
        error: 'Twitter API is disabled via admin toggle' 
      };
    }

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
  async postTweet(content: string, imageBuffer?: Buffer): Promise<TwitterPostResult> {
    if (!this.checkApiEnabled()) {
      return { 
        success: false, 
        error: 'Twitter API is disabled via admin toggle' 
      };
    }

    try {
      // Validate content is not empty
      if (content.trim().length === 0) {
        const error = 'Tweet content cannot be empty';
        logger.error(error);
        return { success: false, error };
      }

      logger.info(`Posting tweet: "${content.substring(0, 50)}..."${imageBuffer ? ' with image' : ''}`);

      // If image is provided, upload it first
      let mediaId: string | undefined;
      if (imageBuffer) {
        const uploadedMediaId = await this.uploadMedia(imageBuffer);
        if (!uploadedMediaId) {
          return { success: false, error: 'Failed to upload image' };
        }
        mediaId = uploadedMediaId;
      }

      const requestData = {
        url: 'https://api.twitter.com/2/tweets',
        method: 'POST',
      };

      const token = {
        key: config.twitter.accessToken,
        secret: config.twitter.accessTokenSecret,
      };

      const authHeader = this.oauth.toHeader(this.oauth.authorize(requestData, token));
      
      const tweetData: any = { text: content };
      if (mediaId) {
        tweetData.media = { media_ids: [mediaId] };
      }
      
      const postData = JSON.stringify(tweetData);
      
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
   * Upload media to Twitter
   */
  private async uploadMedia(imageBuffer: Buffer): Promise<string | null> {
    try {
      logger.info('Uploading media to Twitter...');
      
      const requestData = {
        url: 'https://upload.twitter.com/1.1/media/upload.json',
        method: 'POST',
      };

      const token = {
        key: config.twitter.accessToken,
        secret: config.twitter.accessTokenSecret,
      };

      const authHeader = this.oauth.toHeader(this.oauth.authorize(requestData, token));
      
      const response = await this.uploadMediaRequest(
        requestData.url,
        authHeader.Authorization,
        imageBuffer
      );
      
      if (response.success && response.data) {
        const responseData = JSON.parse(response.data);
        
        if (responseData.media_id_string) {
          const mediaId = responseData.media_id_string;
          logger.info(`Media uploaded successfully - ID: ${mediaId}`);
          return mediaId;
        } else {
          logger.error('Unexpected media upload response format:', response.data);
          return null;
        }
      } else {
        logger.error('Failed to upload media:', response.error);
        return null;
      }
    } catch (error: any) {
      logger.error('Error uploading media:', error.message);
      return null;
    }
  }

  /**
   * Make multipart form request for media upload
   */
  private uploadMediaRequest(
    url: string,
    authHeader: string,
    imageBuffer: Buffer
  ): Promise<{ success: boolean; data?: string; error?: string }> {
    return new Promise((resolve) => {
      const urlObj = new URL(url);
      const boundary = `----formdata-twitter-${Date.now()}`;
      
      // Create multipart form data
      const formData = Buffer.concat([
        Buffer.from(`--${boundary}\r\n`),
        Buffer.from('Content-Disposition: form-data; name="media"; filename="image.png"\r\n'),
        Buffer.from('Content-Type: image/png\r\n\r\n'),
        imageBuffer,
        Buffer.from(`\r\n--${boundary}--\r\n`)
      ]);
      
      const options = {
        hostname: urlObj.hostname,
        path: urlObj.pathname + urlObj.search,
        method: 'POST',
        headers: {
          'Authorization': authHeader,
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
          'Content-Length': formData.length.toString(),
          'User-Agent': 'NFT-Sales-Bot/1.0',
        },
      };

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
            logger.error(`Twitter media upload error: ${error}`);
            resolve({ success: false, error });
          }
        });
      });

      req.on('error', (err) => {
        const error = `Request error: ${err.message}`;
        logger.error(`Twitter media upload request error: ${error}`);
        resolve({ success: false, error });
      });

      req.write(formData);
      req.end();
    });
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
