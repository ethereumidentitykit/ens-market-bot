import axios from 'axios';
import { logger } from './logger';
import { SvgConverter } from './svgConverter';

/**
 * Simple image loader utility to replace skia-canvas loadImage functionality
 */
export class ImageLoader {
  /**
   * Load image from URL and return as Buffer
   */
  public static async loadImageFromUrl(url: string): Promise<Buffer> {
    try {
      logger.info(`Loading image from URL: ${url}`);
      
      const response = await axios.get(url, {
        responseType: 'arraybuffer',
        timeout: 10000,
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; ENS-Bot/1.0)'
        }
      });
      
      const contentType = response.headers['content-type'];
      const buffer = Buffer.from(response.data);
      
      // Check if it's an SVG image
      if (contentType && contentType.includes('image/svg+xml')) {
        logger.info('Converting SVG to PNG using Puppeteer for proper font/emoji rendering...');
        
        const svgContent = buffer.toString();
        const pngBuffer = await SvgConverter.convertSvgToPng(svgContent);
        return pngBuffer;
      } else {
        // For regular images, return buffer directly
        return buffer;
      }
    } catch (error) {
      throw new Error(`Failed to load image from ${url}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
