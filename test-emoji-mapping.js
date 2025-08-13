const { emojiMappingService } = require('./dist/services/emojiMappingService');

async function testEmojiMapping() {
    console.log('Testing Emoji Mapping Service...\n');

    try {
        // Initialize the service
        console.log('1. Initializing service...');
        await emojiMappingService.initialize();
        
        const stats = emojiMappingService.getStats();
        console.log(`✅ Initialized with ${stats.totalMapped} mapped emojis\n`);

        // Test individual emoji lookup
        console.log('2. Testing individual emoji lookup...');
        const testEmojis = ['🧦', '🧞', '🗻', '🎠', '🦧'];
        
        for (const emoji of testEmojis) {
            const isSupported = emojiMappingService.isEmojiSupported(emoji);
            console.log(`${emoji} (${emoji.codePointAt(0)?.toString(16)}): ${isSupported ? '✅ Supported' : '❌ Not supported'}`);
            
            if (isSupported) {
                const svg = await emojiMappingService.getEmojiSvg(emoji);
                console.log(`   SVG length: ${svg?.length || 0} characters`);
            }
        }

        // Test text replacement
        console.log('\n3. Testing text replacement...');
        const testTexts = [
            'Hello 🧦 world!',
            'ENS name: test🎠domain.eth',
            'Complex: 🧞‍♂️ and 🦧',
            'No emojis here',
            'Multiple 🗻🎠🧦 emojis'
        ];

        for (const text of testTexts) {
            console.log(`\nOriginal: "${text}"`);
            const replaced = await emojiMappingService.replaceEmojisWithSvg(text);
            const hasReplacement = replaced.includes('<svg');
            console.log(`Replaced: ${hasReplacement ? '✅ Contains SVG' : '❌ No replacement'}`);
            if (hasReplacement) {
                console.log(`   Length: ${text.length} → ${replaced.length} chars`);
            }
        }

        console.log('\n✅ All tests completed successfully!');

    } catch (error) {
        console.error('❌ Test failed:', error);
    }
}

testEmojiMapping();
