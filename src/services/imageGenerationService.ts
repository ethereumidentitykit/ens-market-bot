import { createCanvas, Canvas, CanvasRenderingContext2D, loadImage } from 'canvas';
import * as fs from 'fs';
import * as path from 'path';
import axios from 'axios';

export interface MockImageData {
  // Price information (from sales pipeline)
  priceEth: number;        // e.g., 5.51
  priceUsd: number;        // e.g., 22560.01
  
  // ENS name (from Moralis API)
  ensName: string;         // e.g., "name.eth"
  
  // Buyer information (from EthIdentityKit)
  buyerAddress: string;    // e.g., "0x1234..."
  buyerEns?: string;       // e.g., "james.eth"
  buyerAvatar?: string;    // Avatar URL from EthIdentityKit
  
  // Seller information (from EthIdentityKit)
  sellerAddress: string;   // e.g., "0x5678..."
  sellerEns?: string;      // e.g., "maxi.eth"
  sellerAvatar?: string;   // Avatar URL from EthIdentityKit
  
  // Metadata
  transactionHash: string;
  timestamp: Date;
}

export class ImageGenerationService {
  private static readonly CANVAS_WIDTH = 1000;
  private static readonly CANVAS_HEIGHT = 666;
  
  // Design colors
  private static readonly COLORS = {
    background: '#2D2D2D',
    primaryText: '#FFFFFF',
    ensPillBackground: '#4A90E2',
    buyerSellerPill: '#1A1A1A',
    arrow: '#FFFFFF'
  };

  /**
   * Generate a simple test image to verify canvas functionality
   */
  public static async generateTestImage(): Promise<Buffer> {
    const canvas = createCanvas(this.CANVAS_WIDTH, this.CANVAS_HEIGHT);
    const ctx = canvas.getContext('2d');

    // Fill background
    ctx.fillStyle = this.COLORS.background;
    ctx.fillRect(0, 0, this.CANVAS_WIDTH, this.CANVAS_HEIGHT);

    // Add test text
    ctx.fillStyle = this.COLORS.primaryText;
    ctx.font = 'bold 48px Arial';
    ctx.textAlign = 'center';
    ctx.fillText('Canvas Test', this.CANVAS_WIDTH / 2, this.CANVAS_HEIGHT / 2);

    // Add smaller test text
    ctx.font = '24px Arial';
    ctx.fillText(`${this.CANVAS_WIDTH}x${this.CANVAS_HEIGHT} - Image Generation Working!`, 
                 this.CANVAS_WIDTH / 2, this.CANVAS_HEIGHT / 2 + 50);

    return canvas.toBuffer('image/png');
  }

  /**
   * Generate ENS sale image with mock data
   */
  public static async generateSaleImage(data: MockImageData): Promise<Buffer> {
    const canvas = createCanvas(this.CANVAS_WIDTH, this.CANVAS_HEIGHT);
    const ctx = canvas.getContext('2d');

    // Fill background
    ctx.fillStyle = this.COLORS.background;
    ctx.fillRect(0, 0, this.CANVAS_WIDTH, this.CANVAS_HEIGHT);

    // Draw main card container
    this.drawMainCard(ctx);

    // Draw the main template layout
    this.drawPriceSection(ctx, data.priceEth, data.priceUsd);
    await this.drawENSImage(ctx, data.ensName);
    await this.drawBuyerSellerSection(ctx, data.sellerEns || 'seller', data.buyerEns || 'buyer', data.sellerAvatar, data.buyerAvatar);

    return canvas.toBuffer('image/png');
  }

  /**
   * Draw main card container
   */
  private static drawMainCard(ctx: CanvasRenderingContext2D): void {
    // No card background - just use the main dark background
    // Twitter will handle the rounded corners automatically
  }

  /**
   * Draw the ETH price and USD conversion on the left side
   */
  private static drawPriceSection(ctx: CanvasRenderingContext2D, priceEth: number, priceUsd: number): void {
    // Based on SVG analysis: position in left area (before x=552)
    const leftAreaCenter = 270; // Center of left area (roughly x=270)
    const priceY = 173; // Based on SVG text positioning

    ctx.fillStyle = this.COLORS.primaryText;
    ctx.textAlign = 'center';

    // Large ETH price - matching SVG font sizes
    ctx.font = 'bold 120px Arial'; // Larger to match SVG proportions
    ctx.fillText(priceEth.toFixed(2), leftAreaCenter, priceY);

    // ETH label
    ctx.font = '40px Arial';
    ctx.fillText('ETH', leftAreaCenter, priceY + 60);

    // USD price
    ctx.font = 'bold 80px Arial'; // Larger to match proportions
    ctx.fillText(`$${priceUsd.toLocaleString('en-US', { minimumFractionDigits: 2 })}`, leftAreaCenter, priceY + 170);

    // USD label
    ctx.font = '40px Arial';
    ctx.fillText('USD', leftAreaCenter, priceY + 230);
  }

  /**
   * Draw ENS image with rounded corners on the right side
   */
  private static async drawENSImage(ctx: CanvasRenderingContext2D, ensName: string): Promise<void> {
    // SVG coordinates: x="552" y="48" width="400" height="400" rx="30"
    const imageX = 552;
    const imageY = 48;
    const imageSize = 400;
    const borderRadius = 30;

    try {
      // Try to load the placeholder image you provided
      const placeholderImagePath = path.join(process.cwd(), 'data', 'nameplaceholder.png');
      
      if (fs.existsSync(placeholderImagePath)) {
        // Load the placeholder image
        const placeholderImage = await loadImage(placeholderImagePath);
        
        // Draw rounded image
        ctx.save();
        ctx.beginPath();
        this.createRoundedRectPath(ctx, imageX, imageY, imageSize, imageSize, borderRadius);
        ctx.clip();
        ctx.drawImage(placeholderImage, imageX, imageY, imageSize, imageSize);
        ctx.restore();
      } else {
        // Fallback to blue pill if placeholder not found
        ctx.fillStyle = this.COLORS.ensPillBackground;
        this.drawRoundedRect(ctx, imageX, imageY, imageSize, imageSize, borderRadius);
        
        // Don't draw text since the image should include the name already
        ctx.fillStyle = this.COLORS.primaryText;
        ctx.font = 'bold 48px Arial';
        ctx.textAlign = 'center';
        ctx.fillText(ensName, imageX + imageSize / 2, imageY + imageSize / 2 + 16);
      }
    } catch (error) {
      console.warn('Failed to load ENS placeholder image:', error);
      // Fallback to blue pill
      ctx.fillStyle = this.COLORS.ensPillBackground;
      this.drawRoundedRect(ctx, imageX, imageY, imageSize, imageSize, borderRadius);
      
      ctx.fillStyle = this.COLORS.primaryText;
      ctx.font = 'bold 48px Arial';
      ctx.textAlign = 'center';
      ctx.fillText(ensName, imageX + imageSize / 2, imageY + imageSize / 2 + 16);
    }
  }

  /**
   * Draw buyer and seller pills with arrow at the bottom
   */
    private static async drawBuyerSellerSection(
    ctx: CanvasRenderingContext2D,
    sellerEns: string,
    buyerEns: string,
    sellerAvatarUrl?: string,
    buyerAvatarUrl?: string
  ): Promise<void> {
    // SVG coordinates for pills:
    // Left pill: x="26" y="506" width="433" height="132" rx="66"
    // Right pill: x="535" y="506" width="433" height="132" rx="66"
    const leftPillX = 26;
    const rightPillX = 535;
    const pillY = 506;
    const pillWidth = 433;
    const pillHeight = 132;
    const borderRadius = 66;

    // Avatar dimensions from SVG: width="100" height="100" rx="50"
    const avatarSize = 100;
    const avatarPadding = 21; // (132 - 100) / 2 to center vertically
    
    // Text positioning
    const textPadding = 30;

        // Draw seller pill (left)
    ctx.fillStyle = this.COLORS.buyerSellerPill;
    this.drawRoundedRect(ctx, leftPillX, pillY, pillWidth, pillHeight, borderRadius);

    // Draw buyer pill (right)
    this.drawRoundedRect(ctx, rightPillX, pillY, pillWidth, pillHeight, borderRadius);

    // Draw seller avatar and text
    // Avatar position from SVG: x="47" y="522" (47 = 26 + 21, 522 = 506 + 16)
    const sellerAvatarX = leftPillX + avatarPadding;
    const sellerAvatarY = pillY + (pillHeight - avatarSize) / 2;
    await this.drawAvatar(ctx, sellerAvatarUrl, sellerAvatarX, sellerAvatarY, avatarSize);

    // Seller text positioning
    ctx.fillStyle = this.COLORS.primaryText;
    ctx.font = 'bold 42px Arial'; // Larger font to match SVG proportions
    ctx.textAlign = 'left';

    const sellerTextX = sellerAvatarX + avatarSize + textPadding;
    const sellerTextY = pillY + pillHeight / 2 + 14; // Centered vertically
    const sellerMaxTextWidth = pillWidth - avatarSize - avatarPadding - textPadding - 40;
    const truncatedSellerName = this.truncateText(ctx, sellerEns, sellerMaxTextWidth);
    ctx.fillText(truncatedSellerName, sellerTextX, sellerTextY);

    // Draw buyer avatar and text
    // Avatar position from SVG: x="555" y="522" 
    const buyerAvatarX = rightPillX + avatarPadding;
    const buyerAvatarY = pillY + (pillHeight - avatarSize) / 2;
    await this.drawAvatar(ctx, buyerAvatarUrl, buyerAvatarX, buyerAvatarY, avatarSize);

    // Buyer text positioning
    const buyerTextX = buyerAvatarX + avatarSize + textPadding;
    const buyerTextY = pillY + pillHeight / 2 + 14; // Centered vertically
    const buyerMaxTextWidth = pillWidth - avatarSize - avatarPadding - textPadding - 40;
    const truncatedBuyerName = this.truncateText(ctx, buyerEns, buyerMaxTextWidth);
    ctx.fillText(truncatedBuyerName, buyerTextX, buyerTextY);

    // Draw arrow between pills
    // From SVG path: arrow positioned around x=500-530, y=572
    const arrowStartX = leftPillX + pillWidth + 15;
    const arrowEndX = rightPillX - 15;
    const arrowY = pillY + pillHeight / 2;
    this.drawArrow(ctx, arrowStartX, arrowY, arrowEndX, arrowY);
  }

  /**
   * Truncate text to fit within specified width
   */
  private static truncateText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string {
    // Check if text fits without truncation
    if (ctx.measureText(text).width <= maxWidth) {
      return text;
    }

    // Handle ENS names specially
    if (text.endsWith('.eth')) {
      const baseName = text.slice(0, -4); // Remove .eth
      
      // Try progressively shorter versions
      for (let i = Math.floor(baseName.length / 2); i >= 4; i--) {
        const truncated = baseName.slice(0, i) + '...' + baseName.slice(-3) + '.eth';
        if (ctx.measureText(truncated).width <= maxWidth) {
          return truncated;
        }
      }
      
      // If still too long, use very short version
      return baseName.slice(0, 4) + '...eth';
    }

    // Handle addresses (0x...)
    if (text.startsWith('0x') && text.length > 10) {
      const truncated = text.slice(0, 6) + '...' + text.slice(-4);
      return truncated;
    }

    // Generic truncation for other cases
    let truncated = text;
    while (ctx.measureText(truncated + '...').width > maxWidth && truncated.length > 3) {
      truncated = truncated.slice(0, -1);
    }
    
    return truncated.length < text.length ? truncated + '...' : text;
  }

  /**
   * Draw avatar image in a circular clip
   */
  private static async drawAvatar(
    ctx: CanvasRenderingContext2D,
    avatarUrl: string | undefined,
    x: number,
    y: number,
    size: number
  ): Promise<void> {
    const radius = size / 2;
    const centerX = x + radius;
    const centerY = y + radius;

    // Create circular clipping path
    ctx.save();
    ctx.beginPath();
    ctx.arc(centerX, centerY, radius, 0, 2 * Math.PI);
    ctx.clip();

    try {
      if (avatarUrl) {
        // Load and draw avatar image
        const avatarImage = await this.loadImageFromUrl(avatarUrl);
        ctx.drawImage(avatarImage, x, y, size, size);
      } else {
        // Draw default avatar (gray circle with initials)
        ctx.fillStyle = '#666666';
        ctx.fillRect(x, y, size, size);
        
        // Add default avatar icon (simple circle)
        ctx.fillStyle = '#999999';
        ctx.beginPath();
        ctx.arc(centerX, centerY, radius * 0.6, 0, 2 * Math.PI);
        ctx.fill();
      }
    } catch (error) {
      console.warn('Failed to load avatar, using default:', error instanceof Error ? error.message : String(error));
      // Draw default avatar on error
      ctx.fillStyle = '#666666';
      ctx.fillRect(x, y, size, size);
      
      ctx.fillStyle = '#999999';
      ctx.beginPath();
      ctx.arc(centerX, centerY, radius * 0.6, 0, 2 * Math.PI);
      ctx.fill();
    }

    ctx.restore();
  }

  /**
   * Load image from URL with timeout and error handling
   */
  private static async loadImageFromUrl(url: string): Promise<any> {
    try {
      const response = await axios.get(url, {
        responseType: 'arraybuffer',
        timeout: 5000, // 5 second timeout
        headers: {
          'User-Agent': 'ENS-Sales-Bot/1.0'
        }
      });
      
      const buffer = Buffer.from(response.data);
      return await loadImage(buffer);
    } catch (error) {
      throw new Error(`Failed to load image from ${url}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Draw a rounded rectangle
   */
  private static drawRoundedRect(ctx: CanvasRenderingContext2D, x: number, y: number, width: number, height: number, radius: number): void {
    ctx.beginPath();
    this.createRoundedRectPath(ctx, x, y, width, height, radius);
    ctx.fill();
  }

  /**
   * Create a rounded rectangle path (for clipping)
   */
  private static createRoundedRectPath(ctx: CanvasRenderingContext2D, x: number, y: number, width: number, height: number, radius: number): void {
    ctx.moveTo(x + radius, y);
    ctx.lineTo(x + width - radius, y);
    ctx.quadraticCurveTo(x + width, y, x + width, y + radius);
    ctx.lineTo(x + width, y + height - radius);
    ctx.quadraticCurveTo(x + width, y + height, x + width - radius, y + height);
    ctx.lineTo(x + radius, y + height);
    ctx.quadraticCurveTo(x, y + height, x, y + height - radius);
    ctx.lineTo(x, y + radius);
    ctx.quadraticCurveTo(x, y, x + radius, y);
    ctx.closePath();
  }

  /**
   * Draw arrow between buyer and seller
   */
  private static drawArrow(ctx: CanvasRenderingContext2D, fromX: number, fromY: number, toX: number, toY: number): void {
    const arrowHeadSize = 24; // Much bigger arrow head
    const arrowLineWidth = 4; // Thicker line

    ctx.strokeStyle = this.COLORS.arrow;
    ctx.fillStyle = this.COLORS.arrow;
    ctx.lineWidth = arrowLineWidth;

    // Draw arrow line
    ctx.beginPath();
    ctx.moveTo(fromX, fromY);
    ctx.lineTo(toX - arrowHeadSize, toY);
    ctx.stroke();

    // Draw bigger arrow head
    ctx.beginPath();
    ctx.moveTo(toX, toY);
    ctx.lineTo(toX - arrowHeadSize, toY - arrowHeadSize / 2);
    ctx.lineTo(toX - arrowHeadSize, toY + arrowHeadSize / 2);
    ctx.closePath();
    ctx.fill();
  }

  /**
   * Save image buffer to file system (for testing)
   */
  public static async saveImageToFile(imageBuffer: Buffer, filename: string): Promise<string> {
    const outputDir = path.join(process.cwd(), 'data');
    
    // Ensure data directory exists
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    const filePath = path.join(outputDir, filename);
    fs.writeFileSync(filePath, imageBuffer);
    
    return filePath;
  }

  /**
   * Get mock data for testing
   */
  public static getMockData(): MockImageData {
    return {
      priceEth: 5.51,
      priceUsd: 22560.01,
      ensName: 'name.eth', // Back to simple name for blue pill display
      buyerAddress: '0x1234567890abcdef1234567890abcdef12345678',
      buyerEns: 'james.eth',
      buyerAvatar: 'https://metadata.ens.domains/mainnet/avatar/vitalik.eth',
      sellerAddress: '0xabcdef1234567890abcdef1234567890abcdef12',
      sellerEns: 'maxi.eth', 
      sellerAvatar: 'https://metadata.ens.domains/mainnet/avatar/brantly.eth',
      transactionHash: '0xtest123456789abcdef',
      timestamp: new Date()
    };
  }

  /**
   * Get mock data with various avatar scenarios for testing
   */
  public static getMockDataWithAvatars(): MockImageData[] {
    return [
      {
        priceEth: 5.51,
        priceUsd: 22560.01,
        ensName: 'name.eth',
        buyerAddress: '0x1234567890abcdef1234567890abcdef12345678',
        buyerEns: 'james.eth',
        buyerAvatar: 'https://metadata.ens.domains/mainnet/avatar/vitalik.eth',
        sellerAddress: '0xabcdef1234567890abcdef1234567890abcdef12',
        sellerEns: 'maxi.eth',
        sellerAvatar: 'https://metadata.ens.domains/mainnet/avatar/brantly.eth',
        transactionHash: '0xtest123456789abcdef',
        timestamp: new Date()
      },
      {
        priceEth: 12.25,
        priceUsd: 50120.75,
        ensName: 'premium.eth',
        buyerAddress: '0x1234567890abcdef1234567890abcdef12345678',
        buyerEns: 'collector.eth',
        buyerAvatar: undefined, // No avatar - should show default
        sellerAddress: '0xabcdef1234567890abcdef1234567890abcdef12',
        sellerEns: 'founder.eth',
        sellerAvatar: 'https://metadata.ens.domains/mainnet/avatar/nick.eth',
        transactionHash: '0xtest123456789abcdef',
        timestamp: new Date()
      },
      {
        priceEth: 0.75,
        priceUsd: 3067.50,
        ensName: 'test.eth',
        buyerAddress: '0x1234567890abcdef1234567890abcdef12345678',
        buyerEns: 'buyer.eth',
        buyerAvatar: 'https://invalid-url-should-fallback.com/avatar.png', // Invalid URL - should fallback
        sellerAddress: '0xabcdef1234567890abcdef1234567890abcdef12',
        sellerEns: 'seller.eth',
        sellerAvatar: undefined, // No avatar - should show default
        transactionHash: '0xtest123456789abcdef',
        timestamp: new Date()
      }
    ];
  }
}
