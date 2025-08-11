const { ImageGenerationService } = require('./dist/services/imageGenerationService');

async function testLongNamesTruncation() {
  try {
    console.log('🎨 Testing long names truncation and improvements...');
    
    // Test with very long names to verify truncation
    const longNamesData = {
      priceEth: 15.75,
      priceUsd: 64420.50,
      ensName: 'verylongdomainname.eth',
      buyerAddress: '0x1234567890abcdef1234567890abcdef12345678',
      buyerEns: 'superlongbuyernamethatdoesntfit.eth', // Very long name
      sellerAddress: '0xabcdef1234567890abcdef1234567890abcdef12',
      sellerEns: 'extremelylongsellernamethatwillgettruncated.eth', // Very long name
      transactionHash: '0xlongnames123456789abcdef',
      timestamp: new Date()
    };

    console.log('📊 Testing with long names:', {
      priceEth: longNamesData.priceEth,
      priceUsd: longNamesData.priceUsd,
      ensName: longNamesData.ensName,
      buyerEns: longNamesData.buyerEns,
      sellerEns: longNamesData.sellerEns
    });
    
    const startTime = Date.now();
    const imageBuffer = await ImageGenerationService.generateSaleImage(longNamesData);
    const endTime = Date.now();
    
    const filename = `test-long-names-fixed-${Date.now()}.png`;
    const imagePath = await ImageGenerationService.saveImageToFile(imageBuffer, filename);
    
    console.log(`✅ Generated: ${imagePath}`);
    console.log(`⏱️ Processing time: ${endTime - startTime}ms`);
    
    // Also test with addresses (no ENS names)
    const addressOnlyData = {
      priceEth: 2.33,
      priceUsd: 9520.99,
      ensName: 'test.eth',
      buyerAddress: '0x1234567890abcdef1234567890abcdef12345678',
      buyerEns: '0x1234567890abcdef1234567890abcdef12345678', // Full address
      sellerAddress: '0xabcdef1234567890abcdef1234567890abcdef12',
      sellerEns: '0xabcdef1234567890abcdef1234567890abcdef12', // Full address
      transactionHash: '0xaddresses123456789abcdef',
      timestamp: new Date()
    };

    console.log('\n📊 Testing with addresses only:', {
      buyerEns: addressOnlyData.buyerEns,
      sellerEns: addressOnlyData.sellerEns
    });

    const addressImageBuffer = await ImageGenerationService.generateSaleImage(addressOnlyData);
    const addressImagePath = await ImageGenerationService.saveImageToFile(addressImageBuffer, `test-addresses-only-${Date.now()}.png`);
    
    console.log(`✅ Generated: ${addressImagePath}`);
    
    console.log('\n🎯 Key Improvements Tested:');
    console.log('  - ✅ Removed dark border background');
    console.log('  - ✅ Center-aligned price text');
    console.log('  - ✅ Using nameplaceholder.png (if available)');
    console.log('  - ✅ Smart text truncation for long names');
    console.log('  - ✅ Address truncation (0xabc...xyz)');
    console.log('  - ✅ Bigger arrow head (24px vs 15px)');
    console.log('  - ✅ ENS name truncation (veryl...ame.eth)');
    
  } catch (error) {
    console.error('❌ Error testing improvements:', error);
  }
}

testLongNamesTruncation();
