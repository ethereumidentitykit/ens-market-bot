import { Request, Response } from 'express';
import { PuppeteerImageService } from '../services/puppeteerImageService';
import { RealDataImageService } from '../services/realDataImageService';
import { ENSWorkerService } from '../services/ensWorkerService';
import { logger } from '../utils/logger';
import * as path from 'path';

export class ImageController {
  /**
   * Generate a test image using real data from database
   */
  public static async generateTestImage(req: Request, res: Response): Promise<void> {
    try {
      const { tokenPrefix } = req.body;
      logger.info('Generating test image with real database data', { tokenPrefix });
      
      // Get database service and EthIdentityService from req.app.locals (set up in main app)
      const { databaseService, ethIdentityService } = req.app.locals;
      
      if (!databaseService || !ethIdentityService) {
        throw new Error('Required services not available');
      }
      
      // Create RealDataImageService instance
      const realDataService = new RealDataImageService(databaseService, ethIdentityService);
      
      // Generate image using real data
      const startTime = Date.now();
      const result = await realDataService.generateTestImageFromDatabase(tokenPrefix);
      
      if (!result) {
        // Fallback to mock data if no real data available
        const message = tokenPrefix 
          ? `No sale found with token prefix '${tokenPrefix}', falling back to mock data`
          : 'No real data available, falling back to mock data';
        logger.warn(message);
        const mockData = PuppeteerImageService.getMockData();
        const imageBuffer = await PuppeteerImageService.generateSaleImage(mockData, databaseService);
        const endTime = Date.now();
        
        const filename = `test-image-mock-${Date.now()}.png`;
        const savedPath = await PuppeteerImageService.saveImageToFile(imageBuffer, filename, databaseService);
        const imageUrl = savedPath.startsWith('/api/images/') ? savedPath : `/generated-images/${filename}`;
        
        res.json({
          success: true,
          imageUrl,
          dataSource: 'mock',
          tokenPrefix: tokenPrefix || null,
          fallbackReason: tokenPrefix ? `Token prefix '${tokenPrefix}' not found` : 'No database data available',
          mockData: {
            priceEth: mockData.priceEth,
            priceUsd: mockData.priceUsd,
            ensName: mockData.ensName,
            buyerEns: mockData.buyerEns,
            sellerEns: mockData.sellerEns,
            buyerAvatar: mockData.buyerAvatar ? 'Loaded' : 'Default',
            sellerAvatar: mockData.sellerAvatar ? 'Loaded' : 'Default'
          },
          generationTime: endTime - startTime,
          dimensions: '1000x545px',
          filename
        });
        return;
      }
      
      const { imageBuffer, imageData } = result;
      const endTime = Date.now();
      
      // Save image with timestamp
      const filename = `test-image-real-${Date.now()}.png`;
      const savedPath = await PuppeteerImageService.saveImageToFile(imageBuffer, filename, databaseService);
      
      // Create URL for the generated image
      const imageUrl = savedPath.startsWith('/api/images/') ? savedPath : `/generated-images/${filename}`;
      
      logger.info(`Test image generated successfully from real data: ${filename} (${endTime - startTime}ms)`);
      
      res.json({
        success: true,
        imageUrl,
        dataSource: 'database',
        tokenPrefix: tokenPrefix || null,
        selectionMethod: tokenPrefix ? 'token-prefix' : 'random',
        realData: {
          priceEth: imageData.priceEth,
          priceUsd: imageData.priceUsd,
          ensName: imageData.ensName,
          buyerEns: imageData.buyerEns,
          sellerEns: imageData.sellerEns,
          buyerAvatar: imageData.buyerAvatar ? 'Loaded' : 'Default',
          sellerAvatar: imageData.sellerAvatar ? 'Loaded' : 'Default',
          nftImageUrl: imageData.nftImageUrl ? 'Available' : 'Not available',
          transactionHash: imageData.transactionHash,
          saleId: imageData.saleId
        },
        generationTime: endTime - startTime,
        dimensions: '1000x545px',
        filename
      });
      
    } catch (error) {
      logger.error('Failed to generate test image:', error);
      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error occurred'
      });
    }
  }

  /**
   * Generate image with custom data (for future use)
   */
  public static async generateCustomImage(req: Request, res: Response): Promise<void> {
    try {
      const { mockData } = req.body;
      
      if (!mockData) {
        res.status(400).json({
          success: false,
          error: 'Mock data is required'
        });
        return;
      }
      
      // Get database service from req.app.locals
      const { databaseService } = req.app.locals;
      
      logger.info('Generating custom image with provided data');
      
      const startTime = Date.now();
      const imageBuffer = await PuppeteerImageService.generateSaleImage(mockData, databaseService);
      const endTime = Date.now();
      
      // Save image with timestamp
      const filename = `custom-image-${Date.now()}.png`;
      const savedPath = await PuppeteerImageService.saveImageToFile(imageBuffer, filename, databaseService);
      
      // Create URL for the generated image
      const imageUrl = savedPath.startsWith('/api/images/') ? savedPath : `/generated-images/${filename}`;
      
      logger.info(`Custom image generated successfully: ${filename} (${endTime - startTime}ms)`);
      
      res.json({
        success: true,
        imageUrl,
        mockData,
        generationTime: endTime - startTime,
        dimensions: '1000x545px',
        filename
      });
      
    } catch (error) {
      logger.error('Failed to generate custom image:', error);
      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error occurred'
      });
    }
  }
}
