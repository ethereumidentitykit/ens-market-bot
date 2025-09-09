import { logger } from '../utils/logger';
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
  private readonly NATIVE_ETH_ITEM_TYPE = 0;
  private readonly MIN_PRICE_ETH = 0.01; // Minimum price filter
  
  // Known marketplace intermediaries that indicate proxy contracts
  private readonly PROBLEMATIC_INTERMEDIARIES = [
    '0x0000a26b00c1F0DF003000390027140000fAa719', // OpenSea WETH wrapper (124x in logs)
    '0xE6EE2b1eaAc6520bE709e77780Abb50E7fFfcCCd', // Proxy contract (196x in logs)
    '0x00ca04c45da318d5b7e7b14d5381ca59f09c73f0', // Additional proxy contract
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

        // Check if already processed
        const isAlreadyProcessed = await this.databaseService.isSaleProcessed(saleData.tokenId);
        if (isAlreadyProcessed) {
          results.skipped++;
          logger.info(`⚡ QuickNode sale already processed: ${saleData.tokenId} (${order.txHash})`);
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
        
        logger.info(`✅ QuickNode sale stored: ${enrichedSale.nftName} (${enrichedSale.priceEth} ETH) - ID: ${saleId}`);
        
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
    priceEth: string;
    blockNumber: number;
    blockTimestamp: string;
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

      // Find ETH/WETH payments in either consideration OR offer
      // (depends on whether we're looking at buyer or seller perspective)
      const ethPaymentsInConsideration = order.consideration?.filter(item => 
        item.itemType === this.NATIVE_ETH_ITEM_TYPE || // Native ETH
        item.token.toLowerCase() === this.WETH_ADDRESS.toLowerCase() // WETH
      ) || [];
      
      const ethPaymentsInOffer = order.offer?.filter(item => 
        item.itemType === this.NATIVE_ETH_ITEM_TYPE || // Native ETH
        item.token.toLowerCase() === this.WETH_ADDRESS.toLowerCase() // WETH
      ) || [];

      const ethPayments = [...ethPaymentsInConsideration, ...ethPaymentsInOffer];

      if (ethPayments.length === 0) {
        logger.debug(`No ETH/WETH payments found in order ${order.orderHash}`);
        return null;
      }

      // Sum all ETH payments (seller gets multiple payments due to fees)
      const totalWei = ethPayments.reduce((sum, payment) => {
        return sum + BigInt(payment.amount);
      }, BigInt(0));

      const priceEth = (Number(totalWei) / 1e18).toString();
      
      // Apply minimum price filter
      if (parseFloat(priceEth) < this.MIN_PRICE_ETH) {
        logger.debug(`Sale below minimum price: ${priceEth} ETH < ${this.MIN_PRICE_ETH} ETH`);
        return null;
      }

      // Find the seller: the recipient of the largest ETH payment (main sale amount)
      // In Seaport, the seller gets the main payment, marketplace gets fees
      // Only consideration items have recipients, offer items don't
      const ethPaymentsWithRecipients = ethPaymentsInConsideration.length > 0 
        ? ethPaymentsInConsideration 
        : ethPaymentsInOffer;
      
      if (ethPaymentsWithRecipients.length === 0) {
        logger.debug(`No ETH payments with recipients found in order ${order.orderHash}`);
        return null;
      }
      
      const mainPayment = ethPaymentsWithRecipients.reduce((max, payment) => 
        BigInt(payment.amount) > BigInt(max.amount) ? payment : max
      );
      
      let sellerAddress = ('recipient' in mainPayment) 
        ? (mainPayment as any).recipient.toLowerCase()
        : order.offerer.toLowerCase(); // Fallback to offerer if no recipient
      let buyerAddress = order.recipient.toLowerCase();

      // Check for proxy contracts and resolve real addresses via OpenSea Events API
      const hasProxyContract = this.PROBLEMATIC_INTERMEDIARIES.includes(buyerAddress) || 
                              this.PROBLEMATIC_INTERMEDIARIES.includes(sellerAddress);

      if (hasProxyContract) {
        logger.debug(`🔍 Proxy contract detected (buyer: ${buyerAddress}, seller: ${sellerAddress}) - resolving via OpenSea Events API`);
        
        try {
          // Use transaction hash to match exact sale event
          const resolvedAddresses = await this.openSeaService.getEventAddresses(
            ensToken.token, 
            ensToken.identifier, 
            order.txHash
          );

          if (resolvedAddresses) {
            logger.info(`✅ Proxy addresses resolved - Original: buyer=${buyerAddress}, seller=${sellerAddress} → Real: buyer=${resolvedAddresses.buyer}, seller=${resolvedAddresses.seller}`);
            buyerAddress = resolvedAddresses.buyer;
            sellerAddress = resolvedAddresses.seller;
          } else {
            logger.warn(`⚠️ Failed to resolve proxy addresses via OpenSea API - keeping original addresses`);
          }
        } catch (error: any) {
          logger.error(`❌ Error resolving proxy addresses: ${error.message} - keeping original addresses`);
        }
      }

      // Validation: buyer and seller should be different
      if (buyerAddress === sellerAddress) {
        logger.warn(`⚠️ Buyer and seller are the same address: ${buyerAddress} - this may indicate a self-transfer or parsing error`);
      }

      // Convert hex block number to decimal
      const blockNumber = parseInt(order.blockNumber, 16);
      
      // Use current timestamp as fallback (matches existing sales processing behavior)
      // TODO: Could fetch actual block timestamp from Alchemy if needed for accuracy
      const blockTimestamp = new Date().toISOString();

      return {
        transactionHash: order.txHash,
        contractAddress: ensToken.token.toLowerCase(),
        tokenId: ensToken.identifier,
        buyerAddress,
        sellerAddress,
        priceEth,
        blockNumber,
        blockTimestamp
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
    priceEth: string;
    blockNumber: number;
    blockTimestamp: string;
  }): Promise<Omit<ProcessedSale, 'id'> | null> {
    try {
      logger.debug(`Enriching sale data for token ${saleData.tokenId}`);

      // 1. Get USD price using Alchemy service (with caching and $4000 fallback)
      const ethPriceUsd = await this.alchemyService.getETHPriceUSD();
      const usdValue = parseFloat(saleData.priceEth) * ethPriceUsd!; // ethPriceUsd never null due to fallback
      const priceUsd = usdValue.toFixed(2);

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
            nftImage = nftImage || ensData.image;
            
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

      // 4. Require essential metadata for storage
      if (!nftName) {
        logger.error(`❌ No NFT name found for ${saleData.tokenId} - cannot store without metadata`);
        return null;
      }

      // 5. Log enrichment summary
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
        priceEth: saleData.priceEth,
        priceUsd,
        blockNumber: saleData.blockNumber,
        blockTimestamp: saleData.blockTimestamp,
        processedAt: new Date().toISOString(),
        posted: false,
        // Enriched metadata (no description)
        collectionName: collectionName || 'ENS',
        nftName,
        nftImage,
        nftDescription: undefined, // Explicitly don't store description
        verifiedCollection: true // ENS is always verified
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

      // Check for ETH/WETH payments in either consideration or offer
      const ethPaymentsInConsideration = order.consideration?.filter(item => 
        item.itemType === this.NATIVE_ETH_ITEM_TYPE || // Native ETH
        item.token.toLowerCase() === this.WETH_ADDRESS.toLowerCase() // WETH
      ) || [];
      
      const ethPaymentsInOffer = order.offer?.filter(item => 
        item.itemType === this.NATIVE_ETH_ITEM_TYPE || // Native ETH
        item.token.toLowerCase() === this.WETH_ADDRESS.toLowerCase() // WETH
      ) || [];

      const ethPayments = [...ethPaymentsInConsideration, ...ethPaymentsInOffer];

      if (ethPayments.length === 0) {
        return 'no ETH/WETH payments found';
      }

      // Check minimum price
      const totalWei = ethPayments.reduce((sum, payment) => {
        return sum + BigInt(payment.amount);
      }, BigInt(0));

      const priceEth = Number(totalWei) / 1e18;
      
      if (priceEth < this.MIN_PRICE_ETH) {
        return `price ${priceEth.toFixed(4)} ETH < ${this.MIN_PRICE_ETH} ETH minimum`;
      }

      return 'unknown reason';
    } catch (error: any) {
      return `error parsing order: ${error.message}`;
    }
  }
}