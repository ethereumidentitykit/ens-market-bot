import * as path from 'path';
import * as fs from 'fs';
import { logger } from '../utils/logger';

// Load the emoji mapping
const emojiMapPath = path.join(process.cwd(), 'assets', 'emoji-map.json');
let emojiMap: Record<string, string> = {};

try {
  const emojiMapData = fs.readFileSync(emojiMapPath, 'utf-8');
  emojiMap = JSON.parse(emojiMapData);
  logger.info(`Loaded emoji mapping with ${Object.keys(emojiMap).length} emojis`);
} catch (error) {
  logger.error('Failed to load emoji mapping:', error);
}

export interface EmojiInfo {
  emoji: string;
  position: number;
  svgPath: string;
}

export class EmojiService {
  /**
   * Detects emojis in text and returns their information
   */
  static detectEmojis(text: string): EmojiInfo[] {
    const emojis: EmojiInfo[] = [];
    
    // Use regex to find emojis (including complex ones like 👨‍⚖️)
    const emojiRegex = /(\p{Emoji_Presentation}|\p{Emoji}\uFE0F|\p{Emoji_Modifier_Base}\p{Emoji_Modifier}?|[\u200D\uFE0F])/gu;
    
    let match;
    while ((match = emojiRegex.exec(text)) !== null) {
      const emoji = match[0];
      const position = match.index;
      
      // Check if we have an SVG for this emoji
      if (emojiMap[emoji]) {
        const svgPath = path.join(process.cwd(), 'assets', 'emojis', 'all', emojiMap[emoji]);
        emojis.push({
          emoji,
          position,
          svgPath
        });
      }
    }
    
    return emojis;
  }

  /**
   * Simple emoji detection using our mapping keys
   */
  static detectKnownEmojis(text: string): EmojiInfo[] {
    const emojis: EmojiInfo[] = [];
    
    // Check each emoji in our mapping
    for (const [emoji, fileName] of Object.entries(emojiMap)) {
      let position = 0;
      while ((position = text.indexOf(emoji, position)) !== -1) {
        const svgPath = path.join(process.cwd(), 'assets', 'emojis', 'all', fileName);
        emojis.push({
          emoji,
          position,
          svgPath
        });
        position += emoji.length; // Move past this emoji
      }
    }
    
    // Sort by position
    return emojis.sort((a, b) => a.position - b.position);
  }

  /**
   * Check if a string contains any emojis we can render
   */
  static hasRenderableEmojis(text: string): boolean {
    return this.detectKnownEmojis(text).length > 0;
  }

  /**
   * Get SVG path for a specific emoji
   */
  static getEmojiSvgPath(emoji: string): string | null {
    const fileName = emojiMap[emoji];
    if (!fileName) {
      return null;
    }
    
    const svgPath = path.join(process.cwd(), 'assets', 'emojis', 'all', fileName);
    
    // Check if file exists
    if (fs.existsSync(svgPath)) {
      return svgPath;
    }
    
    return null;
  }

  /**
   * Get list of all supported emojis
   */
  static getSupportedEmojis(): string[] {
    return Object.keys(emojiMap);
  }

  /**
   * Remove emojis from text for fallback text rendering
   */
  static removeEmojis(text: string): string {
    let cleanText = text;
    
    // Remove all known emojis
    for (const emoji of Object.keys(emojiMap)) {
      cleanText = cleanText.replace(new RegExp(emoji, 'g'), '');
    }
    
    return cleanText.trim();
  }
}
