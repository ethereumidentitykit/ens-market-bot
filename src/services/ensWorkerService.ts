import axios from 'axios';
import { logger } from '../utils/logger';

export interface ENSWorkerAccount {
  name: string;
  address: string;
  avatar?: string;
  header?: string;
  display: string;
  records?: {
    avatar?: string;
    'com.discord'?: string;
    'com.github'?: string;
    'com.twitter'?: string;
    description?: string;
    email?: string;
    header?: string;
    'network.dm3.profile'?: string;
    'org.telegram'?: string;
    status?: string;
    url?: string;
  };
  chains?: {
    btc?: string;
    eth?: string;
  };
  fresh?: number;
  resolver?: string;
  errors?: any;
}

export interface ResolvedName {
  address: string;
  displayName: string;
  ensName?: string;
  hasEns: boolean;
}

export interface ResolvedProfile {
  address: string;
  displayName: string;
  ensName?: string;
  avatar?: string;
  hasEns: boolean;
}

/**
 * Service for resolving Ethereum addresses to ENS names using ENS Worker API
 * API Documentation: https://ens.ethfollow.xyz/u/{address}
 */
export class ENSWorkerService {
  private readonly baseUrl = 'https://enstate-prod-us-east-1.up.railway.app/u';
  private readonly cache = new Map<string, ResolvedName>();
  private readonly profileCache = new Map<string, { data: ResolvedProfile; timestamp: number }>();
  private readonly accountCache = new Map<string, { data: ENSWorkerAccount | null; timestamp: number }>();
  private readonly cacheTimeout = 5 * 60 * 1000; // 5 minutes cache

  /**
   * Resolve a single Ethereum address to its ENS name and display name
   */
  async resolveAddress(address: string): Promise<ResolvedName> {
    const normalizedAddress = address.toLowerCase();
    
    // Check cache first
    const cached = this.cache.get(normalizedAddress);
    if (cached) {
      return cached;
    }

    try {
      logger.debug(`Resolving address with ENS Worker: ${address}`);
      
      const response = await axios.get<ENSWorkerAccount>(
        `${this.baseUrl}/${address}`,
        {
          timeout: 10000, // 10 second timeout
          headers: {
            'Accept': 'application/json',
            'User-Agent': 'ENS-Sales-Bot/1.0'
          }
        }
      );

      const account = response.data;
      const resolved: ResolvedName = {
        address: normalizedAddress,
        displayName: this.getDisplayName(account),
        ensName: account.name,
        hasEns: !!account.name
      };

      // Cache the result
      this.cache.set(normalizedAddress, resolved);
      
      // Clear cache after timeout
      setTimeout(() => {
        this.cache.delete(normalizedAddress);
      }, this.cacheTimeout);

      logger.debug(`Resolved ${address} -> ${resolved.displayName} (ENS: ${resolved.hasEns})`);
      return resolved;

    } catch (error: any) {
      logger.warn(`Failed to resolve address ${address} with ENS Worker:`, error.message);
      
      // Return fallback with shortened address
      const fallback: ResolvedName = {
        address: normalizedAddress,
        displayName: this.shortenAddress(address),
        hasEns: false
      };
      
      // Cache the fallback to avoid repeated failed requests
      this.cache.set(normalizedAddress, fallback);
      setTimeout(() => {
        this.cache.delete(normalizedAddress);
      }, this.cacheTimeout);
      
      return fallback;
    }
  }

  /**
   * Get full profile information including avatar for an address
   */
  async getProfile(address: string): Promise<ResolvedProfile> {
    const normalizedAddress = address.toLowerCase();
    
    // Check cache first
    const cached = this.profileCache.get(normalizedAddress);
    if (cached && Date.now() - cached.timestamp < this.cacheTimeout) {
      logger.debug(`Using cached profile for ${address} -> ${cached.data.displayName}`);
      return cached.data;
    }
    
    try {
      logger.debug(`Getting profile with ENS Worker for address: ${address}`);
      
      const response = await axios.get<ENSWorkerAccount>(
        `${this.baseUrl}/${address}`,
        {
          timeout: 10000, // 10 second timeout
          headers: {
            'Accept': 'application/json',
            'User-Agent': 'ENS-Sales-Bot/1.0'
          }
        }
      );

      const account = response.data;
      
      // Get avatar from direct field or records
      const avatar = account.avatar || account.records?.avatar;
      
      const profile: ResolvedProfile = {
        address: normalizedAddress,
        displayName: this.getDisplayName(account),
        ensName: account.name,
        avatar: avatar,
        hasEns: !!account.name
      };

      logger.debug(`Got profile ${address} -> ${profile.displayName} (ENS: ${profile.hasEns}, Avatar: ${!!profile.avatar})`);
      
      // Cache the successful result
      this.profileCache.set(normalizedAddress, { data: profile, timestamp: Date.now() });
      
      return profile;

    } catch (error: any) {
      logger.info(`Failed to get profile for address ${address} with ENS Worker:`, error.message);
      
      // Return fallback with shortened address
      const fallback: ResolvedProfile = {
        address: normalizedAddress,
        displayName: this.shortenAddress(address),
        hasEns: false
      };
      
      // Cache the fallback result (shorter timeout for failed lookups)
      this.profileCache.set(normalizedAddress, { data: fallback, timestamp: Date.now() });
      
      return fallback;
    }
  }

  /**
   * Resolve multiple addresses in parallel (with rate limiting)
   */
  async resolveAddresses(addresses: string[]): Promise<ResolvedName[]> {
    const uniqueAddresses = [...new Set(addresses.map(addr => addr.toLowerCase()))];
    
    // Resolve in batches of 5 to avoid overwhelming the API
    const batchSize = 5;
    const results: ResolvedName[] = [];
    
    for (let i = 0; i < uniqueAddresses.length; i += batchSize) {
      const batch = uniqueAddresses.slice(i, i + batchSize);
      const batchPromises = batch.map(address => this.resolveAddress(address));
      
      try {
        const batchResults = await Promise.all(batchPromises);
        results.push(...batchResults);
        
        // Small delay between batches
        if (i + batchSize < uniqueAddresses.length) {
          await new Promise(resolve => setTimeout(resolve, 100));
        }
      } catch (error: any) {
        logger.error(`Failed to resolve address batch with ENS Worker:`, error.message);
        // Add fallbacks for failed batch
        batch.forEach(address => {
          results.push({
            address: address.toLowerCase(),
            displayName: this.shortenAddress(address),
            hasEns: false
          });
        });
      }
    }

    return results;
  }

  /**
   * Get the best display name for an account
   */
  private getDisplayName(account: ENSWorkerAccount): string {
    // Priority: display name > ENS name > shortened address
    if (account.display && account.display !== account.address) {
      return account.display;
    }
    
    if (account.name) {
      return account.name;
    }
    
    return this.shortenAddress(account.address);
  }

  /**
   * Shorten Ethereum address for display
   */
  private shortenAddress(address: string): string {
    if (!address || address.length < 10) return address;
    return `${address.substring(0, 6)}...${address.substring(address.length - 4)}`;
  }

  /**
   * Clear the address resolution cache
   */
  clearCache(): void {
    this.cache.clear();
    logger.info('ENS Worker cache cleared');
  }

  /**
   * Get cache statistics
   */
  getCacheStats(): { size: number; addresses: string[] } {
    return {
      size: this.cache.size,
      addresses: Array.from(this.cache.keys())
    };
  }

  /**
   * Get additional ENS records from the profile
   */
  async getENSRecords(address: string): Promise<ENSWorkerAccount['records'] | null> {
    try {
      const response = await axios.get<ENSWorkerAccount>(
        `${this.baseUrl}/${address}`,
        {
          timeout: 10000,
          headers: {
            'Accept': 'application/json',
            'User-Agent': 'ENS-Sales-Bot/1.0'
          }
        }
      );

      return response.data.records || null;
    } catch (error: any) {
      logger.warn(`Failed to get ENS records for address ${address}:`, error.message);
      return null;
    }
  }

  /**
   * Get social media handles from ENS records
   */
  async getSocialHandles(address: string): Promise<{
    twitter?: string;
    discord?: string;
    github?: string;
    telegram?: string;
  }> {
    const records = await this.getENSRecords(address);
    if (!records) return {};

    return {
      twitter: records['com.twitter'],
      discord: records['com.discord'],
      github: records['com.github'],
      telegram: records['org.telegram']
    };
  }

  /**
   * Get full account data (for compatibility with existing code that needs records)
   */
  async getFullAccountData(address: string): Promise<ENSWorkerAccount | null> {
    const normalizedAddress = address.toLowerCase();
    
    // Check cache first
    const cached = this.accountCache.get(normalizedAddress);
    if (cached && Date.now() - cached.timestamp < this.cacheTimeout) {
      logger.debug(`Using cached account data for ${address} -> ${cached.data?.name || 'no ENS'}`);
      return cached.data;
    }
    
    try {
      logger.debug(`Getting full account data with ENS Worker for address: ${address}`);
      
      const response = await axios.get<ENSWorkerAccount>(
        `${this.baseUrl}/${address}`,
        {
          timeout: 10000, // 30 second timeout
          headers: {
            'Accept': 'application/json',
            'User-Agent': 'ENS-Sales-Bot/1.0'
          }
        }
      );

      // Cache the successful result
      this.accountCache.set(normalizedAddress, { data: response.data, timestamp: Date.now() });

      return response.data;

    } catch (error: any) {
      logger.info(`Failed to get full account data for address ${address} with ENS Worker:`, error.message);
      
      // Cache the null result (shorter timeout for failed lookups)
      this.accountCache.set(normalizedAddress, { data: null, timestamp: Date.now() });
      
      return null;
    }
  }
}
