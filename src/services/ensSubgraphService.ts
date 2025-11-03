import axios from 'axios';
import { logger } from '../utils/logger';
import { ENSTokenUtils } from './ensTokenUtils';

const ENS_SUBGRAPH_URL_PRIMARY = 'https://ensnode-api-production-500f.up.railway.app/subgraph';
const ENS_SUBGRAPH_URL_BACKUP = 'https://api.mainnet.ensnode.io/subgraph';

/**
 * In-house ENS Subgraph Service
 * Provides fast, reliable ENS name lookups via internal subgraph API
 * Features automatic failover to backup endpoint
 */
export class EnsSubgraphService {
  private primaryUrl: string;
  private backupUrl: string;

  constructor(primaryUrl: string = ENS_SUBGRAPH_URL_PRIMARY, backupUrl: string = ENS_SUBGRAPH_URL_BACKUP) {
    this.primaryUrl = primaryUrl;
    this.backupUrl = backupUrl;
    logger.info(`🔧 EnsSubgraphService initialized with primary: ${primaryUrl}, backup: ${backupUrl}`);
  }

  /**
   * Query ENS name by token ID
   * Supports both ENS Registry (labelhash) and Name Wrapper (namehash)
   * Features automatic failover to backup endpoint
   * 
   * @param tokenId - ENS token ID (numeric string)
   * @param contractAddress - Optional contract address to determine lookup method
   * @returns ENS name or null if not found
   */
  async getNameByTokenId(tokenId: string, contractAddress?: string): Promise<string | null> {
    // Convert numeric token ID to hex hash using proper conversion
      const hexHash = this.tokenIdToHex(tokenId);
      
      // Determine which field to query based on contract
      const isWrapper = contractAddress?.toLowerCase() === ENSTokenUtils.NAME_WRAPPER_CONTRACT.toLowerCase();
      const hashType = isWrapper ? 'namehash (wrapper)' : 'labelhash (registry)';
    
    logger.debug(`🔍 Querying ENS subgraph: tokenId ${tokenId.slice(-10)}, contract ${contractAddress?.slice(0, 10)}, hex: ${hexHash.slice(0, 10)}..., type: ${hashType}`);
      
      // For wrapper names, query by ID (namehash)
      // For registry names, query by labelhash
      const query = isWrapper
        ? `
          query GetDomainByNamehash($id: String!) {
            domains(where: { id: $id }, first: 1) {
              id
              name
              labelName
            }
          }
        `
        : `
          query GetDomainByLabelhash($labelhash: String!) {
            domains(where: { labelhash: $labelhash }, first: 1) {
              id
              name
              labelName
              labelhash
            }
          }
        `;

    const variables = isWrapper 
      ? { id: hexHash }
      : { labelhash: hexHash };

    // Try primary endpoint first, then backup
    const endpoints = [this.primaryUrl, this.backupUrl];
    
    for (let i = 0; i < endpoints.length; i++) {
      const endpoint = endpoints[i];
      const isPrimary = i === 0;
      
      try {
        logger.debug(`   ${isPrimary ? '🎯' : '🔄'} Trying ${isPrimary ? 'primary' : 'backup'} endpoint: ${endpoint}`);
        
        // LOG THE FULL QUERY AND VARIABLES
        logger.info(`📋 GRAPHQL QUERY:\n${query}`);
        logger.info(`📋 GRAPHQL VARIABLES: ${JSON.stringify(variables, null, 2)}`);
        
        const response = await axios.post(
          endpoint,
          { query, variables },
          {
            timeout: 2000, // 2s timeout
            headers: {
              'Content-Type': 'application/json',
            }
          }
        );

        // LOG THE FULL RESPONSE
        logger.info(`📋 GRAPHQL RESPONSE: ${JSON.stringify(response.data, null, 2)}`);

        const domains = response.data?.data?.domains;
      
      if (domains && domains.length > 0) {
        const domain = domains[0];
        
        if (domain.name) {
            logger.debug(`✅ ENS subgraph resolved: ${domain.name} (${hashType}: ${hexHash.slice(0, 10)}...) via ${isPrimary ? 'primary' : 'backup'}`);
          return domain.name;
        }
        
        // Try labelName if name is not available
        if (domain.labelName) {
          const name = `${domain.labelName}.eth`;
            logger.debug(`✅ ENS subgraph resolved via labelName: ${name} (${hashType}: ${hexHash.slice(0, 10)}...) via ${isPrimary ? 'primary' : 'backup'}`);
          return name;
        }
      }

        logger.debug(`⚠️ ENS subgraph: no name found for ${hashType} ${hexHash.slice(0, 10)}... at ${isPrimary ? 'primary' : 'backup'}`);
        
        // If we got a valid response but no data, don't try backup
      return null;

    } catch (error: any) {
        logger.debug(`⚠️ ENS subgraph ${isPrimary ? 'primary' : 'backup'} failed: ${error.message}`);
        
        // If this is the primary and we have a backup, continue to backup
        if (isPrimary) {
          logger.debug(`   🔄 Falling back to backup endpoint...`);
          continue;
        }
        
        // Both endpoints failed
      return null;
    }
    }
    
    return null;
  }

  /**
   * Convert numeric token ID to hex hash
   * 
   * @param tokenId - Numeric token ID string
   * @returns Hex hash with 0x prefix, padded to 66 characters, lowercase
   */
  private tokenIdToHex(tokenId: string): string {
    // Convert to BigInt, then to hex (lowercase)
    const bigIntValue = BigInt(tokenId);
    let hexString = bigIntValue.toString(16).toLowerCase();
    
    // Pad to 64 hex characters (256 bits)
    hexString = hexString.padStart(64, '0');
    
    // Add 0x prefix
    return `0x${hexString}`;
  }

  /**
   * Query ENS name by labelhash (hex format)
   * Features automatic failover to backup endpoint
   * 
   * @param labelhash - ENS labelhash in hex format (with or without 0x prefix)
   * @returns ENS name or null if not found
   */
  async getNameByLabelhash(labelhash: string): Promise<string | null> {
      // Ensure 0x prefix and lowercase
      const normalizedLabelhash = labelhash.startsWith('0x') 
        ? labelhash.toLowerCase() 
        : `0x${labelhash.toLowerCase()}`;
      
      const query = `
        query GetDomainByLabelhash($labelhash: String!) {
          domains(where: { labelhash: $labelhash }, first: 1) {
            name
            labelName
            labelhash
          }
        }
      `;

    // Try primary endpoint first, then backup
    const endpoints = [this.primaryUrl, this.backupUrl];
    
    for (let i = 0; i < endpoints.length; i++) {
      const endpoint = endpoints[i];
      const isPrimary = i === 0;
      
      try {
      const response = await axios.post(
          endpoint,
        {
          query,
          variables: { labelhash: normalizedLabelhash }
        },
        {
          timeout: 2000,
          headers: {
            'Content-Type': 'application/json',
          }
        }
      );

      const domains = response.data?.data?.domains;
      
      if (domains && domains.length > 0) {
        const domain = domains[0];
        
        if (domain.name) {
            logger.debug(`✅ ENS subgraph resolved via labelhash: ${domain.name} (${isPrimary ? 'primary' : 'backup'})`);
          return domain.name;
        }
        
        if (domain.labelName) {
          const name = `${domain.labelName}.eth`;
            logger.debug(`✅ ENS subgraph resolved via labelhash + labelName: ${name} (${isPrimary ? 'primary' : 'backup'})`);
          return name;
        }
      }

        logger.debug(`⚠️ ENS subgraph: no name found for labelhash ${labelhash.slice(-10)} at ${isPrimary ? 'primary' : 'backup'}`);
      return null;

    } catch (error: any) {
        logger.debug(`⚠️ ENS subgraph labelhash query ${isPrimary ? 'primary' : 'backup'} failed: ${error.message}`);
        
        // If this is the primary and we have a backup, continue to backup
        if (isPrimary) {
          continue;
        }
        
      return null;
    }
    }
    
    return null;
  }

  /**
   * Health check for the subgraph service
   * Tests both primary and backup endpoints
   * 
   * @returns true if at least one endpoint is reachable, false otherwise
   */
  async healthCheck(): Promise<boolean> {
      const query = `
        query {
          domains(first: 1) {
            id
          }
        }
      `;

    // Try primary endpoint first
    try {
      const response = await axios.post(
        this.primaryUrl,
        { query },
        {
          timeout: 3000,
          headers: {
            'Content-Type': 'application/json',
          }
        }
      );

      if (response.status === 200 && !!response.data?.data) {
        logger.debug(`✅ ENS subgraph primary endpoint healthy`);
        return true;
      }
    } catch (error: any) {
      logger.warn(`⚠️ ENS subgraph primary health check failed: ${error.message}, trying backup...`);
    }

    // Try backup endpoint
    try {
      const response = await axios.post(
        this.backupUrl,
        { query },
        {
          timeout: 3000,
          headers: {
            'Content-Type': 'application/json',
          }
        }
      );

      if (response.status === 200 && !!response.data?.data) {
        logger.debug(`✅ ENS subgraph backup endpoint healthy`);
        return true;
      }
    } catch (error: any) {
      logger.error(`❌ ENS subgraph backup health check failed: ${error.message}`);
    }

    logger.error(`❌ Both ENS subgraph endpoints are unreachable`);
    return false;
  }
}

// Export singleton instance
export const ensSubgraphService = new EnsSubgraphService();

