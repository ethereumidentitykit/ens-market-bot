import { logger } from '../utils/logger';
import { getBestEnsName, isTokenIdHash } from '../utils/nameUtils';
import { ProcessedSale, IDatabaseService } from '../types';
import { OpenSeaService } from './openSeaService';
import { ENSMetadataService } from './ensMetadataService';
import { AlchemyService } from './alchemyService';

interface SeaportOrder {
  orderHash: string;
  txHash: string;
  blockNumber: string;
  contract: string;
  contractLabel: string;
  offerer: string;
  recipient: string;
  zone: string;
  logIndex: string;
  offer: Array<{
    itemType: number;
    token: string;
    identifier: string;
    amount: string;
  }>;
  consideration: Array<{
    itemType: number;
    token: string;
    identifier: string;
    amount: string;
    recipient: string;
  }>;
  // Fee recipient data from QuickNode filter
  fee?: {
    recipient: string;
    amount: string;
    percent: number;
  };
}

interface QuickNodeWebhookData {
  orderFulfilled: SeaportOrder[];
}

/**
 * QuickNode Sales Processing Service
 * Processes Seaport orderFulfilled events from QuickNode webhooks
 * Enriches with metadata and stores as ProcessedSale records
 */
export class QuickNodeSalesService {
  private readonly ENS_REGISTRY = '0x57f1887a8BF19b14fC0dF6Fd9B2acc9Af147eA85';
  private readonly ENS_NAMEWRAPPER = '0xD4416b13d2b3a9aBae7AcD5D6C2BbDBE25686401';
  private readonly WETH_ADDRESS = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2';
  private readonly USDC_ADDRESS = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
  private readonly USDT_ADDRESS = '0xdAC17F958D2ee523a2206206994597C13D831ec7';
  private readonly NATIVE_ETH_ITEM_TYPE = 0;
  private readonly MIN_PRICE_ETH = 0.01;
  private readonly STABLECOIN_DECIMALS = 6;
  
  // Known marketplace intermediaries that indicate proxy contracts
  private readonly PROBLEMATIC_INTERMEDIARIES = [
    '0x0000a26b00c1F0DF003000390027140000fAa719', // OpenSea WETH wrapper (124x in logs)
    '0xE6EE2b1eaAc6520bE709e77780Abb50E7fFfcCCd', // Proxy contract (196x in logs)
    '0x00ca04c45da318d5b7e7b14d5381ca59f09c73f0', // Additional proxy contract
    '0x0000a26b00c1f0df003000390027140000faa719', // Additional proxy contract
  ];

  constructor(
    private databaseService: IDatabaseService,
    private openSeaService: OpenSeaService,
    private ensMetadataService: ENSMetadataService,
    private alchemyService: AlchemyService
  ) {}

  /**
   * Process QuickNode webhook data and store enriched sales
   * @param webhookData - Raw webhook data from QuickNode
   * @returns Processing results
   */
  async processWebhookData(webhookData: QuickNodeWebhookData): Promise<{
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

    if (!webhookData.orderFulfilled || !Array.isArray(webhookData.orderFulfilled)) {
      logger.warn('No orderFulfilled data in webhook');
      return results;
    }

    logger.info(`🚀 Processing ${webhookData.orderFulfilled.length} QuickNode orders`);

    // Track (tokenId, txHash) pairs within this batch to prevent duplicate ingestion
    const seenInBatch = new Set<string>();

    for (const order of webhookData.orderFulfilled) {
      try {
        results.processed++;
        
        // Extract ENS sale data from Seaport order
        const saleData = await this.extractSaleData(order);
        
        if (!saleData) {
          results.skipped++;
          const skipReason = this.getSkipReason(order);
          logger.info(`Skipped order ${order.orderHash} - ${skipReason}`);
          continue;
        }

        // Check if we've already processed this (tokenId, txHash) pair in this batch
        const batchKey = `${saleData.tokenId}:${saleData.transactionHash}`;
        if (seenInBatch.has(batchKey)) {
          results.skipped++;
          logger.info(`🔁 Duplicate token in same tx - skipping: ${saleData.tokenId} (tx: ${saleData.transactionHash.slice(0, 10)}..., log: ${saleData.logIndex})`);
          continue;
        }
        seenInBatch.add(batchKey);

        // Check if already processed (using transaction hash + log index)
        const isAlreadyProcessed = await this.databaseService.isSaleProcessed(
          saleData.transactionHash, 
          saleData.logIndex
        );
        if (isAlreadyProcessed) {
          results.skipped++;
          logger.info(`⚡ QuickNode sale already processed: ${saleData.tokenId} (tx: ${order.txHash}, log: ${saleData.logIndex})`);
          continue;
        }

        // Enrich with metadata
        const enrichedSale = await this.enrichSaleData(saleData);
        
        if (!enrichedSale) {
          results.errors++;
          logger.warn(`Failed to enrich sale data for ${saleData.tokenId} - skipping storage`);
          continue;
        }

        // Store in database
        const saleId = await this.databaseService.insertSale(enrichedSale);
        results.stored++;
        
        logger.info(`✅ QuickNode sale stored: ${enrichedSale.nftName} (${enrichedSale.priceAmount} ${enrichedSale.currencySymbol || 'ETH'}) - ID: ${saleId}`);
        
      } catch (error: any) {
        results.errors++;
        logger.error(`Error processing QuickNode order ${order.orderHash}:`, error.message);
      }
    }

    logger.info(`🎯 QuickNode processing complete: ${results.stored} stored, ${results.skipped} skipped, ${results.errors} errors`);
    return results;
  }

  /**
   * Extract sale data from Seaport order
   * @param order - Seaport orderFulfilled event
   * @returns Basic sale data or null if not a valid ENS sale
   */
  private async extractSaleData(order: SeaportOrder): Promise<{
    transactionHash: string;
    contractAddress: string;
    tokenId: string;
    buyerAddress: string;
    sellerAddress: string;
    priceAmount: string;
    currencySymbol: string;
    blockNumber: number;
    blockTimestamp: string;
    logIndex: number;
    feeRecipientAddress?: string;
    feeAmountWei?: string;
    feePercent?: number;
  } | null> {
    try {
      // Find ENS token in either offer OR consideration 
      // (Seaport orders can represent either buyer or seller perspective)
      const ensTokenInOffer = order.offer?.find(item => 
        item.token.toLowerCase() === this.ENS_REGISTRY.toLowerCase() ||
        item.token.toLowerCase() === this.ENS_NAMEWRAPPER.toLowerCase()
      );
      
      const ensTokenInConsideration = order.consideration?.find(item => 
        item.token.toLowerCase() === this.ENS_REGISTRY.toLowerCase() ||
        item.token.toLowerCase() === this.ENS_NAMEWRAPPER.toLowerCase()
      );

      const ensToken = ensTokenInOffer || ensTokenInConsideration;

      if (!ensToken) {
        return null; // Not an ENS sale
      }

      // Find payments: try ETH/WETH first, then stablecoins
      const allItems = [...(order.consideration || []), ...(order.offer || [])];

      const ethPayments = allItems.filter(item =>
        item.itemType === this.NATIVE_ETH_ITEM_TYPE ||
        item.token.toLowerCase() === this.WETH_ADDRESS.toLowerCase()
      );

      const stablecoinPayments = allItems.filter(item =>
        item.token.toLowerCase() === this.USDC_ADDRESS.toLowerCase() ||
        item.token.toLowerCase() === this.USDT_ADDRESS.toLowerCase()
      );

      let priceAmount: string;
      let currencySymbol: string;

      if (ethPayments.length > 0) {
        const totalWei = ethPayments.reduce((sum, p) => sum + BigInt(p.amount), BigInt(0));
        priceAmount = (Number(totalWei) / 1e18).toString();
        currencySymbol = 'ETH';
      } else if (stablecoinPayments.length > 0) {
        const totalUnits = stablecoinPayments.reduce((sum, p) => sum + BigInt(p.amount), BigInt(0));
        priceAmount = (Number(totalUnits) / 10 ** this.STABLECOIN_DECIMALS).toString();
        const tokenAddr = stablecoinPayments[0].token.toLowerCase();
        currencySymbol = tokenAddr === this.USDC_ADDRESS.toLowerCase() ? 'USDC' : 'USDT';
      } else {
        logger.debug(`No ETH/WETH/USDC/USDT payments found in order ${order.orderHash}`);
        return null;
      }

      // Apply minimum price filter (ETH-equivalent)
      const priceNum = parseFloat(priceAmount);
      if (currencySymbol === 'ETH' && priceNum < this.MIN_PRICE_ETH) {
        logger.debug(`Sale below minimum price: ${priceAmount} ETH < ${this.MIN_PRICE_ETH} ETH`);
        return null;
      } else if (currencySymbol !== 'ETH') {
        const ethPrice = await this.alchemyService.getETHPriceUSD();
        const ethEquiv = ethPrice ? priceNum / ethPrice : 0;
        if (ethEquiv < this.MIN_PRICE_ETH) {
          logger.debug(`Sale below minimum price: ${priceAmount} ${currencySymbol} (~${ethEquiv.toFixed(4)} ETH) < ${this.MIN_PRICE_ETH} ETH`);
          return null;
        }
      }

      // Find the seller: the recipient of the largest payment (main sale amount)
      // In Seaport, the seller gets the main payment, marketplace gets fees
      // Only consideration items have recipients, offer items don't
      const payments = ethPayments.length > 0 ? ethPayments : stablecoinPayments;
      const paymentsInConsideration = (order.consideration || []).filter(item =>
        payments.some(p => p.token === item.token && p.amount === item.amount)
      );
      const paymentsInOffer = (order.offer || []).filter(item =>
        payments.some(p => p.token === item.token && p.amount === item.amount)
      );
      const paymentsWithRecipients = paymentsInConsideration.length > 0
        ? paymentsInConsideration
        : paymentsInOffer;

      if (paymentsWithRecipients.length === 0) {
        logger.debug(`No payments with recipients found in order ${order.orderHash}`);
        return null;
      }
      
      const mainPayment = paymentsWithRecipients.reduce((max, payment) => 
        BigInt(payment.amount) > BigInt(max.amount) ? payment : max
      );
      
      // Determine buyer/seller based on transaction type (where ENS token appears)
      let buyerAddress: string;
      let sellerAddress: string;

      if (ensTokenInOffer && !ensTokenInConsideration) {
        // Type 1: Direct Listing - ENS in offer (seller lists ENS for sale)
        buyerAddress = order.recipient.toLowerCase();  // Who gets the ENS
        sellerAddress = order.offerer.toLowerCase();   // Who listed the ENS
        logger.debug(`📋 Direct listing detected - Seller: ${sellerAddress}, Buyer: ${buyerAddress}`);
        
      } else if (ensTokenInConsideration && !ensTokenInOffer) {
        // Type 2: Accepted Offer - ENS in consideration (buyer's offer accepted)
        buyerAddress = ensTokenInConsideration.recipient.toLowerCase(); // Who gets the ENS
        sellerAddress = order.recipient.toLowerCase(); // Who gets the WETH payment
        logger.debug(`🤝 Accepted offer detected - Seller: ${sellerAddress}, Buyer: ${buyerAddress}`);
        
      } else {
        // Fallback to original logic for edge cases
        sellerAddress = ('recipient' in mainPayment) 
          ? (mainPayment as any).recipient.toLowerCase()
          : order.offerer.toLowerCase();
        buyerAddress = order.recipient.toLowerCase();
        logger.warn(`⚠️ Ambiguous transaction type - using fallback logic`);
      }

      // Check for proxy contracts and resolve real addresses via OpenSea Events API
      const hasProxyContract = this.PROBLEMATIC_INTERMEDIARIES.includes(buyerAddress) || 
                              this.PROBLEMATIC_INTERMEDIARIES.includes(sellerAddress);

      if (hasProxyContract) {
        logger.debug(`🔍 Proxy contract detected (buyer: ${buyerAddress}, seller: ${sellerAddress}) - resolving via OpenSea Events API`);
        
        try {
          // Use transaction hash to match exact sale event and pass known proxy addresses
          const resolvedAddresses = await this.openSeaService.getEventAddresses(
            ensToken.token, 
            ensToken.identifier, 
            order.txHash,
            this.PROBLEMATIC_INTERMEDIARIES
          );

          if (resolvedAddresses) {
            buyerAddress = resolvedAddresses.buyer;
            sellerAddress = resolvedAddresses.seller;
          } else {
            logger.warn(`⚠️ Failed to resolve proxy addresses via OpenSea API after retries - using 'unknown' fallback`);
            
            // Replace proxy addresses with "unknown" for clearer user experience
            if (this.PROBLEMATIC_INTERMEDIARIES.includes(buyerAddress)) {
              buyerAddress = 'unknown';
              logger.debug(`🔄 Replaced proxy buyer address with 'unknown'`);
            }
            
            if (this.PROBLEMATIC_INTERMEDIARIES.includes(sellerAddress)) {
              sellerAddress = 'unknown'; 
              logger.debug(`🔄 Replaced proxy seller address with 'unknown'`);
            }
          }
        } catch (error: any) {
          logger.error(`❌ Error resolving proxy addresses: ${error.message} - using 'unknown' fallback`);
          
          // Replace proxy addresses with "unknown" even on error
          if (this.PROBLEMATIC_INTERMEDIARIES.includes(buyerAddress)) {
            buyerAddress = 'unknown';
            logger.debug(`🔄 Replaced proxy buyer address with 'unknown' (error fallback)`);
          }
          
          if (this.PROBLEMATIC_INTERMEDIARIES.includes(sellerAddress)) {
            sellerAddress = 'unknown'; 
            logger.debug(`🔄 Replaced proxy seller address with 'unknown' (error fallback)`);
          }
        }
      }

      // Validation: buyer and seller should be different (except when both are "unknown")
      if (buyerAddress === sellerAddress && buyerAddress !== 'unknown') {
        logger.warn(`⚠️ Buyer and seller are the same address: ${buyerAddress} - this may indicate a self-transfer or parsing error`);
      }

      // Convert hex block number and log index to decimal
      const blockNumber = parseInt(order.blockNumber, 16);
      const logIndex = parseInt(order.logIndex, 16);
      
      // Use current timestamp as fallback (matches existing sales processing behavior)
      // TODO: Could fetch actual block timestamp from Alchemy if needed for accuracy
      const blockTimestamp = new Date().toISOString();

      // Log fee extraction if present
      if (order.fee) {
        logger.debug(`💰 Fee recipient detected: ${order.fee.recipient} (${order.fee.percent}%, ${order.fee.amount} wei)`);
      }

      return {
        transactionHash: order.txHash,
        contractAddress: ensToken.token.toLowerCase(),
        tokenId: ensToken.identifier,
        buyerAddress,
        sellerAddress,
        priceAmount,
        currencySymbol,
        blockNumber,
        blockTimestamp,
        logIndex,
        // Fee recipient data from QuickNode filter
        feeRecipientAddress: order.fee?.recipient,
        feeAmountWei: order.fee?.amount,
        feePercent: order.fee?.percent
      };
      
    } catch (error: any) {
      logger.error(`Error extracting sale data from order ${order.orderHash}:`, error.message);
      return null;
    }
  }

  /**
   * Enrich sale data with metadata from OpenSea and ENS APIs
   * @param saleData - Basic sale data
   * @returns Enriched ProcessedSale or null if enrichment fails
   */
  private async enrichSaleData(saleData: {
    transactionHash: string;
    contractAddress: string;
    tokenId: string;
    buyerAddress: string;
    sellerAddress: string;
    priceAmount: string;
    currencySymbol: string;
    blockNumber: number;
    blockTimestamp: string;
    logIndex: number;
    feeRecipientAddress?: string;
    feeAmountWei?: string;
    feePercent?: number;
  }): Promise<Omit<ProcessedSale, 'id'> | null> {
    try {
      logger.debug(`Enriching sale data for token ${saleData.tokenId}`);

      // 1. Calculate USD price based on currency
      let priceUsd: string;
      const symbol = saleData.currencySymbol.toUpperCase();
      if (symbol === 'USDC' || symbol === 'USDT' || symbol === 'DAI') {
        priceUsd = parseFloat(saleData.priceAmount).toFixed(2);
      } else {
        const ethPriceUsd = await this.alchemyService.getETHPriceUSD();
        priceUsd = (parseFloat(saleData.priceAmount) * ethPriceUsd!).toFixed(2);
      }

      // 2. Try OpenSea first for metadata
      let nftName: string | undefined;
      let nftImage: string | undefined;
      let collectionName: string | undefined;
      let openSeaSuccess = false;

      logger.info(`🔍 Enriching ${saleData.tokenId} - trying OpenSea first...`);
      try {
        const openSeaData = await this.openSeaService.getSimplifiedMetadata(
          saleData.contractAddress,
          saleData.tokenId
        );
        
        if (openSeaData) {
          nftName = openSeaData.name;
          nftImage = openSeaData.image;
          collectionName = openSeaData.collection;
          openSeaSuccess = true;
          logger.info(`✅ OpenSea metadata success: ${nftName} (${collectionName})`);
        } else {
          logger.warn(`⚠️ OpenSea returned null for ${saleData.tokenId}`);
        }
      } catch (error: any) {
        logger.warn(`❌ OpenSea metadata failed for ${saleData.tokenId}: ${error.message}`);
      }

      // 3. Fallback to ENS Metadata service if OpenSea failed
      if (!nftName || !nftImage) {
        logger.warn(`⚠️ Falling back to ENS Metadata API for ${saleData.tokenId} (OpenSea incomplete)`);
        try {
          const ensData = await this.ensMetadataService.getMetadata(
            saleData.contractAddress,
            saleData.tokenId
          );
          
          if (ensData) {
            const beforeName = nftName;
            const beforeImage = nftImage;
            nftName = nftName || ensData.name;
            nftImage = nftImage || ensData.image || ensData.image_url; // Use image_url as fallback
            
            const fieldsFromEns = [];
            if (!beforeName && nftName) fieldsFromEns.push('name');
            if (!beforeImage && nftImage) fieldsFromEns.push('image');
            
            logger.info(`✅ ENS metadata fallback success: ${nftName} (provided: ${fieldsFromEns.join(', ')})`);
          } else {
            logger.error(`❌ ENS metadata fallback returned null for ${saleData.tokenId}`);
          }
        } catch (error: any) {
          logger.error(`❌ ENS metadata fallback failed for ${saleData.tokenId}: ${error.message}`);
        }
      }

      // 4. Validate name quality (detect token ID hashes)
      if (nftName && isTokenIdHash(nftName)) {
        logger.error(`❌ Metadata returned token ID hash instead of name: "${nftName.substring(0, 30)}..." - cannot post sale without valid name`);
        logger.warn(`⚠️ Skipping sale ${saleData.transactionHash} due to invalid metadata`);
        return null;
      }

      // 5. Require essential metadata for storage
      if (!nftName) {
        logger.error(`❌ No NFT name found for ${saleData.tokenId} - cannot store without metadata`);
        return null;
      }

      // 6. Log enrichment summary
      const enrichmentSource = openSeaSuccess ? 'OpenSea' : 'ENS Metadata (fallback)';
      logger.info(`📋 Enrichment complete for ${nftName}: metadata=${enrichmentSource}, hasImage=${!!nftImage}, priceUSD=$${priceUsd} (Alchemy)`);

      // 6. Build ProcessedSale object
      const processedSale: Omit<ProcessedSale, 'id'> = {
        transactionHash: saleData.transactionHash,
        contractAddress: saleData.contractAddress,
        tokenId: saleData.tokenId,
        marketplace: '', // Leave empty as requested
        buyerAddress: saleData.buyerAddress,
        sellerAddress: saleData.sellerAddress,
        priceAmount: saleData.priceAmount,
        priceUsd,
        currencySymbol: saleData.currencySymbol,
        blockNumber: saleData.blockNumber,
        blockTimestamp: saleData.blockTimestamp,
        logIndex: saleData.logIndex,
        processedAt: new Date().toISOString(),
        posted: false,
        // Enriched metadata (no description)
        collectionName: collectionName || 'ENS',
        nftName,
        nftImage,
        nftDescription: undefined, // Explicitly don't store description
        verifiedCollection: true, // ENS is always verified
        // Fee recipient data (broker/referral)
        feeRecipientAddress: saleData.feeRecipientAddress,
        feeAmountWei: saleData.feeAmountWei,
        feePercent: saleData.feePercent
      };

      return processedSale;
      
    } catch (error: any) {
      logger.error(`Error enriching sale data for ${saleData.tokenId}:`, error.message);
      return null;
    }
  }

  /**
   * Get detailed reason why an order was skipped
   * @param order - Seaport orderFulfilled event
   * @returns Human-readable skip reason
   */
  private getSkipReason(order: SeaportOrder): string {
    try {
      // Check if it's an ENS token (in either offer or consideration)
      const ensTokenInOffer = order.offer?.find(item => 
        item.token.toLowerCase() === this.ENS_REGISTRY.toLowerCase() ||
        item.token.toLowerCase() === this.ENS_NAMEWRAPPER.toLowerCase()
      );
      
      const ensTokenInConsideration = order.consideration?.find(item => 
        item.token.toLowerCase() === this.ENS_REGISTRY.toLowerCase() ||
        item.token.toLowerCase() === this.ENS_NAMEWRAPPER.toLowerCase()
      );

      const ensToken = ensTokenInOffer || ensTokenInConsideration;

      if (!ensToken) {
        return 'not an ENS token';
      }

      // Check for payments (ETH/WETH or stablecoins)
      const allItems = [...(order.consideration || []), ...(order.offer || [])];
      const hasEth = allItems.some(item =>
        item.itemType === this.NATIVE_ETH_ITEM_TYPE ||
        item.token.toLowerCase() === this.WETH_ADDRESS.toLowerCase()
      );
      const hasStablecoin = allItems.some(item =>
        item.token.toLowerCase() === this.USDC_ADDRESS.toLowerCase() ||
        item.token.toLowerCase() === this.USDT_ADDRESS.toLowerCase()
      );

      if (!hasEth && !hasStablecoin) {
        return 'no ETH/WETH/USDC/USDT payments found';
      }

      if (hasEth) {
        const totalWei = allItems
          .filter(item => item.itemType === this.NATIVE_ETH_ITEM_TYPE || item.token.toLowerCase() === this.WETH_ADDRESS.toLowerCase())
          .reduce((sum, p) => sum + BigInt(p.amount), BigInt(0));
        const priceEthVal = Number(totalWei) / 1e18;
        if (priceEthVal < this.MIN_PRICE_ETH) {
          return `price ${priceEthVal.toFixed(4)} ETH < ${this.MIN_PRICE_ETH} ETH minimum`;
        }
      }

      return 'unknown reason';
    } catch (error: any) {
      return `error parsing order: ${error.message}`;
    }
  }
}