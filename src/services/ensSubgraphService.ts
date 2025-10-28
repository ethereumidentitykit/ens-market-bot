import axios from 'axios';
import { logger } from '../utils/logger';
import { ENSTokenUtils } from './ensTokenUtils';

const ENS_SUBGRAPH_URL = 'https://ensnode-api-production-500f.up.railway.app/subgraph';

/**
 * In-house ENS Subgraph Service
 * Provides fast, reliable ENS name lookups via internal subgraph API
 */
export class EnsSubgraphService {
  private subgraphUrl: string;

  constructor(subgraphUrl: string = ENS_SUBGRAPH_URL) {
    this.subgraphUrl = subgraphUrl;
    logger.info(`🔧 EnsSubgraphService initialized with endpoint: ${subgraphUrl}`);
  }

  /**
   * Query ENS name by token ID
   * Supports both ENS Registry (labelhash) and Name Wrapper (namehash)
   * 
   * @param tokenId - ENS token ID (numeric string)
   * @param contractAddress - Optional contract address to determine lookup method
   * @returns ENS name or null if not found
   */
  async getNameByTokenId(tokenId: string, contractAddress?: string): Promise<string | null> {
    try {
      // Convert numeric token ID to hex hash
      const hexHash = this.tokenIdToHex(tokenId);
      
      // Determine which field to query based on contract
      const isWrapper = contractAddress?.toLowerCase() === ENSTokenUtils.NAME_WRAPPER_CONTRACT.toLowerCase();
      const hashType = isWrapper ? 'namehash (wrapper)' : 'labelhash (registry)';
      
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

      const response = await axios.post(
        this.subgraphUrl,
        { query, variables },
        {
          timeout: 2000, // 2s timeout - should be fast for local service
          headers: {
            'Content-Type': 'application/json',
          }
        }
      );

      const domains = response.data?.data?.domains;
      
      if (domains && domains.length > 0) {
        const domain = domains[0];
        
        if (domain.name) {
          logger.debug(`✅ ENS subgraph resolved: ${domain.name} (${hashType}: ${hexHash.slice(0, 10)}...)`);
          return domain.name;
        }
        
        // Try labelName if name is not available
        if (domain.labelName) {
          const name = `${domain.labelName}.eth`;
          logger.debug(`✅ ENS subgraph resolved via labelName: ${name} (${hashType}: ${hexHash.slice(0, 10)}...)`);
          return name;
        }
      }

      logger.debug(`⚠️ ENS subgraph: no name found for ${hashType} ${hexHash.slice(0, 10)}...`);
      return null;

    } catch (error: any) {
      logger.debug(`⚠️ ENS subgraph query failed: ${error.message}`);
      return null;
    }
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
   * 
   * @param labelhash - ENS labelhash in hex format (with or without 0x prefix)
   * @returns ENS name or null if not found
   */
  async getNameByLabelhash(labelhash: string): Promise<string | null> {
    try {
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

      const response = await axios.post(
        this.subgraphUrl,
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
          logger.debug(`✅ ENS subgraph resolved via labelhash: ${domain.name}`);
          return domain.name;
        }
        
        if (domain.labelName) {
          const name = `${domain.labelName}.eth`;
          logger.debug(`✅ ENS subgraph resolved via labelhash + labelName: ${name}`);
          return name;
        }
      }

      logger.debug(`⚠️ ENS subgraph: no name found for labelhash ${labelhash.slice(-10)}`);
      return null;

    } catch (error: any) {
      logger.debug(`⚠️ ENS subgraph labelhash query failed: ${error.message}`);
      return null;
    }
  }

  /**
   * Health check for the subgraph service
   * 
   * @returns true if service is reachable, false otherwise
   */
  async healthCheck(): Promise<boolean> {
    try {
      // Simple query to check if service is alive
      const query = `
        query {
          domains(first: 1) {
            id
          }
        }
      `;

      const response = await axios.post(
        this.subgraphUrl,
        { query },
        {
          timeout: 3000,
          headers: {
            'Content-Type': 'application/json',
          }
        }
      );

      return response.status === 200 && !!response.data?.data;
    } catch (error: any) {
      logger.error(`❌ ENS subgraph health check failed: ${error.message}`);
      return false;
    }
  }
}

// Export singleton instance
export const ensSubgraphService = new EnsSubgraphService();

