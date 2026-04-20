import { logger } from '../utils/logger';
import { getBestEnsName, isTokenIdHash } from '../utils/nameUtils';
import { IDatabaseService, ENSRenewal } from '../types';
import { OpenSeaService } from './openSeaService';
import { ENSMetadataService } from './ensMetadataService';
import { AlchemyService } from './alchemyService';
import { ENSTokenUtils } from './ensTokenUtils';
import { ensSubgraphService } from './ensSubgraphService';

// QuickNode webhook payload shape — see docs/quicknode-renewal-filter.md
export interface QuickNodeRenewalData {
  nameRenewed: QuickNodeRenewalEvent[];
}

export interface QuickNodeRenewalEvent {
  blockNumber: string;       // hex
  contract: string;          // controller address (lowercase)
  contractLabel: string | null;
  name: string;              // ENS label (without .eth)
  label: string;             // bytes32 hash (hex)
  cost?: string;             // decimal wei (single field, no baseCost/premium for renewals)
  expires?: string;          // unix timestamp (decimal)
  referrer?: string;         // bytes32 (newest controller only)
  totalCostWei: string;      // decimal wei
  totalCostEth: string;      // decimal ETH string
  logIndex: number;
  txHash: string;
  from?: string;             // tx.from (= renewer)
}

/**
 * QuickNodeRenewalService
 *
 * Processes ENS NameRenewed events delivered by QuickNode. Mirrors the registration
 * service shape — same constructor signature, same enrichment logic — with two key
 * architectural differences:
 *
 * 1. **Per-tx batched insert.** A single QuickNode webhook may carry events from
 *    multiple txs in one block. We group events by tx_hash and insert each tx's
 *    rows in a single batched INSERT via `databaseService.insertRenewalsBatch()`.
 *    The PostgreSQL statement-level trigger on `ens_renewals` then fires exactly
 *    one `pg_notify('new_renewal_tx', tx_hash)` per distinct tx — DB-enforced
 *    aggregation, no app-side debounce needed.
 *
 * 2. **Owner lookup is separate.** NameRenewed events do NOT include `owner`
 *    (unlike NameRegistered). We use `tx.from` as the renewer and look up the
 *    current owner via the ENS subgraph. Renewer ≠ owner is common (gift renewals,
 *    third-party renewal services, marketplace bulk renewals).
 *
 * If owner lookup or metadata enrichment fails for any individual event, we still
 * insert the row (with null owner / no metadata) — the tweet/AI reply pipeline
 * degrades gracefully.
 */
export class QuickNodeRenewalService {
  constructor(
    private databaseService: IDatabaseService,
    private ensMetadataService: ENSMetadataService,
    private alchemyService: AlchemyService,
    private openSeaService: OpenSeaService
  ) {}

  /**
   * Top-level entry point — called by the /webhook/quicknode-renewals handler.
   * Groups events by tx_hash, enriches each tx in parallel, batched-inserts per tx.
   */
  async processRenewals(data: QuickNodeRenewalData): Promise<{
    txsProcessed: number;
    rowsInserted: number;
    rowsSkipped: number;
    errors: number;
  }> {
    logger.info('🚀 Processing QuickNode renewal data...');

    const stats = { txsProcessed: 0, rowsInserted: 0, rowsSkipped: 0, errors: 0 };

    if (!data.nameRenewed || data.nameRenewed.length === 0) {
      logger.warn('No nameRenewed events found in QuickNode renewal payload');
      return stats;
    }

    // Group events by tx_hash. QuickNode delivers per block, which can contain
    // multiple renewal txs (and each tx can have many renewal events).
    const eventsByTx = new Map<string, QuickNodeRenewalEvent[]>();
    for (const event of data.nameRenewed) {
      const existing = eventsByTx.get(event.txHash) || [];
      existing.push(event);
      eventsByTx.set(event.txHash, existing);
    }

    logger.info(`📝 Processing ${data.nameRenewed.length} renewal event(s) across ${eventsByTx.size} tx(es)`);

    // Process each tx independently, in parallel. A failure on one tx doesn't block others.
    const txResults = await Promise.allSettled(
      Array.from(eventsByTx.entries()).map(([txHash, events]) =>
        this.processSingleTx(txHash, events)
      )
    );

    for (const result of txResults) {
      if (result.status === 'fulfilled') {
        stats.txsProcessed++;
        stats.rowsInserted += result.value.inserted;
        stats.rowsSkipped += result.value.skipped;
      } else {
        stats.errors++;
        logger.error('❌ Renewal tx processing failed:', result.reason?.message || result.reason);
      }
    }

    logger.info(
      `✅ QuickNode renewals processed: ${stats.txsProcessed} tx(es), ` +
      `${stats.rowsInserted} rows inserted, ${stats.rowsSkipped} skipped (duplicates), ${stats.errors} errors`
    );
    return stats;
  }

  /**
   * Process all events for one tx: enrich each event in parallel, then do a single
   * batched INSERT so the statement-level trigger fires once for the tx.
   */
  private async processSingleTx(
    txHash: string,
    events: QuickNodeRenewalEvent[]
  ): Promise<{ inserted: number; skipped: number }> {
    logger.info(`📝 Tx ${txHash.slice(0, 10)}…: enriching ${events.length} renewal event(s)`);

    // Enrich all events in this tx in parallel.
    const enrichResults = await Promise.allSettled(
      events.map(e => this.buildRenewalRow(e))
    );

    const rows: Omit<ENSRenewal, 'id'>[] = [];
    let enrichFailures = 0;
    for (const result of enrichResults) {
      if (result.status === 'fulfilled' && result.value) {
        rows.push(result.value);
      } else {
        enrichFailures++;
        if (result.status === 'rejected') {
          logger.warn(`⚠️ Enrichment failed for renewal event:`, result.reason?.message || result.reason);
        }
      }
    }

    if (enrichFailures > 0) {
      logger.warn(`⚠️ ${enrichFailures} renewal event(s) skipped due to enrichment failure in tx ${txHash.slice(0, 10)}…`);
    }

    if (rows.length === 0) {
      logger.warn(`⚠️ Tx ${txHash.slice(0, 10)}…: all events failed enrichment, nothing to insert`);
      return { inserted: 0, skipped: 0 };
    }

    // Single batched INSERT — fires the statement-level trigger exactly once for this tx.
    const insertedIds = await this.databaseService.insertRenewalsBatch(rows);
    const skipped = rows.length - insertedIds.length;
    return { inserted: insertedIds.length, skipped };
  }

  /**
   * Convert one QuickNode event into a fully-enriched ENSRenewal row ready to insert.
   * Returns null if the event is malformed beyond recovery.
   */
  private async buildRenewalRow(event: QuickNodeRenewalEvent): Promise<Omit<ENSRenewal, 'id'> | null> {
    try {
      // Basic field coercion
      const blockNumber = parseInt(event.blockNumber, 16);
      const tokenId = event.label;                        // bytes32 hex (matches BaseRegistrar labelhash)
      const tokenIdDecimal = BigInt(tokenId).toString();  // decimal form for OpenSea / metadata API
      const costWei = event.totalCostWei || event.cost || '0';
      const costEth = (Number(costWei) / 1e18).toFixed(8);

      // Renewer = tx.from (anyone can renew anyone's name).
      // Defensive: if 'from' is missing, fall back to a placeholder zero address rather than
      // dropping the row — we still want to record the event for dashboards/analytics.
      const renewerAddress = (event.from || '0x0000000000000000000000000000000000000000').toLowerCase();

      // USD pricing
      let costUsd: string | undefined;
      try {
        const ethPriceUsd = await this.alchemyService.getETHPriceUSD();
        if (ethPriceUsd) {
          costUsd = (parseFloat(costEth) * ethPriceUsd).toFixed(2);
        }
      } catch (error: any) {
        logger.debug(`Failed USD conversion for renewal ${event.name}: ${error.message}`);
      }

      // Owner lookup (subgraph). If it fails, we keep going — owner will be null in the row.
      let ownerAddress: string | undefined;
      try {
        const owner = await ensSubgraphService.getOwnerByTokenId(
          tokenIdDecimal,
          ENSTokenUtils.ENS_REGISTRY_CONTRACT // BaseRegistrar — labelhash lookup
        );
        if (owner) {
          ownerAddress = owner;
        }
      } catch (error: any) {
        logger.debug(`Owner lookup failed for renewal ${event.name}: ${error.message}`);
      }

      // Metadata enrichment (image, description). Same OpenSea → ENS metadata fallback as registrations.
      const enriched = await this.enrichRenewalData(event.name, tokenIdDecimal);

      // Choose the best available name (webhook is most reliable, metadata can be a hash).
      const fullName = getBestEnsName(event.name, enriched.name, event.name);
      const ensName = fullName.replace(/\.eth$/i, '');

      // Block timestamp — QuickNode events don't include it; use current time.
      // For renewals this is acceptable since we use it for time-based filtering only,
      // and the webhook arrives within seconds of the actual block.
      const blockTimestamp = new Date().toISOString();

      return {
        transactionHash: event.txHash,
        logIndex: event.logIndex,
        contractAddress: event.contract,
        tokenId: tokenIdDecimal,
        ensName,
        fullName,
        ownerAddress,
        renewerAddress,
        costWei,
        costEth,
        costUsd,
        durationSeconds: undefined, // Not directly exposed by NameRenewed; could be derived from prev_expires later
        blockNumber,
        blockTimestamp,
        processedAt: new Date().toISOString(),
        image: enriched.image,
        description: enriched.description,
        posted: false,
        expiresAt: event.expires ? new Date(parseInt(event.expires) * 1000).toISOString() : undefined,
      };
    } catch (error: any) {
      logger.error(`❌ Failed to build renewal row for ${event.name} (tx ${event.txHash}):`, error.message);
      return null;
    }
  }

  /**
   * Enrich renewal with metadata (image, description) — mirror of enrichRegistrationData
   * in QuickNodeRegistrationService. Tries OpenSea (Base Registrar → NameWrapper) then
   * falls back to the ENS Metadata API. Returns empty object if all sources fail.
   */
  private async enrichRenewalData(
    ensName: string,
    tokenIdDecimal: string
  ): Promise<{ name?: string; image?: string; description?: string }> {
    const fullEnsName = `${ensName}.eth`;
    const baseRegistrarContract = ENSTokenUtils.ENS_REGISTRY_CONTRACT;
    const nameWrapperContract = ENSTokenUtils.NAME_WRAPPER_CONTRACT;

    const baseRegistrarTokenId = tokenIdDecimal;
    const nameWrapperTokenId = BigInt(
      ENSTokenUtils.getTokenIdForContract(nameWrapperContract, fullEnsName)
    ).toString();

    let metadata: { name?: string; image?: string; description?: string } | null = null;
    let openSeaSuccess = false;

    // 1. Try OpenSea with Base Registrar contract
    try {
      const openSeaData = await this.openSeaService.getSimplifiedMetadata(baseRegistrarContract, baseRegistrarTokenId);
      if (openSeaData && (openSeaData.name || openSeaData.image || openSeaData.description)) {
        metadata = {
          name: openSeaData.name,
          image: openSeaData.image,
          description: openSeaData.description
        };
        openSeaSuccess = true;
        logger.debug(`✅ OpenSea metadata for renewal ${ensName} via Base Registrar`);
      }
    } catch (error: any) {
      logger.debug(`OpenSea Base Registrar lookup failed for renewal ${ensName}: ${error.message}`);
    }

    // 2. Try OpenSea with NameWrapper contract
    if (!metadata) {
      try {
        const openSeaData = await this.openSeaService.getSimplifiedMetadata(nameWrapperContract, nameWrapperTokenId);
        if (openSeaData && (openSeaData.name || openSeaData.image || openSeaData.description)) {
          metadata = {
            name: openSeaData.name,
            image: openSeaData.image,
            description: openSeaData.description
          };
          openSeaSuccess = true;
          logger.debug(`✅ OpenSea metadata for renewal ${ensName} via NameWrapper`);
        }
      } catch (error: any) {
        logger.debug(`OpenSea NameWrapper lookup failed for renewal ${ensName}: ${error.message}`);
      }
    }

    // 3. Fallback to ENS Metadata service
    if (!metadata) {
      try {
        const ensData = await this.ensMetadataService.getMetadataWithFallback(baseRegistrarTokenId);
        if (ensData) {
          metadata = {
            name: ensData.name,
            image: ensData.image,
            description: ensData.description
          };
          logger.debug(`✅ ENS metadata fallback for renewal ${ensName}`);
        }
      } catch (error: any) {
        logger.debug(`ENS metadata fallback failed for renewal ${ensName}: ${error.message}`);
      }
    }

    if (metadata) {
      // Defensive: if metadata returned a token-ID hash as the "name", null it out.
      if (metadata.name && isTokenIdHash(metadata.name)) {
        logger.debug(`⚠️ Metadata returned token ID hash instead of name for renewal ${ensName}; ignoring`);
        metadata.name = undefined;
      }
      const source = openSeaSuccess ? 'OpenSea' : 'ENS Metadata';
      logger.debug(`📋 Renewal enrichment complete for ${ensName}: source=${source}, hasImage=${!!metadata.image}`);
      return metadata;
    }

    logger.debug(`⚠️ All metadata sources failed for renewal ${ensName}; row will have no image/description`);
    return {};
  }
}
