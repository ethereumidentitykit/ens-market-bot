const { NewTweetFormatter } = require('./dist/services/newTweetFormatter');
const { DatabaseService } = require('./dist/services/databaseService');
const { EthIdentityService } = require('./dist/services/ethIdentityService');
const { emojiMappingService } = require('./dist/services/emojiMappingService');
const fs = require('fs');

async function testAdminDashboardEmoji() {
    console.log('Testing Admin Dashboard Emoji Integration...\n');

    try {
        // Initialize services
        const databaseService = new DatabaseService();
        await databaseService.initialize();
        const ethIdentityService = new EthIdentityService();
        await emojiMappingService.initialize();
        
        const tweetFormatter = new NewTweetFormatter(ethIdentityService, databaseService);

        console.log('✅ Services initialized\n');

        // Get recent sales to find ones with emojis
        console.log('Finding sales with emojis...');
        const recentSales = await databaseService.getRecentSales(20);
        
        // Function to check if text contains emojis
        function containsEmojis(text) {
            if (!text) return false;
            const emojiRegex = /[\u{1F300}-\u{1F9FF}]|[\u{2600}-\u{26FF}]|[\u{2700}-\u{27BF}]/u;
            return emojiRegex.test(text);
        }

        const salesWithEmojis = recentSales.filter(sale => 
            containsEmojis(sale.tokenName) || 
            containsEmojis(sale.buyerEns) || 
            containsEmojis(sale.sellerEns)
        );

        if (salesWithEmojis.length === 0) {
            console.log('❌ No emoji sales found, creating test sale...');
            
            // Use a real sale structure but with emoji names
            const testSale = {
                ...recentSales[0],
                id: 9999,
                tokenName: '🎯test🚀.eth',
                buyerEns: 'buyer🎨.eth',
                sellerEns: 'seller🌟.eth'
            };
            
            salesWithEmojis.push(testSale);
        }

        const testSale = salesWithEmojis[0];
        console.log(`Found emoji sale: "${testSale.tokenName}"`);
        console.log(`Buyer: "${testSale.buyerEns || 'N/A'}"`);
        console.log(`Seller: "${testSale.sellerEns || 'N/A'}"`);
        console.log('');

        // Test tweet generation (this is what the admin dashboard does)
        console.log('Generating tweet with emoji integration...');
        const generatedTweet = await tweetFormatter.generateTweet(testSale);

        console.log('\n--- Generated Tweet ---');
        console.log(`Text: "${generatedTweet.text}"`);
        console.log(`Character count: ${generatedTweet.characterCount}`);
        console.log(`Valid: ${generatedTweet.isValid ? '✅ Yes' : '❌ No'}`);
        console.log(`Has image: ${generatedTweet.imageBuffer ? '✅ Yes' : '❌ No'}`);
        
        if (generatedTweet.imageBuffer) {
            const filename = `admin-dashboard-emoji-${Date.now()}.png`;
            fs.writeFileSync(filename, generatedTweet.imageBuffer);
            console.log(`Image saved: ${filename}`);
            console.log(`Image size: ${generatedTweet.imageBuffer.length} bytes`);
        }

        // Test emoji detection in the tweet text itself
        const tweetHasEmojis = containsEmojis(generatedTweet.text);
        console.log(`Tweet text contains emojis: ${tweetHasEmojis ? '✅ Yes' : '❌ No'}`);

        console.log('\n✅ Admin dashboard emoji integration test completed successfully!');
        console.log('\nThis simulates exactly what happens when:');
        console.log('1. User selects a sale in the admin dashboard');
        console.log('2. Clicks "Generate Post"');
        console.log('3. System generates tweet text + image with emoji support');

    } catch (error) {
        console.error('❌ Test failed:', error);
        console.error('Stack trace:', error.stack);
    }
}

testAdminDashboardEmoji();
