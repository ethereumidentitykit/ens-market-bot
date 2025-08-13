/**
 * WorldTimeService - Provides accurate UTC time from NTP servers
 * Uses reliable NTP protocol instead of HTTP APIs for better connectivity
 */

// @ts-ignore - ntp-client doesn't have type definitions
import * as ntpClient from 'ntp-client';
import { logger } from '../utils/logger';

export class WorldTimeService {
  private cachedTime: Date | null = null;
  private lastFetch: Date | null = null;
  private fetchInterval: NodeJS.Timeout | null = null;
  private readonly CACHE_DURATION_MS = 60 * 1000; // 1 minute
  
  // Reliable NTP servers from major providers
  private readonly NTP_SERVERS = [
    'time.google.com',           // Google Public NTP
    'time.cloudflare.com',       // Cloudflare NTP
    'time.apple.com',            // Apple NTP
    'pool.ntp.org',              // NTP Pool Project
    'time.nist.gov',             // NIST Internet Time Service
    'time.windows.com',          // Microsoft NTP
  ];
  
  // Offset correction approach for when NTP fails
  private timeOffsetMs: number = 0; // Difference between machine time and actual UTC
  private offsetCalculated: boolean = false;
  private currentServerIndex: number = 0;

  constructor() {
    // Start the periodic fetch
    this.startPeriodicFetch();
  }

  /**
   * Get current accurate UTC time
   * Returns cached time if fresh, otherwise fetches new time
   */
  async getCurrentTime(): Promise<Date> {
    // If we have fresh cached time, calculate current time based on it
    if (this.cachedTime && this.lastFetch) {
      const timeSinceLastFetch = Date.now() - this.lastFetch.getTime();
      
      // If cache is still fresh (less than 1 minute old), use it
      if (timeSinceLastFetch < this.CACHE_DURATION_MS) {
        const currentTime = new Date(this.cachedTime.getTime() + timeSinceLastFetch);
        return currentTime;
      }
    }

    // Cache is stale or doesn't exist, fetch fresh time
    await this.fetchCurrentTime();
    
    // Return the newly cached time or corrected machine time if NTP failed
    return this.getCorrectedTime();
  }

  /**
   * Get corrected time using offset if available, otherwise machine time
   */
  private getCorrectedTime(): Date {
    if (this.cachedTime) {
      return this.cachedTime;
    }
    
    // If we have calculated an offset, use it to correct machine time
    if (this.offsetCalculated) {
      const correctedTime = new Date(Date.now() - this.timeOffsetMs);
      logger.debug(`Using offset-corrected time: ${correctedTime.toISOString()} (offset: ${this.timeOffsetMs}ms)`);
      return correctedTime;
    }
    
    // Last resort: machine time
    logger.warn('Using uncorrected machine time as fallback');
    return new Date();
  }

  /**
   * Fetch current UTC time from NTP servers
   */
  private async fetchCurrentTime(): Promise<void> {
    // Try each NTP server in sequence
    for (let attempt = 0; attempt < this.NTP_SERVERS.length; attempt++) {
      const serverIndex = (this.currentServerIndex + attempt) % this.NTP_SERVERS.length;
      const server = this.NTP_SERVERS[serverIndex];
      
      try {
        logger.debug(`Fetching time from NTP server ${serverIndex + 1}/${this.NTP_SERVERS.length}: ${server}`);
        
        const ntpTime = await this.queryNtpServer(server);
        const machineTime = new Date();
        
        // Calculate offset between NTP time and machine time
        this.timeOffsetMs = machineTime.getTime() - ntpTime.getTime();
        this.offsetCalculated = true;
        
        // Cache the NTP time
        this.cachedTime = ntpTime;
        this.lastFetch = machineTime; // Use machine time for tracking when we fetched
        
        // Update server index for next fetch (round-robin)
        this.currentServerIndex = (serverIndex + 1) % this.NTP_SERVERS.length;

        logger.info(`Successfully fetched time from NTP server: ${server}`);
        logger.debug(`NTP time: ${ntpTime.toISOString()}, Machine time: ${machineTime.toISOString()}, Offset: ${this.timeOffsetMs}ms`);
        
        return; // Success, exit the loop
        
      } catch (error: any) {
        logger.warn(`Failed to fetch time from NTP server ${server}: ${error.message}`);
        
        // If this was the last server and we still don't have any time reference
        if (attempt === this.NTP_SERVERS.length - 1) {
          if (!this.cachedTime && !this.offsetCalculated) {
            logger.warn('All NTP servers failed and no cached time available, using machine time');
            this.cachedTime = new Date();
            this.lastFetch = new Date();
          } else {
            logger.info('NTP servers failed but using previously calculated offset or cached time');
          }
        }
      }
    }
  }

  /**
   * Query a single NTP server
   */
  private queryNtpServer(server: string): Promise<Date> {
    return new Promise((resolve, reject) => {
      // Type the callback explicitly since ntp-client has no types
      const callback = (err: any, date: any) => {
        if (err || !date) {
          reject(err || new Error('No date returned from NTP server'));
        } else {
          resolve(new Date(date));
        }
      };
      
      (ntpClient as any).getNetworkTime(server, 123, callback);
    });
  }

  /**
   * Start periodic fetching of time every minute
   */
  private startPeriodicFetch(): void {
    // Fetch immediately on startup
    this.fetchCurrentTime();

    // Set up interval to fetch every minute
    this.fetchInterval = setInterval(() => {
      this.fetchCurrentTime();
    }, this.CACHE_DURATION_MS);

    logger.info('WorldTimeService started - fetching UTC time from NTP servers every minute');
  }

  /**
   * Stop the periodic fetching (for cleanup)
   */
  public stop(): void {
    if (this.fetchInterval) {
      clearInterval(this.fetchInterval);
      this.fetchInterval = null;
      logger.info('WorldTimeService stopped');
    }
  }

  /**
   * Get the time offset between machine time and NTP time
   * Useful for debugging time sync issues
   */
  public getTimeOffset(): number | null {
    return this.offsetCalculated ? this.timeOffsetMs : null;
  }

  /**
   * Check if the time service is healthy
   */
  public isHealthy(): boolean {
    // Healthy if we have either fresh cached time or a calculated offset
    const hasFreshCache = this.cachedTime && this.lastFetch && 
      (Date.now() - this.lastFetch.getTime()) < (this.CACHE_DURATION_MS * 2);
    
    return hasFreshCache || this.offsetCalculated;
  }

  /**
   * Get service status for debugging
   */
  public getStatus(): {
    healthy: boolean;
    cachedTime: string | null;
    lastFetch: string | null;
    offsetMs: number | null;
    offsetCalculated: boolean;
    currentServer: string;
  } {
    return {
      healthy: this.isHealthy(),
      cachedTime: this.cachedTime?.toISOString() || null,
      lastFetch: this.lastFetch?.toISOString() || null,
      offsetMs: this.getTimeOffset(),
      offsetCalculated: this.offsetCalculated,
      currentServer: this.NTP_SERVERS[this.currentServerIndex]
    };
  }
}