import crypto from 'crypto';
import { logger } from '../utils/logger';
import { IDatabaseService, ENSRegistration } from '../types';
import { OpenSeaService } from './openSeaService';
import { ENSMetadataService } from './ensMetadataService';
import { AlchemyService } from './alchemyService';

// QuickNode webhook interfaces based on actual payload analysis
export interface QuickNodeRegistrationData {
  nameRegistered: QuickNodeRegistrationEvent[];
}

export interface QuickNodeRegistrationEvent {
  blockNumber: string;
  contract: string;
  contractLabel: string;
  name: string;
  owner: string;
  expires: string;
  label: string;
  logIndex: string;
  txHash: string;
  // Cost fields vary by contract (NEW vs CURRENT vs OLD)
  baseCost?: string;      // NEW & CURRENT contracts
  premium?: string;       // NEW contract only
  cost?: string;          // OLD contract only  
  totalCostEth: string;   // All contracts (consistent field)
  totalCostWei: string;   // All contracts (consistent field)
  referrer?: string;      // NEW contract only
}

export class QuickNodeRegistrationService {
  constructor(
    private databaseService: IDatabaseService,
    private ensMetadataService: ENSMetadataService,
    private alchemyService: AlchemyService,
    private openSeaService: OpenSeaService
  ) {}

  /**
   * Process QuickNode registration webhook data
   */
  async processRegistrations(data: QuickNodeRegistrationData): Promise<void> {
    logger.info('🚀 Processing QuickNode registration data...');
    
    try {
      if (!data.nameRegistered || data.nameRegistered.length === 0) {
        logger.warn('No nameRegistered events found in QuickNode data');
        return;
      }
      
      logger.info(`📝 Processing ${data.nameRegistered.length} nameRegistered events`);
      
      for (const event of data.nameRegistered) {
        await this.processNameRegisteredEvent(event);
      }
      
    } catch (error: any) {
      logger.error('❌ Error processing QuickNode registrations:', error.message);
      throw error;
    }
  }

  /**
   * Process a parsed nameRegistered event from QuickNode
   */
  private async processNameRegisteredEvent(event: QuickNodeRegistrationEvent): Promise<void> {
    try {
      logger.info(`📝 Processing registration: ${event.name}.eth from contract ${event.contract}`);
      logger.debug('Full event data:', JSON.stringify(event, null, 2));
      
      // Convert hex values to proper formats
      const blockNumber = parseInt(event.blockNumber, 16);
      
      // Generate tokenId from the label hash (this matches the tokenId/topic1 from logs)
      const tokenId = event.label; // Already in hex format from QuickNode
      const tokenIdDecimal = BigInt(tokenId).toString();
      
      logger.debug(`Token ID conversion: ${tokenId} (hex) -> ${tokenIdDecimal} (decimal)`);

      // Use the consistent totalCostWei field (all contracts have this)
      const costWei = event.totalCostWei;
      const costEth = (Number(costWei) / 1e18).toFixed(6);
      
      logger.info(`💰 Registration cost: ${costWei} wei (${costEth} ETH) [Contract: ${event.contractLabel}]`);

      // Enrich with metadata following existing pattern
      const enrichedData = await this.enrichRegistrationData(event.name, tokenIdDecimal);
      
      // Get USD price conversion
      let costUsd: string | undefined;
      try {
        const ethPriceUsd = await this.alchemyService.getETHPriceUSD();
        if (ethPriceUsd) {
          const costInUsd = parseFloat(costEth) * ethPriceUsd;
          costUsd = costInUsd.toFixed(2);
          logger.info(`💰 ETH price: $${ethPriceUsd}, Registration cost: ${costEth} ETH ($${costUsd})`);
        }
      } catch (error: any) {
        logger.warn('Failed to fetch ETH price for USD conversion:', error.message);
      }

      // Create block timestamp from current time (QuickNode events don't include timestamp)
      const blockTimestamp = new Date().toISOString();
      
      // Build fullName using same logic as existing webhook
      const fullName = enrichedData.name || `${event.name}.eth`;

      // Prepare registration data for database (matches existing schema)
      const registrationData: Omit<ENSRegistration, 'id'> = {
        transactionHash: event.txHash,
        contractAddress: event.contract,
        tokenId: tokenIdDecimal,
        ensName: event.name,
        fullName: fullName,
        ownerAddress: event.owner,
        costWei: costWei,
        costEth: costEth,
        costUsd: costUsd,
        blockNumber: blockNumber,
        blockTimestamp: blockTimestamp,
        processedAt: new Date().toISOString(),
        image: enrichedData.image,
        description: enrichedData.description,
        posted: false,
        expiresAt: event.expires ? new Date(parseInt(event.expires) * 1000).toISOString() : undefined,
      };

      logger.info('📋 Final registration data prepared:', {
        ensName: registrationData.ensName,
        fullName: registrationData.fullName,
        owner: registrationData.ownerAddress,
        costEth: registrationData.costEth,
        costUsd: registrationData.costUsd,
        hasImage: !!registrationData.image,
        hasDescription: !!registrationData.description
      });

      // Store in database with source tracking and duplicate detection
      const registrationId = await this.databaseService.insertRegistrationWithSourceTracking(registrationData, 'quicknode');
      // Success logging is handled by insertRegistrationWithSourceTracking
      
    } catch (error: any) {
      logger.error(`❌ Error processing nameRegistered event for ${event.name}:`, error.message);
      throw error;
    }
  }

  /**
   * Enrich registration with metadata (mirrors existing Moralis webhook flow exactly)
   */
  private async enrichRegistrationData(
    ensName: string, 
    tokenIdDecimal: string
  ): Promise<{ name?: string; image?: string; description?: string }> {
    
    logger.info(`🔍 Enriching registration ${tokenIdDecimal} - trying OpenSea with Base Registrar first...`);
    
    let ensMetadata: { name?: string; image?: string; description?: string } | null = null;
    let openSeaSuccess = false;
    
    // 1. Try OpenSea with Base Registrar contract first (has most names)
    const baseRegistrarContract = '0x57f1887a8BF19b14fC0dF6Fd9B2acc9Af147ea85';
    try {
      const openSeaData = await this.openSeaService.getSimplifiedMetadata(baseRegistrarContract, tokenIdDecimal);
      if (openSeaData && (openSeaData.name || openSeaData.image || openSeaData.description)) {
        ensMetadata = {
          name: openSeaData.name,
          image: openSeaData.image,
          description: openSeaData.description
        };
        openSeaSuccess = true;
        logger.info(`✅ OpenSea metadata success (Base Registrar): ${openSeaData.name} (${openSeaData.collection})`);
      } else {
        logger.debug(`⚠️ OpenSea returned null or empty data for Base Registrar ${tokenIdDecimal}`);
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
        if (openSeaData && (openSeaData.name || openSeaData.image || openSeaData.description)) {
          ensMetadata = {
            name: openSeaData.name,
            image: openSeaData.image,
            description: openSeaData.description
          };
          openSeaSuccess = true;
          logger.info(`✅ OpenSea metadata success (NameWrapper): ${openSeaData.name} (${openSeaData.collection})`);
        } else {
          logger.debug(`⚠️ OpenSea returned null or empty data for NameWrapper ${tokenIdDecimal}`);
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

    // 4. Log enrichment results (matching existing webhook)
    if (ensMetadata) {
      const enrichmentSource = openSeaSuccess ? 'OpenSea' : 'ENS Metadata (fallback)';
      logger.info(`📋 Registration enrichment complete for ${ensMetadata.name}: metadata=${enrichmentSource}, hasImage=${!!ensMetadata.image}, hasDescription=${!!ensMetadata.description}`);
      logger.info('🖼️ ENS metadata fetched:', {
        name: ensMetadata.name,
        image: ensMetadata.image,
        description: ensMetadata.description
      });
      return ensMetadata;
    } else {
      logger.error(`❌ No NFT name found for registration ${tokenIdDecimal} - metadata enrichment failed`);
      logger.warn('⚠️ Failed to fetch ENS metadata for', ensName);
      return {};
    }
  }
}