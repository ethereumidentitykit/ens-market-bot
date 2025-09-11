import { createHash } from 'crypto';
import { logger } from '../utils/logger';

/**
 * ENS Token ID Utilities
 * Handles conversion between ENS names and token IDs for different contracts
 * Based on ENS documentation: https://support.ens.domains/en/articles/8032027-namehash-labelhash-and-token-ids
 */
export class ENSTokenUtils {
  // ENS Contract addresses
  static readonly NAME_WRAPPER_CONTRACT = '0xd4416b13d2b3a9abae7acd5d6c2bbdbe25686401';
  static readonly ENS_REGISTRY_CONTRACT = '0x57f1887a8bf19b14fc0df6fd9b2acc9af147ea85';

  /**
   * Convert ENS name to labelhash (for unwrapped tokens)
   * Used with ENS Registry contract
   */
  static ensNameToLabelhash(ensName: string): string {
    // Extract label (part before .eth)
    const label = ensName.replace(/\.eth$/i, '');
    
    // Calculate keccak-256 hash
    const hash = createHash('sha3-256').update(label).digest('hex');
    
    logger.debug(`🔗 Converted ENS name "${ensName}" to labelhash: ${hash}`);
    return hash;
  }

  /**
   * Convert ENS name to namehash (for wrapped tokens)
   * Used with Name Wrapper contract
   * 
   * NOTE: This is a simplified implementation
   * In production, use @ensdomains/eth-ens-namehash for full namehash algorithm
   */
  static ensNameToNamehash(ensName: string): string {
    // Simplified approach - in production implement full namehash algorithm
    const fullHash = createHash('sha3-256').update(ensName).digest('hex');
    
    logger.debug(`🔗 Converted ENS name "${ensName}" to namehash: ${fullHash}`);
    return fullHash;
  }

  /**
   * Get the correct token ID for a given contract and ENS name
   */
  static getTokenIdForContract(contractAddress: string, ensName: string): string {
    const contractLower = contractAddress.toLowerCase();
    
    if (contractLower === this.NAME_WRAPPER_CONTRACT) {
      return this.ensNameToNamehash(ensName);
    } else if (contractLower === this.ENS_REGISTRY_CONTRACT) {
      return this.ensNameToLabelhash(ensName);
    } else {
      // Default to labelhash for unknown contracts
      logger.warn(`Unknown ENS contract ${contractAddress}, using labelhash`);
      return this.ensNameToLabelhash(ensName);
    }
  }

  /**
   * Get alternate contract and token ID for fallback lookup
   * Used when primary contract has no historical data
   */
  static getAlternateTokenInfo(currentContract: string, ensName: string): { contract: string; tokenId: string } {
    const currentContractLower = currentContract.toLowerCase();
    
    if (currentContractLower === this.NAME_WRAPPER_CONTRACT) {
      // Current is Name Wrapper, fallback to unwrapped
      return {
        contract: this.ENS_REGISTRY_CONTRACT,
        tokenId: this.ensNameToLabelhash(ensName)
      };
    } else {
      // Current is unwrapped, fallback to Name Wrapper
      return {
        contract: this.NAME_WRAPPER_CONTRACT,
        tokenId: this.ensNameToNamehash(ensName)
      };
    }
  }

  /**
   * Check if a contract address is a known ENS contract
   */
  static isENSContract(contractAddress: string): boolean {
    const contractLower = contractAddress.toLowerCase();
    return contractLower === this.NAME_WRAPPER_CONTRACT || 
           contractLower === this.ENS_REGISTRY_CONTRACT;
  }

  /**
   * Get user-friendly contract name
   */
  static getContractName(contractAddress: string): string {
    const contractLower = contractAddress.toLowerCase();
    
    if (contractLower === this.NAME_WRAPPER_CONTRACT) {
      return 'Name Wrapper';
    } else if (contractLower === this.ENS_REGISTRY_CONTRACT) {
      return 'ENS Registry';
    } else {
      return 'Unknown Contract';
    }
  }
}
