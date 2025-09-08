import { logger } from '../utils/logger';
import { ENSRegistration, IDatabaseService } from '../types';
import { ENSMetadataService } from './ensMetadataService';
import { AlchemyService } from './alchemyService';
import { OpenSeaService } from './openSeaService';

interface QuickNodeLog {
  transactionHash: string;
  blockNumber: string;
  blockHash: string;
  address: string;
  topics: string[];
  data: string;
  logIndex: string;
}

interface QuickNodeRegistrationWebhookData {
  logs: QuickNodeLog[];
  block?: {
    number: string;
    timestamp: string;
  };
}

interface ExtractedRegistrationData {
  ensName: string;
  cost: string;
  contractFormat: 'legacy' | 'enhanced' | 'referral';
  baseCost?: string;
  premium?: string;
}

/**
 * QuickNode Registration Processing Service
 * Processes NameRegistered events from QuickNode webhooks
 * Enriches with metadata and stores as ENSRegistration records
 */
export class QuickNodeRegistrationService {
  // ENS Registrar Controller addresses
  private readonly ENS_REGISTRAR_CONTROLLER_OLD = '0x283Af0B28c62C092C9743114e89c6e2e2eE5f032';
  private readonly ENS_REGISTRAR_CONTROLLER_NEW = '0x253553366Da8546fC250F225fe3d25d0C782303b';
  private readonly ENS_REGISTRY = '0x57f1887a8BF19b14fC0dF6Fd9B2acc9Af147eA85';
  private readonly ENS_NAMEWRAPPER = '0xD4416b13d2b3a9aBae7AcD5D6C2BbDBE25686401';
  
  // NameRegistered event signature
  private readonly NAME_REGISTERED_EVENT_SIGNATURE = '0xca6abbe9d7f11422cb6ca7629fbf6fe9efb1c621f71ce8f02b9f2a230097404f';

  constructor(
    private databaseService: IDatabaseService,
    private openSeaService: OpenSeaService,
    private ensMetadataService: ENSMetadataService,
    private alchemyService: AlchemyService
  ) {}

  /**
   * Process QuickNode webhook data and store enriched registrations
   * @param webhookData - Raw webhook data from QuickNode
   * @returns Processing results
   */
  async processWebhookData(webhookData: QuickNodeRegistrationWebhookData): Promise<{
    processed: number;
    stored: number;
    skipped: number;
    errors: number;
  }> {
    const results = {
      processed: 0,
      stored: 0,
      skipped: 0,
      errors: 0
    };

    if (!webhookData.logs || !Array.isArray(webhookData.logs)) {
      logger.warn('No logs data in registration webhook');
      return results;
    }

    logger.info(`🚀 Processing ${webhookData.logs.length} QuickNode logs for registrations`);

    for (const log of webhookData.logs) {
      try {
        results.processed++;
        
        // Extract ENS registration data from log
        const registrationData = this.extractRegistrationData(log);
        
        if (!registrationData) {
          results.skipped++;
          const skipReason = this.getSkipReason(log);
          logger.info(`Skipped log ${log.transactionHash}:${log.logIndex} - ${skipReason}`);
          continue;
        }

        // Check if already processed
        const isAlreadyProcessed = await this.databaseService.isRegistrationProcessed(registrationData.tokenId);
        if (isAlreadyProcessed) {
          results.skipped++;
          logger.info(`⚡ QuickNode registration already processed: ${registrationData.ensName} (${log.transactionHash})`);
          continue;
        }

        // Enrich with metadata
        const enrichedRegistration = await this.enrichRegistrationData(registrationData);
        
        if (!enrichedRegistration) {
          results.errors++;
          logger.warn(`Failed to enrich registration data for ${registrationData.ensName} - skipping storage`);
          continue;
        }

        // Store in database
        const registrationId = await this.databaseService.insertRegistration(enrichedRegistration);
        results.stored++;
        
        logger.info(`✅ QuickNode registration stored: ${enrichedRegistration.ensName} (${enrichedRegistration.costEth} ETH) - ID: ${registrationId}`);
        
      } catch (error: any) {
        results.errors++;
        logger.error(`Error processing QuickNode log ${log.transactionHash}:${log.logIndex}:`, error.message);
      }
    }

    logger.info(`🎯 QuickNode registration processing complete: ${results.stored} stored, ${results.skipped} skipped, ${results.errors} errors`);
    return results;
  }

  /**
   * Extract registration data from QuickNode log
   * @param log - QuickNode transaction log
   * @returns Basic registration data or null if not a valid ENS registration
   */
  private extractRegistrationData(log: QuickNodeLog): {
    transactionHash: string;
    contractAddress: string;
    tokenId: string;
    ensName: string;
    ownerAddress: string;
    costWei: string;
    blockNumber: number;
    blockTimestamp: string;
  } | null {
    try {
      // Check if this is a NameRegistered event
      if (!log.topics || log.topics[0] !== this.NAME_REGISTERED_EVENT_SIGNATURE) {
        return null; // Not a NameRegistered event
      }

      // Check if it's from a monitored ENS contract
      const contractAddress = log.address.toLowerCase();
      const isValidContract = 
        contractAddress === this.ENS_REGISTRAR_CONTROLLER_OLD.toLowerCase() ||
        contractAddress === this.ENS_REGISTRAR_CONTROLLER_NEW.toLowerCase() ||
        contractAddress === this.ENS_REGISTRY.toLowerCase() ||
        contractAddress === this.ENS_NAMEWRAPPER.toLowerCase();

      if (!isValidContract) {
        return null; // Not from a monitored ENS contract
      }

      // Extract data from topics and data
      const tokenId = log.topics[1]; // keccak256 hash of ENS name
      const ownerAddress = log.topics[2]?.replace('0x000000000000000000000000', '0x'); // Remove padding

      if (!tokenId || !ownerAddress) {
        logger.warn(`Missing topics in NameRegistered event: ${log.transactionHash}`);
        return null;
      }

      // Extract registration data from log data field
      const extractedData = this.parseRegistrationData(log.data, contractAddress);
      
      if (!extractedData || !extractedData.ensName) {
        logger.warn(`Failed to extract ENS name from log data: ${log.transactionHash}`);
        return null;
      }

      // Convert hex block number to decimal
      const blockNumber = parseInt(log.blockNumber, 16);
      
      // Use current timestamp as fallback (matches existing pattern)
      const blockTimestamp = new Date().toISOString();

      return {
        transactionHash: log.transactionHash,
        contractAddress,
        tokenId,
        ensName: extractedData.ensName,
        ownerAddress,
        costWei: extractedData.cost,
        blockNumber,
        blockTimestamp
      };
      
    } catch (error: any) {
      logger.error(`Error extracting registration data from log ${log.transactionHash}:`, error.message);
      return null;
    }
  }

  /**
   * Parse registration data from log data field (copied from existing logic)
   * @param data - Raw log data
   * @param contractAddress - Contract address to determine format
   * @returns Extracted registration data
   */
  private parseRegistrationData(data: string, contractAddress: string): ExtractedRegistrationData {
    const format = this.getContractFormat(contractAddress);
    logger.debug(`Processing ${format.description} format for contract: ${contractAddress}`);
    
    switch (format.type) {
      case 'legacy':
        return this.extractLegacyFormatData(data);
      case 'enhanced':
        return this.extractEnhancedFormatData(data);
      case 'referral':
        return this.extractReferralFormatData(data);
      default:
        logger.warn(`Unknown contract format, defaulting to legacy for: ${contractAddress}`);
        return this.extractLegacyFormatData(data);
    }
  }

  /**
   * Get contract format based on address
   */
  private getContractFormat(contractAddress: string) {
    const address = contractAddress.toLowerCase();
    
    if (address === this.ENS_REGISTRAR_CONTROLLER_OLD.toLowerCase()) {
      return { type: 'legacy' as const, description: 'Legacy ENS Controller' };
    } else if (address === this.ENS_REGISTRAR_CONTROLLER_NEW.toLowerCase()) {
      return { type: 'enhanced' as const, description: 'Enhanced ENS Controller' };
    } else if (address === this.ENS_REGISTRY.toLowerCase() || address === this.ENS_NAMEWRAPPER.toLowerCase()) {
      return { type: 'referral' as const, description: 'ENS Registry/NameWrapper' };
    }
    
    return { type: 'legacy' as const, description: 'Unknown (defaulting to legacy)' };
  }

  /**
   * Extract data in legacy format
   */
  private extractLegacyFormatData(data: string): ExtractedRegistrationData {
    try {
      const cleanData = data.slice(2); // Remove 0x prefix
      
      // Legacy format: [offset][cost][expires][stringLength][stringData]
      const costHex = cleanData.slice(64, 128); // Position 2
      const cost = BigInt('0x' + costHex).toString();
      
      // Extract ENS name with proper offset handling
      const nameOffset = parseInt(cleanData.slice(0, 64), 16) * 2;
      const nameLength = parseInt(cleanData.slice(nameOffset, nameOffset + 64), 16);
      const nameHex = cleanData.slice(nameOffset + 64, nameOffset + 64 + nameLength * 2);
      const nameBuffer = Buffer.from(nameHex, 'hex');
      const ensName = nameBuffer.toString('utf8').replace(/\0/g, ''); // Remove null bytes
      
      return {
        ensName,
        cost,
        contractFormat: 'legacy'
      };
    } catch (error) {
      logger.error('Error extracting legacy format data:', error);
      return {
        ensName: 'unknown',
        cost: '0',
        contractFormat: 'legacy'
      };
    }
  }

  /**
   * Extract data in enhanced format
   */
  private extractEnhancedFormatData(data: string): ExtractedRegistrationData {
    try {
      const cleanData = data.slice(2); // Remove 0x prefix
      
      // Enhanced format: [offset][baseCost][premium][expires][stringLength][stringData]
      const baseCostHex = cleanData.slice(64, 128);   // Position 2
      const premiumHex = cleanData.slice(128, 192);   // Position 3
      
      const baseCost = BigInt('0x' + baseCostHex);
      const premium = BigInt('0x' + premiumHex);
      const totalCost = baseCost + premium;
      
      // Extract ENS name with proper offset handling
      const nameOffset = parseInt(cleanData.slice(0, 64), 16) * 2;
      const nameLength = parseInt(cleanData.slice(nameOffset, nameOffset + 64), 16);
      const nameHex = cleanData.slice(nameOffset + 64, nameOffset + 64 + nameLength * 2);
      const nameBuffer = Buffer.from(nameHex, 'hex');
      const ensName = nameBuffer.toString('utf8').replace(/\0/g, ''); // Remove null bytes
      
      return {
        ensName,
        cost: totalCost.toString(),
        contractFormat: 'enhanced',
        baseCost: baseCost.toString(),
        premium: premium.toString()
      };
    } catch (error) {
      logger.error('Error extracting enhanced format data:', error);
      return {
        ensName: 'unknown',
        cost: '0',
        contractFormat: 'enhanced'
      };
    }
  }

  /**
   * Extract data in referral format
   */
  private extractReferralFormatData(data: string): ExtractedRegistrationData {
    try {
      const cleanData = data.slice(2); // Remove 0x prefix
      
      // Referral format: [offset][baseCost][premium][expires][referrer][stringLength][stringData]
      const baseCostHex = cleanData.slice(64, 128);   // Position 2
      const premiumHex = cleanData.slice(128, 192);   // Position 3
      
      const baseCost = BigInt('0x' + baseCostHex);
      const premium = BigInt('0x' + premiumHex);
      const totalCost = baseCost + premium;
      
      // Extract ENS name with proper offset handling
      const nameOffset = parseInt(cleanData.slice(0, 64), 16) * 2;
      const nameLength = parseInt(cleanData.slice(nameOffset, nameOffset + 64), 16);
      const nameHex = cleanData.slice(nameOffset + 64, nameOffset + 64 + nameLength * 2);
      const nameBuffer = Buffer.from(nameHex, 'hex');
      const ensName = nameBuffer.toString('utf8').replace(/\0/g, ''); // Remove null bytes
      
      return {
        ensName,
        cost: totalCost.toString(),
        contractFormat: 'referral',
        baseCost: baseCost.toString(),
        premium: premium.toString()
      };
    } catch (error) {
      logger.error('Error extracting referral format data:', error);
      return {
        ensName: 'unknown',
        cost: '0',
        contractFormat: 'referral'
      };
    }
  }

  /**
   * Enrich registration data with metadata from ENS APIs (matches Moralis webhook pattern)
   * @param registrationData - Basic registration data
   * @returns Enriched ENSRegistration or null if enrichment fails
   */
  private async enrichRegistrationData(registrationData: {
    transactionHash: string;
    contractAddress: string;
    tokenId: string;
    ensName: string;
    ownerAddress: string;
    costWei: string;
    blockNumber: number;
    blockTimestamp: string;
  }): Promise<Omit<ENSRegistration, 'id'> | null> {
    try {
      logger.debug(`Enriching registration data for ${registrationData.ensName}`);

      // Convert tokenId to decimal for API compatibility (matches Moralis pattern)
      const tokenIdDecimal = BigInt(registrationData.tokenId).toString();
      logger.debug(`Converting tokenId: ${registrationData.tokenId} (hex) -> ${tokenIdDecimal} (decimal)`);

      // 1. Try OpenSea with Base Registrar contract first (matches Moralis pattern)
      const baseRegistrarContract = '0x57f1887a8BF19b14fC0dF6Fd9B2acc9Af147ea85';
      let ensMetadata: { name?: string; image?: string; description?: string } | null = null;
      let openSeaSuccess = false;
      
      logger.info(`🔍 Enriching registration ${tokenIdDecimal} - trying OpenSea with Base Registrar first...`);
      try {
        const openSeaData = await this.openSeaService.getSimplifiedMetadata(baseRegistrarContract, tokenIdDecimal);
        if (openSeaData) {
          ensMetadata = {
            name: openSeaData.name,
            image: openSeaData.image,
            description: openSeaData.description
          };
          openSeaSuccess = true;
          logger.info(`✅ OpenSea metadata success (Base Registrar): ${openSeaData.name} (${openSeaData.collection})`);
        } else {
          logger.debug(`⚠️ OpenSea returned null for Base Registrar ${tokenIdDecimal}`);
        }
      } catch (error: any) {
        logger.debug(`❌ OpenSea Base Registrar failed for ${tokenIdDecimal}: ${error.message}`);
      }
      
      // 2. Try OpenSea with NameWrapper contract if Base Registrar failed
      if (!ensMetadata) {
        const nameWrapperContract = '0xD4416b13d2b3a9aBae7AcD5D6C2BbDBE25686401';
        logger.info(`🔍 Trying OpenSea with NameWrapper contract...`);
        try {
          const openSeaData = await this.openSeaService.getSimplifiedMetadata(nameWrapperContract, tokenIdDecimal);
          if (openSeaData) {
            ensMetadata = {
              name: openSeaData.name,
              image: openSeaData.image,
              description: openSeaData.description
            };
            openSeaSuccess = true;
            logger.info(`✅ OpenSea metadata success (NameWrapper): ${openSeaData.name} (${openSeaData.collection})`);
          } else {
            logger.debug(`⚠️ OpenSea returned null for NameWrapper ${tokenIdDecimal}`);
          }
        } catch (error: any) {
          logger.debug(`❌ OpenSea NameWrapper failed for ${tokenIdDecimal}: ${error.message}`);
        }
      }
      
      // 3. Fallback to ENS Metadata service if OpenSea failed completely
      if (!ensMetadata) {
        logger.warn(`⚠️ Falling back to ENS Metadata API for registration ${tokenIdDecimal} (OpenSea failed)`);
        try {
          const ensData = await this.ensMetadataService.getMetadataWithFallback(tokenIdDecimal);
          if (ensData) {
            ensMetadata = {
              name: ensData.name,
              image: ensData.image,
              description: ensData.description
            };
            logger.info(`✅ ENS metadata fallback success: ${ensData.name}`);
          } else {
            logger.error(`❌ ENS metadata fallback returned null for registration ${tokenIdDecimal}`);
          }
        } catch (error: any) {
          logger.error(`❌ ENS metadata fallback failed for registration ${tokenIdDecimal}: ${error.message}`);
        }
      }
      
      // 4. Log enrichment results
      if (ensMetadata) {
        const enrichmentSource = openSeaSuccess ? 'OpenSea' : 'ENS Metadata (fallback)';
        logger.info(`📋 Registration enrichment complete for ${ensMetadata.name}: metadata=${enrichmentSource}, hasImage=${!!ensMetadata.image}, hasDescription=${!!ensMetadata.description}`);
        logger.info('🖼️ ENS metadata fetched:', {
          name: ensMetadata.name,
          image: ensMetadata.image,
          description: ensMetadata.description
        });
      } else {
        logger.error(`❌ No NFT name found for registration ${tokenIdDecimal} - metadata enrichment failed`);
        logger.warn('⚠️ Failed to fetch ENS metadata for', registrationData.ensName);
      }
      
      // Convert cost from wei to ETH (matches Moralis precision)
      const costInWei = BigInt(registrationData.costWei);
      const costInEth = (Number(costInWei) / 1e18).toFixed(6);
      
      // Get current ETH price in USD for cost calculation
      let costUsd: string | undefined;
      try {
        const ethPriceUsd = await this.alchemyService.getETHPriceUSD();
        if (ethPriceUsd) {
          const costInUsd = parseFloat(costInEth) * ethPriceUsd;
          costUsd = costInUsd.toFixed(2);
          logger.info(`💰 ETH price: $${ethPriceUsd}, Registration cost: ${costInEth} ETH ($${costUsd})`);
        }
      } catch (error: any) {
        logger.warn('Failed to fetch ETH price for USD conversion:', error.message);
      }

      // 5. Build ENSRegistration object (matches Moralis pattern)
      const ensRegistration: Omit<ENSRegistration, 'id'> = {
        transactionHash: registrationData.transactionHash,
        contractAddress: registrationData.contractAddress,
        tokenId: tokenIdDecimal, // Use decimal format consistently
        ensName: registrationData.ensName,
        fullName: ensMetadata?.name || `${registrationData.ensName}.eth`, // Matches Moralis logic
        ownerAddress: registrationData.ownerAddress,
        costWei: registrationData.costWei,
        costEth: costInEth,
        costUsd: costUsd,
        blockNumber: registrationData.blockNumber,
        blockTimestamp: registrationData.blockTimestamp,
        processedAt: new Date().toISOString(),
        image: ensMetadata?.image,
        description: ensMetadata?.description,
        posted: false,
        expiresAt: undefined, // TODO: Calculate expiration if needed
      };

      return ensRegistration;
      
    } catch (error: any) {
      logger.error(`Error enriching registration data for ${registrationData.ensName}:`, error.message);
      return null;
    }
  }

  /**
   * Get detailed reason why a log was skipped
   * @param log - QuickNode transaction log
   * @returns Human-readable skip reason
   */
  private getSkipReason(log: QuickNodeLog): string {
    try {
      // Check event signature
      if (!log.topics || log.topics[0] !== this.NAME_REGISTERED_EVENT_SIGNATURE) {
        return 'not a NameRegistered event';
      }

      // Check contract address
      const contractAddress = log.address.toLowerCase();
      const isValidContract = 
        contractAddress === this.ENS_REGISTRAR_CONTROLLER_OLD.toLowerCase() ||
        contractAddress === this.ENS_REGISTRAR_CONTROLLER_NEW.toLowerCase() ||
        contractAddress === this.ENS_REGISTRY.toLowerCase() ||
        contractAddress === this.ENS_NAMEWRAPPER.toLowerCase();

      if (!isValidContract) {
        return `not from monitored ENS contract (${contractAddress})`;
      }

      // Check topics
      if (!log.topics[1] || !log.topics[2]) {
        return 'missing required topics (tokenId/owner)';
      }

      return 'data parsing failed';
    } catch (error: any) {
      return `error parsing log: ${error.message}`;
    }
  }
}
