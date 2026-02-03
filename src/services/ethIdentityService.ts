import axios from 'axios';
import { logger } from '../utils/logger';

export interface EthIdentityAccount {
  address: string;
  ens?: {
    name: string;
    avatar?: string;
    records?: {
      name?: string;
      description?: string;
      avatar?: string;
      'com.twitter'?: string;
      'com.discord'?: string;
      email?: string;
      url?: string;
      'org.telegram'?: string;
    };
    updated_at?: string;
  };
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
 * Service for resolving Ethereum addresses to ENS names using EthIdentityKit API
 * API Documentation: https://ethidentitykit.com/docs/api/users/account
 */
export class EthIdentityService {
  private readonly baseUrl = 'https://data.ethfollow.xyz/api/v1';
  private readonly cache = new Map<string, ResolvedName>();
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
      logger.debug(`Resolving address: ${address}`);
      
      const response = await axios.get<EthIdentityAccount>(
        `${this.baseUrl}/users/${address}/account?cache=fresh`,
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
        ensName: account.ens?.name,
        hasEns: !!account.ens?.name
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
      logger.warn(`Failed to resolve address ${address}:`, error.message);
      
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
    
    try {
      logger.debug(`Getting profile for address: ${address}`);
      
      const response = await axios.get<EthIdentityAccount>(
        `${this.baseUrl}/users/${address}/account?cache=fresh`,
        {
          timeout: 10000, // 10 second timeout
          headers: {
            'Accept': 'application/json',
            'User-Agent': 'ENS-Sales-Bot/1.0'
          }
        }
      );

      const account = response.data;
      
      // Get avatar from ENS records
      const avatar = account.ens?.avatar || account.ens?.records?.avatar;
      
      const profile: ResolvedProfile = {
        address: normalizedAddress,
        displayName: this.getDisplayName(account),
        ensName: account.ens?.name,
        avatar: avatar,
        hasEns: !!account.ens?.name
      };

      logger.debug(`Got profile ${address} -> ${profile.displayName} (ENS: ${profile.hasEns}, Avatar: ${!!profile.avatar})`);
      return profile;

    } catch (error: any) {
      logger.warn(`Failed to get profile for address ${address}:`, error.message);
      
      // Return fallback with shortened address
      const fallback: ResolvedProfile = {
        address: normalizedAddress,
        displayName: this.shortenAddress(address),
        hasEns: false
      };
      
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
        logger.error(`Failed to resolve address batch:`, error.message);
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
  private getDisplayName(account: EthIdentityAccount): string {
    // Priority: ENS name > ENS display name > shortened address
    if (account.ens?.name) {
      return account.ens.name;
    }
    
    if (account.ens?.records?.name) {
      return account.ens.records.name;
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
    logger.info('EthIdentity cache cleared');
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
}
