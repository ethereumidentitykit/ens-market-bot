import { Request, Response } from 'express';
import { ImageGenerationService } from '../services/imageGenerationService';
import { logger } from '../utils/logger';
import * as path from 'path';

export class ImageController {
  /**
   * Generate a test image with mock data
   */
  public static async generateTestImage(req: Request, res: Response): Promise<void> {
    try {
      logger.info('Generating test image with mock data');
      
      // Get mock data
      const mockData = ImageGenerationService.getMockData();
      
      // Generate image
      const startTime = Date.now();
      const imageBuffer = await ImageGenerationService.generateSaleImage(mockData);
      const endTime = Date.now();
      
      // Save image with timestamp
      const filename = `test-image-${Date.now()}.png`;
      const imagePath = await ImageGenerationService.saveImageToFile(imageBuffer, filename);
      
      // Create URL for the generated image
      const imageUrl = `/generated-images/${filename}`;
      
      logger.info(`Test image generated successfully: ${filename} (${endTime - startTime}ms)`);
      
      res.json({
        success: true,
        imageUrl,
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
        dimensions: '1000x666px',
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
      
      logger.info('Generating custom image with provided data');
      
      const startTime = Date.now();
      const imageBuffer = await ImageGenerationService.generateSaleImage(mockData);
      const endTime = Date.now();
      
      // Save image with timestamp
      const filename = `custom-image-${Date.now()}.png`;
      const imagePath = await ImageGenerationService.saveImageToFile(imageBuffer, filename);
      
      // Create URL for the generated image
      const imageUrl = `/generated-images/${filename}`;
      
      logger.info(`Custom image generated successfully: ${filename} (${endTime - startTime}ms)`);
      
      res.json({
        success: true,
        imageUrl,
        mockData,
        generationTime: endTime - startTime,
        dimensions: '1000x666px',
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
