import { IDatabaseService } from '../types';
import { ProcessedSale } from '../types';
import { ENSWorkerService, ResolvedProfile } from './ensWorkerService';
import { ImageData } from '../types/imageTypes';
import { PuppeteerImageService } from './puppeteerImageService';
import { OpenSeaService } from './openSeaService';
import { logger } from '../utils/logger';

/**
 * Real data interface for image generation
 */
export interface RealImageData {
  priceEth: number;
  priceUsd: number;
  ensName: string;
  buyerEns: string;
  sellerEns: string;
  buyerAvatar?: string;
  sellerAvatar?: string;
  nftImageUrl?: string;
  saleId?: number;
  transactionHash?: string;
  // NFT contract info for metadata fallbacks
  contractAddress?: string;
  tokenId?: string;
  currencySymbol?: string;
}

/**
 * Service for generating images using real database data with EthIdentityKit integration
 */
export class RealDataImageService {
  constructor(
    private databaseService: IDatabaseService,
    private ethIdentityService: ENSWorkerService,
    private openSeaService?: OpenSeaService
  ) {}

  /**
   * Get a sale by token ID or transaction hash prefix
   */
  async getSaleByTokenPrefix(tokenPrefix: string): Promise<RealImageData | null> {
    try {
      logger.info(`Searching for sale with token/TX prefix: ${tokenPrefix}`);
      
      // Get recent sales from database (we'll search in the most recent 1000 sales)
      const recentSales = await this.databaseService.getRecentSales(1000);
      
      if (!recentSales || recentSales.length === 0) {
        logger.warn('No recent sales found in database');
        return null;
      }

      let matchingSale;

      // Check if input looks like a transaction hash (starts with 0x) or token ID (numeric)
      if (tokenPrefix.toLowerCase().startsWith('0x')) {
        // Search by transaction hash prefix (case insensitive)
        matchingSale = recentSales.find(sale => 
          sale.transactionHash.toLowerCase().startsWith(tokenPrefix.toLowerCase())
        );
        logger.info(`Searching by transaction hash prefix: ${tokenPrefix}`);
      } else if (/^\d+$/.test(tokenPrefix)) {
        // Search by token ID (exact match)
        matchingSale = recentSales.find(sale => sale.tokenId === tokenPrefix);
        logger.info(`Searching by token ID: ${tokenPrefix}`);
      } else {
        // Try both: first as transaction hash prefix, then look for numeric match
        matchingSale = recentSales.find(sale => 
          sale.transactionHash.toLowerCase().startsWith(tokenPrefix.toLowerCase())
        );
        if (!matchingSale && /^\d/.test(tokenPrefix)) {
          // If starts with digit, try as token ID prefix
          matchingSale = recentSales.find(sale => 
            sale.tokenId && sale.tokenId.startsWith(tokenPrefix)
          );
        }
        logger.info(`Searching by mixed prefix: ${tokenPrefix}`);
      }
      
      if (!matchingSale) {
        logger.warn(`No sale found with token/TX prefix: ${tokenPrefix}`);
        return null;
      }
      
      logger.info(`Found matching sale: ${matchingSale.transactionHash} - ${matchingSale.priceAmount} ${matchingSale.currencySymbol || 'ETH'} (Token ID: ${matchingSale.tokenId})`);
      return await this.convertSaleToImageData(matchingSale);
      
    } catch (error) {
      logger.error('Error fetching sale by token/TX prefix:', error);
      return null;
    }
  }

  /**
   * Get a random recent sale for testing image generation
   */
  async getRandomRecentSale(): Promise<RealImageData | null> {
    try {
      logger.info('Fetching random recent sale for image generation...');
      
      // Get recent sales from database (last 50 sales)
      const recentSales = await this.databaseService.getRecentSales(50);
      
      if (!recentSales || recentSales.length === 0) {
        logger.warn('No recent sales found in database');
        return null;
      }

      // Pick a random sale
      const randomIndex = Math.floor(Math.random() * recentSales.length);
      const sale = recentSales[randomIndex];
      
      logger.info(`Selected sale: ${sale.transactionHash} - ${sale.priceAmount} ${sale.currencySymbol || 'ETH'}`);

      return await this.convertSaleToImageData(sale);
      
    } catch (error) {
      logger.error('Error fetching random recent sale:', error);
      return null;
    }
  }

  /**
   * Get specific sale by transaction hash for image generation
   * Uses getRecentSales and filters by hash since getSaleByHash doesn't exist
   */
  async getSaleByHash(transactionHash: string): Promise<RealImageData | null> {
    try {
      logger.info(`Fetching sale by hash: ${transactionHash}`);
      
      // Get recent sales and find the one with matching hash
      const recentSales = await this.databaseService.getRecentSales(1000); // Get more to increase chance of finding it
      const sale = recentSales.find(s => s.transactionHash === transactionHash);
      
      if (!sale) {
        logger.warn(`Sale not found for hash: ${transactionHash}`);
        return null;
      }

      return await this.convertSaleToImageData(sale);
      
    } catch (error) {
      logger.error(`Error fetching sale by hash ${transactionHash}:`, error);
      return null;
    }
  }

  /**
   * Convert ProcessedSale to RealImageData with ENS lookups
   */
  async convertSaleToImageData(sale: ProcessedSale): Promise<RealImageData> {
    logger.info(`Converting sale to image data: ${sale.transactionHash}`);
    
    // Parse prices
    const priceEth = parseFloat(sale.priceAmount);
    const priceUsd = sale.priceUsd ? parseFloat(sale.priceUsd) : 0;
    
    // Compare Moralis USD and DB USD, use the lower non-zero value for safety
    const moralisUsdValueRaw = sale.currentUsdValue ? parseFloat(sale.currentUsdValue) : 0;
    const dbUsdValueRaw = priceUsd;

    let finalUsdPrice = 0;
    if (moralisUsdValueRaw > 0 && dbUsdValueRaw > 0) {
      finalUsdPrice = Math.min(moralisUsdValueRaw, dbUsdValueRaw);
    } else {
      finalUsdPrice = moralisUsdValueRaw > 0 ? moralisUsdValueRaw : dbUsdValueRaw;
    }

    logger.info(`Price data - ETH: ${priceEth}, USD: ${finalUsdPrice} (Moralis: ${moralisUsdValueRaw}, DB: ${dbUsdValueRaw})`);

    // Get ENS names and avatars using EthIdentityService
    const [buyerProfile, sellerProfile] = await Promise.all([
      this.getProfileData(sale.buyerAddress, 'buyer'),
      this.getProfileData(sale.sellerAddress, 'seller')
    ]);

    // Determine ENS name for the NFT (use collection name or nft name)
    const ensName = sale.nftName || sale.collectionName || 'Unknown NFT';
    
    const imageData: RealImageData = {
      priceEth,
      priceUsd: finalUsdPrice,
      ensName,
      buyerEns: buyerProfile.displayName,
      sellerEns: sellerProfile.displayName,
      buyerAvatar: buyerProfile.avatar,
      sellerAvatar: sellerProfile.avatar,
      nftImageUrl: sale.nftImage,
      saleId: sale.id,
      transactionHash: sale.transactionHash,
      contractAddress: sale.contractAddress,
      tokenId: sale.tokenId,
      currencySymbol: sale.currencySymbol || 'ETH'
    };

    logger.info('Converted sale to image data:', {
      ensName: imageData.ensName,
      buyerEns: imageData.buyerEns,
      sellerEns: imageData.sellerEns,
      priceEth: imageData.priceEth,
      priceUsd: imageData.priceUsd,
      hasNftImage: !!imageData.nftImageUrl,
      hasBuyerAvatar: !!imageData.buyerAvatar,
      hasSellerAvatar: !!imageData.sellerAvatar
    });

    return imageData;
  }

  /**
   * Get profile data (ENS name and avatar) for an address
   */
  private async getProfileData(address: string, role: 'buyer' | 'seller'): Promise<{displayName: string, avatar?: string}> {
    try {
      logger.info(`Looking up ${role} profile for address: ${address}`);
      
      // Get full profile including avatar from EthIdentityService
      const profile: ResolvedProfile = await this.ethIdentityService.getProfile(address);
      
      if (profile && profile.ensName) {
        logger.info(`Found ENS profile for ${role}: ${profile.ensName} (Avatar: ${profile.avatar ? 'Yes' : 'No'})`);
        return {
          displayName: profile.ensName,
          avatar: profile.avatar
        };
      } else {
        // Fallback to truncated address
        const truncatedAddress = `${address.slice(0, 6)}...${address.slice(-4)}`;
        logger.info(`No ENS name found for ${role}, using address: ${truncatedAddress}`);
        return {
          displayName: truncatedAddress
        };
      }
      
    } catch (error) {
      logger.error(`Error looking up ${role} profile for ${address}:`, error);
      // Fallback to truncated address
      const truncatedAddress = `${address.slice(0, 6)}...${address.slice(-4)}`;
      return {
        displayName: truncatedAddress
      };
    }
  }

  /**
   * Generate image using real data
   */
  async generateImageFromRealData(realData: RealImageData): Promise<Buffer> {
    logger.info('Generating image from real data...');
    
    // Convert RealImageData to ImageData format for the image service
    const mockData: ImageData = {
      priceEth: realData.priceEth,
      priceUsd: realData.priceUsd,
      ensName: realData.ensName,
      nftImageUrl: realData.nftImageUrl,
      buyerAddress: '0x0000000000000000000000000000000000000000',
      buyerEns: realData.buyerEns,
      buyerAvatar: realData.buyerAvatar,
      sellerAddress: '0x0000000000000000000000000000000000000000',
      sellerEns: realData.sellerEns,
      sellerAvatar: realData.sellerAvatar,
      transactionHash: realData.transactionHash || '0x0000000000000000000000000000000000000000000000000000000000000000',
      timestamp: new Date(),
      currencySymbol: realData.currencySymbol
    };

    return await PuppeteerImageService.generateSaleImage(mockData, this.databaseService, this.openSeaService);
  }

  /**
   * Generate test image using real data (random or by token prefix)
   */
  async generateTestImageFromDatabase(tokenPrefix?: string): Promise<{imageBuffer: Buffer, imageData: RealImageData} | null> {
    try {
      if (tokenPrefix) {
        logger.info(`Generating test image from database with token prefix: ${tokenPrefix}`);
      } else {
        logger.info('Generating test image from database with random sale');
      }
      
      const realData = tokenPrefix 
        ? await this.getSaleByTokenPrefix(tokenPrefix)
        : await this.getRandomRecentSale();
      
      if (!realData) {
        const message = tokenPrefix 
          ? `No sale found with token prefix: ${tokenPrefix}`
          : 'No real data available for test image generation';
        logger.warn(message);
        return null;
      }

      const imageBuffer = await this.generateImageFromRealData(realData);
      
      logger.info('Successfully generated test image from real data');
      return { imageBuffer, imageData: realData };
      
    } catch (error) {
      logger.error('Error generating test image from database:', error);
      return null;
    }
  }
}
