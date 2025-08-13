const { DatabaseService } = require('./dist/services/databaseService');
const { RealDataImageService } = require('./dist/services/realDataImageService');
const { EthIdentityService } = require('./dist/services/ethIdentityService');
const { emojiMappingService } = require('./dist/services/emojiMappingService');
const fs = require('fs');

async function testRealEmojiSales() {
    console.log('Testing Real ENS Sales with Emojis...\n');

    try {
        // Initialize services
        const databaseService = new DatabaseService();
        await databaseService.initialize(); // Initialize database first
        const ethIdentityService = new EthIdentityService();
        const realDataImageService = new RealDataImageService(databaseService, ethIdentityService);
        await emojiMappingService.initialize();

        console.log('✅ Services initialized\n');

        // Get recent sales from database
        console.log('Fetching recent sales from database...');
        const recentSales = await databaseService.getRecentSales(50); // Get 50 recent sales
        console.log(`Found ${recentSales.length} recent sales\n`);

        // Function to check if text contains emojis
        function containsEmojis(text) {
            if (!text) return false;
            // Check for common emoji Unicode ranges
            const emojiRegex = /[\u{1F300}-\u{1F9FF}]|[\u{2600}-\u{26FF}]|[\u{2700}-\u{27BF}]/u;
            return emojiRegex.test(text);
        }

        // Find sales with emojis
        console.log('Searching for sales with emojis...');
        const salesWithEmojis = [];

        for (const sale of recentSales) {
            const hasEmojiInName = containsEmojis(sale.tokenName);
            
            if (hasEmojiInName) {
                console.log(`Found emoji in sale: ${sale.tokenName} (ID: ${sale.id})`);
                salesWithEmojis.push(sale);
            }
        }

        if (salesWithEmojis.length === 0) {
            console.log('❌ No sales with emojis found in recent data');
            console.log('\nCreating a test sale with emojis instead...');
            
            // Create a test sale with emojis based on a real sale structure
            const testSale = {
                ...recentSales[0], // Use structure from first real sale
                id: 9999,
                tokenName: 'test🎉emoji🚀.eth', // Add emojis
                transactionHash: '0x' + 'test'.repeat(16),
                timestamp: new Date()
            };
            
            console.log(`\nTesting with: "${testSale.tokenName}"`);
            
            // Test emoji detection
            const hasEmojis = containsEmojis(testSale.tokenName);
            console.log(`Contains emojis: ${hasEmojis ? '✅ Yes' : '❌ No'}`);
            
            // Test emoji replacement
            const replacedName = await emojiMappingService.replaceEmojisWithSvg(testSale.tokenName);
            const hasReplacements = replacedName.includes('<svg');
            console.log(`Emoji replacement: ${hasReplacements ? '✅ Contains SVG' : '❌ No SVG'}`);
            
            if (hasReplacements) {
                console.log(`Original length: ${testSale.tokenName.length}, Replaced length: ${replacedName.length}`);
            }
            
            // Generate image with the test sale
            console.log('\nGenerating image with emoji ENS name...');
            const imageResult = await realDataImageService.generateTestImageFromDatabase();
            
            if (imageResult) {
                // Override the ENS name with our emoji test
                const testImageData = {
                    ...imageResult.imageData,
                    ensName: testSale.tokenName
                };
                
                // Generate new image with emoji name
                const emojiImageBuffer = await realDataImageService.generateImageFromRealData(testImageData);
                
                const filename = `real-emoji-test-${Date.now()}.png`;
                fs.writeFileSync(filename, emojiImageBuffer);
                console.log(`✅ Generated emoji test image: ${filename}`);
            }
            
        } else {
            console.log(`\n✅ Found ${salesWithEmojis.length} sales with emojis!`);
            
            // Test the first one
            const testSale = salesWithEmojis[0];
            console.log(`\nTesting with real sale: "${testSale.tokenName}" (ID: ${testSale.id})`);
            
            // Generate image for this sale
            console.log('Generating image with real emoji ENS name...');
            const saleImageData = await realDataImageService.convertSaleToImageData(testSale);
            const imageBuffer = await realDataImageService.generateImageFromRealData(saleImageData);
            
            const filename = `real-emoji-sale-${testSale.id}-${Date.now()}.png`;
            fs.writeFileSync(filename, imageBuffer);
            console.log(`✅ Generated real emoji sale image: ${filename}`);
        }

        console.log('\n✅ Real emoji sales test completed successfully!');

    } catch (error) {
        console.error('❌ Test failed:', error);
        console.error('Stack trace:', error.stack);
    }
}

testRealEmojiSales();
