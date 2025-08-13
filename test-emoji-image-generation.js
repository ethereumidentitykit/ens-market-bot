const { PuppeteerImageService } = require('./dist/services/puppeteerImageService');
const { emojiMappingService } = require('./dist/services/emojiMappingService');
const fs = require('fs');

async function testEmojiImageGeneration() {
    console.log('Testing Emoji Image Generation...\n');

    try {
        // Initialize emoji mapping service
        await emojiMappingService.initialize();
        console.log('✅ Emoji mapping service initialized\n');

        // Test data with emojis
        const testData = {
            priceEth: 2.50,
            priceUsd: 8500.00,
            ensName: 'test🧦emoji.eth', // Socks emoji
            nftImageUrl: null, // Use placeholder
            buyerAddress: '0x1234567890123456789012345678901234567890',
            buyerEns: 'buyer🎠.eth', // Carousel horse emoji
            buyerAvatar: null,
            sellerAddress: '0x0987654321098765432109876543210987654321',
            sellerEns: 'seller🧞‍♂️.eth', // Genie emoji
            sellerAvatar: null,
            transactionHash: '0x1234567890123456789012345678901234567890123456789012345678901234',
            timestamp: new Date()
        };

        console.log('Test data:');
        console.log(`- ENS Name: "${testData.ensName}"`);
        console.log(`- Buyer: "${testData.buyerEns}"`);
        console.log(`- Seller: "${testData.sellerEns}"`);
        console.log('');

        // Check emoji support
        console.log('Checking emoji support:');
        const emojisToCheck = ['🧦', '🎠', '🧞'];
        for (const emoji of emojisToCheck) {
            const isSupported = emojiMappingService.isEmojiSupported(emoji);
            console.log(`${emoji}: ${isSupported ? '✅ Supported' : '❌ Not supported'}`);
        }
        console.log('');

        // Generate image
        console.log('Generating image with emojis...');
        const startTime = Date.now();
        
        const imageBuffer = await PuppeteerImageService.generateSaleImage(testData);
        
        const endTime = Date.now();
        console.log(`✅ Image generated successfully in ${endTime - startTime}ms`);
        console.log(`Image size: ${imageBuffer.length} bytes`);

        // Save test image
        const filename = `test-emoji-image-${Date.now()}.png`;
        fs.writeFileSync(filename, imageBuffer);
        console.log(`✅ Image saved as: ${filename}`);

        // Test text replacement to see what was actually replaced
        console.log('\nTesting text replacement:');
        const replacedEns = await emojiMappingService.replaceEmojisWithSvg(testData.ensName);
        const replacedBuyer = await emojiMappingService.replaceEmojisWithSvg(testData.buyerEns);
        const replacedSeller = await emojiMappingService.replaceEmojisWithSvg(testData.sellerEns);
        
        console.log(`ENS replaced: ${replacedEns.includes('<svg') ? '✅ Contains SVG' : '❌ No SVG'}`);
        console.log(`Buyer replaced: ${replacedBuyer.includes('<svg') ? '✅ Contains SVG' : '❌ No SVG'}`);
        console.log(`Seller replaced: ${replacedSeller.includes('<svg') ? '✅ Contains SVG' : '❌ No SVG'}`);

        console.log('\n✅ All emoji image generation tests completed successfully!');
        console.log(`\n📸 Open ${filename} to see the generated image with emojis!`);

    } catch (error) {
        console.error('❌ Test failed:', error);
        console.error('Stack trace:', error.stack);
    }
}

testEmojiImageGeneration();
