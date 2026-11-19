import { logger } from '../utils/logger';
import { getBestEnsName, isTokenIdHash } from '../utils/nameUtils';
import { IDatabaseService, ENSRegistration } from '../types';
import { OpenSeaService } from './openSeaService';
import { ENSMetadataService } from './ensMetadataService';
import { AlchemyService } from './alchemyService';
import { ENSTokenUtils } from './ensTokenUtils';
import { ENS_V2_REGISTRY, isENSV2PaymentContract } from '../config/ensContracts';
import {
  ENSPayment, ENSPaymentEvent, PriceUnavailableError, eventTimestamp, getENSAsset, normalizeENSPayment, parseEventInteger,
} from '../utils/ensEventUtils';

// QuickNode webhook interfaces based on actual payload analysis
export interface QuickNodeRegistrationData {
  nameRegistered: QuickNodeRegistrationEvent[];
}

export interface QuickNodeRegistrationEvent extends ENSPaymentEvent {
  blockNumber: string;
  contract: string;
  contractLabel: string;
  name: string;
  owner: string;
  expires?: string;
  label?: string;
  tokenId?: string;       // Actual V2 registry token, distinct from labelhash
  registryAddress?: string;
  duration?: string;
  blockTimestamp?: string | number; // Unix seconds
  logIndex: string;
  txHash: string;
  // Cost fields vary by contract (NEW vs CURRENT vs OLD)
  baseCost?: string;      // NEW & CURRENT contracts
  premium?: string;       // NEW contract only
  baseCostRaw?: string;   // V2 token base units
  premiumRaw?: string;    // V2 token base units
  cost?: string;          // OLD contract only  
  totalCostEth?: string;  // V1 only; V2 has paymentToken + totalCostRaw
  totalCostWei?: string;  // V1 only
  referrer?: string;      // NEW contract only
  from?: string;          // Transaction executor (tx sender) address
}

export class QuickNodeRegistrationService {
  constructor(
    private databaseService: IDatabaseService,
    private ensMetadataService: ENSMetadataService,
    private alchemyService: AlchemyService,
    private openSeaService: OpenSeaService
  ) {}

  /**
   * Value every event's payment before the webhook ACKs.
   *
   * Throws only PriceUnavailableError (a transient quote outage), so the webhook
   * can return 500 and QuickNode retries the block. Any other error is specific to
   * one event and would fail on every retry, so that event is left out of the map
   * and logged and skipped later instead of stalling the stream.
   */
  async prepareRegistrationPayments(data: QuickNodeRegistrationData): Promise<Map<QuickNodeRegistrationEvent, ENSPayment>> {
    const quotes = new Map<boolean, Promise<number | null>>();
    const getQuote = (allowFallback = true) => {
      let quote = quotes.get(allowFallback);
      if (!quote) {
        quote = this.alchemyService.getETHPriceUSD(allowFallback);
        quotes.set(allowFallback, quote);
      }
      return quote;
    };
    const payments = new Map<QuickNodeRegistrationEvent, ENSPayment>();
    for (const event of data.nameRegistered ?? []) {
      try {
        payments.set(event, await normalizeENSPayment(event, getQuote));
      } catch (error: any) {
        if (error instanceof PriceUnavailableError) throw error;
        logger.error(`❌ Invalid payment for registration ${event.name}.eth (tx ${event.txHash}), skipping: ${error.message}`);
      }
    }
    return payments;
  }

  /**
   * Process QuickNode registration webhook data.
   *
   * Events are isolated from each other: one bad event is logged and counted but
   * does not prevent the rest of the delivery from being stored. Pass the result of
   * prepareRegistrationPayments to reuse the quote taken before the webhook ACKed.
   */
  async processRegistrations(
    data: QuickNodeRegistrationData,
    payments?: Map<QuickNodeRegistrationEvent, ENSPayment>
  ): Promise<{ inserted: number; duplicates: number; errors: number }> {
    const stats = { inserted: 0, duplicates: 0, errors: 0 };
    if (!data.nameRegistered || data.nameRegistered.length === 0) {
      logger.warn('No nameRegistered events found in QuickNode data');
      return stats;
    }

    logger.info(`📝 Processing ${data.nameRegistered.length} nameRegistered events`);
    const prepared = payments ?? await this.prepareRegistrationPayments(data);

    // Sequential on purpose: OpenSeaService allows one request per second, and
    // block order keeps the tweet queue in chain order.
    for (const event of data.nameRegistered) {
      const payment = prepared.get(event);
      if (!payment) {
        stats.errors++; // Already logged by prepareRegistrationPayments.
        continue;
      }
      try {
        const outcome = await this.processNameRegisteredEvent(event, payment);
        stats[outcome]++;
      } catch (error: any) {
        stats.errors++;
        logger.error(`❌ Error processing nameRegistered event for ${event.name}.eth (tx ${event.txHash}):`, error.message);
      }
    }

    logger.info(
      `✅ QuickNode registrations processed: ${stats.inserted} inserted, ` +
      `${stats.duplicates} duplicates, ${stats.errors} errors`
    );
    return stats;
  }

  /**
   * Process a parsed nameRegistered event from QuickNode
   */
  private async processNameRegisteredEvent(
    event: QuickNodeRegistrationEvent,
    payment: ENSPayment
  ): Promise<'inserted' | 'duplicates'> {
    logger.info(`📝 Processing registration: ${event.name}.eth from contract ${event.contract}`);
    logger.debug('Full event data:', JSON.stringify(event, null, 2));

    // Convert hex values to proper formats
    const blockNumber = parseEventInteger(event.blockNumber);
    const asset = getENSAsset(event);
    const tokenIdDecimal = asset.tokenId;

    // Check before enrichment: a redelivered block must cost one query per
    // event, not the full set of OpenSea/metadata/RPC calls.
    if (await this.databaseService.isRegistrationProcessed(tokenIdDecimal)) {
      logger.info(`⏭️ Registration ${event.name}.eth (token ${tokenIdDecimal}) already stored, skipping`);
      return 'duplicates';
    }

    const { costWei, costEth } = payment;
    
    logger.info(`💰 Registration cost: ${costWei} equivalent wei (${costEth} ETH equivalent) [Contract: ${event.contractLabel}]`);

    // Enrich with metadata following existing pattern
    const enrichedData = await this.enrichRegistrationData(event.name, tokenIdDecimal, asset.contract);
    let timestamp = event.blockTimestamp;
    if (timestamp == null && isENSV2PaymentContract(event.contract)) {
      timestamp = (await this.alchemyService.getBlockTimestamp(blockNumber)) ?? undefined;
    }
    const blockTimestamp = eventTimestamp(timestamp) || new Date().toISOString();
    let expiresAt = eventTimestamp(event.expires);
    if (!expiresAt && isENSV2PaymentContract(event.contract)) {
      // V2 NameRegistered omits expiry. Prefer the registry companion event;
      // otherwise derive it from the actual block timestamp, never wall time.
      if (timestamp == null || event.duration == null) throw new Error('Missing ENSv2 registration expiry/block timestamp');
      expiresAt = eventTimestamp(parseEventInteger(timestamp) + parseEventInteger(event.duration));
    }
    
    // Build fullName with hash detection and fallback
    // Priority: webhook name (event.name) > metadata name (if not a hash)
    const fullName = getBestEnsName(
      event.name,           // Webhook name (most reliable)
      enrichedData.name,    // Metadata name (might be a hash)
      event.name            // Fallback to webhook
    );

    // Prepare registration data for database (matches existing schema)
    const registrationData: Omit<ENSRegistration, 'id'> = {
      transactionHash: event.txHash,
      contractAddress: event.contract,
      tokenId: tokenIdDecimal,
      ensName: event.name,
      fullName: fullName,
      ownerAddress: event.owner,
      executorAddress: event.from || undefined,
      ...payment,
      blockNumber: blockNumber,
      blockTimestamp: blockTimestamp,
      processedAt: new Date().toISOString(),
      image: enrichedData.image,
      description: enrichedData.description,
      posted: false,
      expiresAt,
    };

    logger.info('📋 Final registration data prepared:', {
      ensName: registrationData.ensName,
      fullName: registrationData.fullName,
      owner: registrationData.ownerAddress,
      executor: registrationData.executorAddress,
      costEth: registrationData.costEth,
      costUsd: registrationData.costUsd,
      hasImage: !!registrationData.image,
      hasDescription: !!registrationData.description
    });

    // Store in database with source tracking and duplicate detection
    await this.databaseService.insertRegistrationWithSourceTracking(registrationData, 'quicknode');
    // Success logging is handled by insertRegistrationWithSourceTracking
    return 'inserted';
  }

  /**
   * Enrich registration with metadata (image, description, etc.)
   */
  private async enrichRegistrationData(
    ensName: string, 
    tokenIdDecimal: string,
    registryContract: string
  ): Promise<{ name?: string; image?: string; description?: string }> {
    if (registryContract === ENS_V2_REGISTRY) {
      // A labelhash on BaseRegistrar may describe a previous V1 owner/registration.
      // Use only the V2 asset for V2 metadata, and tolerate indexing lag.
      try {
        const metadata = await this.openSeaService.getSimplifiedMetadata(registryContract, tokenIdDecimal);
        if (metadata && (metadata.name || metadata.image || metadata.description)) return metadata;
      } catch (error: any) {
        logger.debug(`OpenSea ENSv2 metadata unavailable: ${error.message}`);
      }
      return (await this.ensMetadataService.getMetadata(registryContract, tokenIdDecimal).catch(() => null)) || {};
    }
    
    // Generate contract-specific token IDs using ENSTokenUtils
    const fullEnsName = `${ensName}.eth`;
    const baseRegistrarContract = '0x57f1887a8BF19b14fC0dF6Fd9B2acc9Af147eA85';
    const nameWrapperContract = '0xD4416b13d2b3a9aBae7AcD5D6C2BbDBE25686401';
    
    // Base Registrar uses labelhash (tokenIdDecimal is already correct)
    const baseRegistrarTokenId = tokenIdDecimal;
    // NameWrapper uses namehash (generated from full ENS name)
    const nameWrapperTokenId = BigInt(ENSTokenUtils.getTokenIdForContract(nameWrapperContract, fullEnsName)).toString();
    
    logger.debug(`Token ID generation for "${fullEnsName}":`);
    logger.debug(`  Base Registrar (labelhash): ${baseRegistrarTokenId}`);
    logger.debug(`  NameWrapper (namehash): ${nameWrapperTokenId}`);
    
    logger.info(`🔍 Enriching registration - trying OpenSea with Base Registrar (${baseRegistrarTokenId})...`);
    
    let ensMetadata: { name?: string; image?: string; description?: string } | null = null;
    let openSeaSuccess = false;
    
    // 1. Try OpenSea with Base Registrar contract first (has most names)
    try {
      const openSeaData = await this.openSeaService.getSimplifiedMetadata(baseRegistrarContract, baseRegistrarTokenId);
      if (openSeaData && (openSeaData.name || openSeaData.image || openSeaData.description)) {
        ensMetadata = {
          name: openSeaData.name,
          image: openSeaData.image,
          description: openSeaData.description
        };
        openSeaSuccess = true;
        logger.info(`✅ OpenSea metadata success (Base Registrar): ${openSeaData.name} (${openSeaData.collection})`);
      } else {
        logger.debug(`⚠️ OpenSea returned null or empty data for Base Registrar ${baseRegistrarTokenId}`);
      }
    } catch (error: any) {
      logger.debug(`❌ OpenSea Base Registrar failed for ${baseRegistrarTokenId}: ${error.message}`);
    }

    // 2. Try OpenSea with NameWrapper contract if Base Registrar failed
    if (!ensMetadata) {
      logger.info(`🔍 Trying OpenSea with NameWrapper contract (${nameWrapperTokenId})...`);
      try {
        const openSeaData = await this.openSeaService.getSimplifiedMetadata(nameWrapperContract, nameWrapperTokenId);
        if (openSeaData && (openSeaData.name || openSeaData.image || openSeaData.description)) {
          ensMetadata = {
            name: openSeaData.name,
            image: openSeaData.image,
            description: openSeaData.description
          };
          openSeaSuccess = true;
          logger.info(`✅ OpenSea metadata success (NameWrapper): ${openSeaData.name} (${openSeaData.collection})`);
        } else {
          logger.debug(`⚠️ OpenSea returned null or empty data for NameWrapper ${nameWrapperTokenId}`);
        }
      } catch (error: any) {
        logger.debug(`❌ OpenSea NameWrapper failed for ${nameWrapperTokenId}: ${error.message}`);
      }
    }

    // 3. Fallback to ENS Metadata service if OpenSea failed completely
    if (!ensMetadata) {
      logger.warn(`⚠️ Falling back to ENS Metadata API for registration ${baseRegistrarTokenId} (OpenSea failed)`);
      try {
        const ensData = await this.ensMetadataService.getMetadataWithFallback(baseRegistrarTokenId);
        if (ensData) {
          ensMetadata = {
            name: ensData.name,
            image: ensData.image,
            description: ensData.description
          };
          logger.info(`✅ ENS metadata fallback success: ${ensData.name}`);
        } else {
          logger.error(`❌ ENS metadata fallback returned null for registration ${baseRegistrarTokenId}`);
        }
      } catch (error: any) {
        logger.error(`❌ ENS metadata fallback failed for registration ${baseRegistrarTokenId}: ${error.message}`);
      }
    }

    // 4. Log enrichment results (matching existing webhook)
    if (ensMetadata) {
      const enrichmentSource = openSeaSuccess ? 'OpenSea' : 'ENS Metadata (fallback)';
      
      // Detect and warn about token ID hashes
      if (ensMetadata.name && isTokenIdHash(ensMetadata.name)) {
        logger.warn(`⚠️ Metadata returned token ID hash instead of name: "${ensMetadata.name.substring(0, 30)}..." (will use webhook name as fallback)`);
      }
      
      logger.info(`📋 Registration enrichment complete for ${ensMetadata.name}: metadata=${enrichmentSource}, hasImage=${!!ensMetadata.image}, hasDescription=${!!ensMetadata.description}`);
      logger.info('🖼️ ENS metadata fetched:', {
        name: ensMetadata.name,
        image: ensMetadata.image,
        description: ensMetadata.description
      });
      return ensMetadata;
    } else {
      logger.error(`❌ No NFT name found for registration ${baseRegistrarTokenId} - metadata enrichment failed`);
      logger.warn('⚠️ Failed to fetch ENS metadata for', ensName);
      return {};
    }
  }
}
