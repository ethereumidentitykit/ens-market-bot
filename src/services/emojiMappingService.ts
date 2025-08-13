import * as fs from 'fs';
import * as path from 'path';
import { logger } from '../utils/logger';

interface EmojiMapping {
    filePath: string;
    detectedName: string;
    unicodeSequence: string;
    codepointsHex: string;
    status: 'mapped' | 'unmapped';
    method: string;
}

export class EmojiMappingService {
    private mappings: Map<string, EmojiMapping> = new Map();
    private initialized = false;
    private emojiAssetsPath: string;

    constructor() {
        // Path to emoji assets relative to project root
        this.emojiAssetsPath = path.join(process.cwd(), 'assets', 'emojis', 'all');
    }

    /**
     * Initialize the emoji mapping service by loading the CSV data
     */
    async initialize(): Promise<void> {
        if (this.initialized) return;

        try {
            const csvPath = path.join(process.cwd(), 'assets', 'emoji_mapping.csv');
            const csvContent = fs.readFileSync(csvPath, 'utf-8');
            
            const lines = csvContent.split('\n').slice(1); // Skip header
            let mappedCount = 0;

            for (const line of lines) {
                if (!line.trim()) continue;

                const [filePath, detectedName, unicodeSequence, codepointsHex, status, method] = line.split(',');
                
                if (status === 'mapped' && unicodeSequence) {
                    const mapping: EmojiMapping = {
                        filePath,
                        detectedName,
                        unicodeSequence,
                        codepointsHex,
                        status: status as 'mapped',
                        method
                    };

                    // Use Unicode sequence as the key for lookup
                    this.mappings.set(unicodeSequence, mapping);
                    mappedCount++;
                }
            }

            this.initialized = true;
            logger.info(`EmojiMappingService initialized with ${mappedCount} mapped emojis`);

        } catch (error) {
            logger.error('Failed to initialize EmojiMappingService:', error);
            throw error;
        }
    }

    /**
     * Get the SVG content for a given Unicode emoji sequence
     */
    async getEmojiSvg(unicodeSequence: string): Promise<string | null> {
        if (!this.initialized) {
            await this.initialize();
        }

        const mapping = this.mappings.get(unicodeSequence);
        if (!mapping) {
            return null;
        }

        try {
            // Extract filename from the file path (remove 'all/' prefix)
            const filename = path.basename(mapping.filePath);
            const svgPath = path.join(this.emojiAssetsPath, filename);
            
            if (!fs.existsSync(svgPath)) {
                logger.warn(`Emoji SVG file not found: ${svgPath}`);
                return null;
            }

            return fs.readFileSync(svgPath, 'utf-8');
        } catch (error) {
            logger.error(`Error reading emoji SVG for ${unicodeSequence}:`, error);
            return null;
        }
    }

    /**
     * Replace emoji Unicode characters in text with SVG elements
     * This method finds emojis in text and replaces them with inline SVG
     */
    async replaceEmojisWithSvg(text: string): Promise<string> {
        if (!this.initialized) {
            await this.initialize();
        }

        let result = text;
        const processedPositions = new Set<number>();

        // Sort mappings by Unicode sequence length (longest first) to handle complex sequences
        const sortedMappings = Array.from(this.mappings.entries()).sort((a, b) => b[0].length - a[0].length);

        for (const [unicodeSequence, mapping] of sortedMappings) {
            const regex = new RegExp(this.escapeRegExp(unicodeSequence), 'g');
            let match;

            while ((match = regex.exec(result)) !== null) {
                const matchStart = match.index;
                const matchEnd = match.index + match[0].length;

                // Check if this position has already been processed (avoid double replacement)
                const isOverlapping = Array.from(processedPositions).some(pos => 
                    (pos >= matchStart && pos < matchEnd) || (matchStart >= pos && matchStart < pos + unicodeSequence.length)
                );

                if (!isOverlapping) {
                    const svgContent = await this.getEmojiSvg(unicodeSequence);
                    if (svgContent) {
                        // Create inline SVG with proper styling for text integration
                        const inlineSvg = this.createInlineSvg(svgContent, mapping.detectedName);
                        result = result.substring(0, matchStart) + inlineSvg + result.substring(matchEnd);
                        
                        // Mark positions as processed
                        for (let i = matchStart; i < matchEnd; i++) {
                            processedPositions.add(i);
                        }
                        
                        // Adjust regex lastIndex due to text change
                        regex.lastIndex = matchStart + inlineSvg.length;
                    }
                }
            }
        }

        return result;
    }

    /**
     * Create an inline SVG element suitable for HTML integration
     */
    private createInlineSvg(svgContent: string, altText: string): string {
        // Add CSS classes and styling for proper text integration
        const styledSvg = svgContent
            .replace('<svg', '<svg class="emoji-inline" style="display: inline-block; vertical-align: middle; width: 1.2em; height: 1.2em;"')
            .replace(/xmlns:xlink="[^"]*"/g, '') // Remove xlink namespace if present
            .replace(/\s+/g, ' ') // Normalize whitespace
            .trim();

        return styledSvg;
    }

    /**
     * Escape special regex characters
     */
    private escapeRegExp(string: string): string {
        return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }

    /**
     * Get statistics about the emoji mapping
     */
    getStats(): { totalMapped: number; initialized: boolean } {
        return {
            totalMapped: this.mappings.size,
            initialized: this.initialized
        };
    }

    /**
     * Check if a specific emoji is supported
     */
    isEmojiSupported(unicodeSequence: string): boolean {
        return this.mappings.has(unicodeSequence);
    }
}

// Export singleton instance
export const emojiMappingService = new EmojiMappingService();
