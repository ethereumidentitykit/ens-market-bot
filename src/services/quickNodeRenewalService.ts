import { logger } from '../utils/logger';
import { getBestEnsName, isTokenIdHash } from '../utils/nameUtils';
import { IDatabaseService, ENSRenewal } from '../types';
import { OpenSeaService } from './openSeaService';
import { ENSMetadataService } from './ensMetadataService';
import { AlchemyService } from './alchemyService';
import { ENSTokenUtils } from './ensTokenUtils';
import { ensSubgraphService } from './ensSubgraphService';
import { ENS_V2_REGISTRY, ENS_V2_RENEWER_V1 } from '../config/ensContracts';
import { ENSPayment, ENSPaymentEvent, eventTimestamp, getENSAsset, normalizeENSPayment, parseEventInteger } from '../utils/ensEventUtils';

// QuickNode webhook payload shape — see docs/quicknode-renewal-filter.md
export interface QuickNodeRenewalData {
  nameRenewed: QuickNodeRenewalEvent[];
}

export interface QuickNodeRenewalEvent extends ENSPaymentEvent {
  blockNumber: string;       // hex 0x-prefixed (from receipt-level)
  contract: string;          // controller address (lowercase)
  contractLabel: string | null;
  name: string;              // ENS label (without .eth)
  label?: string;            // V1 bytes32 hash; derive from name if V2 omits it
  tokenId?: string;          // V2 event token ID (may be an unminted V1 reservation)
  registryAddress?: string;
  duration?: string;
  blockTimestamp?: string | number;
  cost?: string;             // decimal wei (single field, no baseCost/premium for renewals)
  expires?: string;          // unix timestamp (decimal)
  reservationExpires?: string; // V2 reservation expiry; not the V1 NFT expiry
  referrer?: string;         // bytes32 (newest controller only)
  totalCostWei?: string;     // V1 decimal wei; V2 uses totalCostRaw/paymentToken
  totalCostEth?: string;
  // logIndex from QuickNode's decoded log is a hex string like "0x66".
  // Some sources also send decimal numbers, so accept either and normalize downstream.
  logIndex: string | number;
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
   * Price before acknowledging the webhook so a temporary quote failure can be
   * retried by QuickNode. Share each quote across the batch (including cold cache).
   */
  async prepareRenewalPayments(data: QuickNodeRenewalData): Promise<Map<QuickNodeRenewalEvent, ENSPayment>> {
    const quotes = new Map<boolean, Promise<number | null>>();
    const getQuote = (allowFallback = true) => {
      let quote = quotes.get(allowFallback);
      if (!quote) {
        quote = this.alchemyService.getETHPriceUSD(allowFallback);
        quotes.set(allowFallback, quote);
      }
      return quote;
    };
    const payments = await Promise.all(data.nameRenewed.map(async event =>
      [event, await normalizeENSPayment(event, getQuote)] as const
    ));
    return new Map(payments);
  }

  /**
   * Top-level entry point — called by the /webhook/quicknode-renewals handler.
   * Groups events by tx_hash, enriches each tx in parallel, batched-inserts per tx.
   */
  async processRenewals(data: QuickNodeRenewalData, payments?: Map<QuickNodeRenewalEvent, ENSPayment>): Promise<{
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

    // ETHRenewerV1 synchronizes NameWrapper with a zero-duration V1 renewal.
    // The paid V2 event already accounts for that name; do not tweet it twice.
    for (const [txHash, events] of eventsByTx) {
      const syncedNames = new Set(events
        .filter(event => event.contract.toLowerCase() === ENS_V2_RENEWER_V1)
        .map(event => event.name));
      eventsByTx.set(txHash, events.filter(event => !(
        event.contract.toLowerCase() === '0x253553366da8546fc250f225fe3d25d0c782303b' &&
        syncedNames.has(event.name) && BigInt(event.totalCostWei ?? event.cost ?? '-1') === 0n
      )));
    }

    logger.info(`📝 Processing ${data.nameRenewed.length} renewal event(s) across ${eventsByTx.size} tx(es)`);

    // Process each tx independently, in parallel. A failure on one tx doesn't block others.
    const txResults = await Promise.allSettled(
      Array.from(eventsByTx.entries()).map(([txHash, events]) =>
        this.processSingleTx(txHash, events, payments)
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
   * Process all events for one tx: enrich each event with concurrency limiting,
   * then do a single batched INSERT so the statement-level trigger fires once.
   *
   * Concurrency is limited to ENRICHMENT_CONCURRENCY (default 10) to avoid
   * overwhelming external APIs (each enrichment makes 3-5 HTTP requests to
   * Alchemy, ENS subgraph, OpenSea, ENS Metadata). Without limiting, a
   * 100-name bulk renewal would fire ~500 concurrent outbound requests.
   */
  private static readonly ENRICHMENT_CONCURRENCY = 30;

  private async processSingleTx(
    txHash: string,
    events: QuickNodeRenewalEvent[],
    preparedPayments?: Map<QuickNodeRenewalEvent, ENSPayment>
  ): Promise<{ inserted: number; skipped: number }> {
    logger.info(`📝 Tx ${txHash.slice(0, 10)}…: enriching ${events.length} renewal event(s) (concurrency: ${QuickNodeRenewalService.ENRICHMENT_CONCURRENCY})`);

    // Enrich in chunks to limit concurrent outbound API requests.
    const rows: Omit<ENSRenewal, 'id'>[] = [];
    let enrichFailures = 0;
    const chunkSize = QuickNodeRenewalService.ENRICHMENT_CONCURRENCY;
    // Validate/price the entire transaction before any insert. A missing quote
    // must not produce a partial bulk-renewal total and fire an incomplete tweet.
    const payments = preparedPayments ?? await this.prepareRenewalPayments({ nameRenewed: events });
    for (const event of events) {
      if (!payments.has(event)) throw new Error('Missing prepared renewal payment');
    }

    for (let i = 0; i < events.length; i += chunkSize) {
      const chunk = events.slice(i, i + chunkSize);
      const chunkResults = await Promise.allSettled(
        chunk.map(e => this.buildRenewalRow(e, payments.get(e)!))
      );

      for (const result of chunkResults) {
        if (result.status === 'fulfilled' && result.value) {
          rows.push(result.value);
        } else {
          enrichFailures++;
          if (result.status === 'rejected') {
            logger.warn(`⚠️ Enrichment failed for renewal event:`, result.reason?.message || result.reason);
          }
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
  private async buildRenewalRow(event: QuickNodeRenewalEvent, payment: ENSPayment): Promise<Omit<ENSRenewal, 'id'> | null> {
    try {
      // Basic field coercion
      const blockNumber = parseEventInteger(event.blockNumber);
      // logIndex can come through as either a hex string ("0x66") from QuickNode's
      // decoded log shape, or a plain decimal number/string. Normalize both cases.
      const logIndex = typeof event.logIndex === 'number'
        ? event.logIndex
        : (event.logIndex.startsWith('0x') ? parseInt(event.logIndex, 16) : parseInt(event.logIndex, 10));
      if (!Number.isFinite(logIndex)) {
        logger.warn(`Renewal event has malformed logIndex: ${event.logIndex} (tx ${event.txHash})`);
        return null;
      }
      const asset = getENSAsset(event);
      const tokenIdDecimal = asset.tokenId;

      // Renewer = tx.from (anyone can renew anyone's name).
      // Defensive: if 'from' is missing, fall back to a placeholder zero address rather than
      // dropping the row — we still want to record the event for dashboards/analytics.
      const renewerAddress = (event.from || '0x0000000000000000000000000000000000000000').toLowerCase();

      // V2 uses its registry state (including grace-period ownership); V1 names
      // renewed through ETHRenewerV1 still use the legacy owner lookup.
      let ownerAddress: string | undefined;
      try {
        const owner = asset.contract === ENS_V2_REGISTRY
          ? await this.alchemyService.getENSV2Owner(asset.labelHash, blockNumber)
          : await ensSubgraphService.getOwnerByTokenId(tokenIdDecimal, ENSTokenUtils.ENS_REGISTRY_CONTRACT);
        if (owner) {
          ownerAddress = owner;
        }
      } catch (error: any) {
        logger.debug(`Owner lookup failed for renewal ${event.name}: ${error.message}`);
      }

      // Metadata enrichment (image, description). Same OpenSea → ENS metadata fallback as registrations.
      const enriched = await this.enrichRenewalData(event.name, tokenIdDecimal, asset.contract);

      // Choose the best available name (webhook is most reliable, metadata can be a hash).
      const fullName = getBestEnsName(event.name, enriched.name, event.name);
      const ensName = fullName.replace(/\.eth$/i, '');

      // Prefer stream block time; preserve the receipt-only fallback for legacy streams.
      const blockTimestamp = eventTimestamp(event.blockTimestamp) || new Date().toISOString();
      let expiry = event.expires;
      if (expiry == null && event.contract.toLowerCase() === ENS_V2_RENEWER_V1) {
        const legacyExpiry = await this.alchemyService.getENSV1Expiry(asset.labelHash, blockNumber);
        expiry = legacyExpiry == null ? undefined : String(legacyExpiry);
      }

      return {
        transactionHash: event.txHash,
        logIndex,
        contractAddress: event.contract,
        tokenId: tokenIdDecimal,
        ensName,
        fullName,
        ownerAddress,
        renewerAddress,
        ...payment,
        durationSeconds: event.duration == null ? undefined : parseEventInteger(event.duration),
        blockNumber,
        blockTimestamp,
        processedAt: new Date().toISOString(),
        image: enriched.image,
        description: enriched.description,
        posted: false,
        expiresAt: eventTimestamp(expiry),
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
    tokenIdDecimal: string,
    registryContract: string
  ): Promise<{ name?: string; image?: string; description?: string }> {
    if (registryContract === ENS_V2_REGISTRY) {
      try {
        const metadata = await this.openSeaService.getSimplifiedMetadata(registryContract, tokenIdDecimal);
        if (metadata && (metadata.name || metadata.image || metadata.description)) return metadata;
      } catch (error: any) {
        logger.debug(`OpenSea ENSv2 metadata unavailable: ${error.message}`);
      }
      return (await this.ensMetadataService.getMetadata(registryContract, tokenIdDecimal).catch(() => null)) || {};
    }
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
