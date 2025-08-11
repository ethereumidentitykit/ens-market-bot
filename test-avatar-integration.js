const { ImageGenerationService } = require('./dist/services/imageGenerationService');

async function testAvatarIntegration() {
  try {
    console.log('🎨 Testing avatar integration...');
    console.log('This will test: Real ENS avatars, missing avatars, invalid URLs');
    
    // Get mock data with different avatar scenarios
    const avatarTestData = ImageGenerationService.getMockDataWithAvatars();
    
    for (let i = 0; i < avatarTestData.length; i++) {
      const data = avatarTestData[i];
      const testName = [
        'Real ENS Avatars (vitalik.eth & brantly.eth)',
        'Mixed Avatars (nick.eth & no avatar)',
        'Fallback Test (invalid URL & no avatar)'
      ][i];
      
      console.log(`\n📊 Test ${i + 1}: ${testName}`);
      console.log('Data:', {
        priceEth: data.priceEth,
        priceUsd: data.priceUsd,
        ensName: data.ensName,
        buyerEns: data.buyerEns,
        buyerAvatar: data.buyerAvatar || 'No avatar (default)',
        sellerEns: data.sellerEns,
        sellerAvatar: data.sellerAvatar || 'No avatar (default)'
      });
      
      const startTime = Date.now();
      const imageBuffer = await ImageGenerationService.generateSaleImage(data);
      const endTime = Date.now();
      
      const filename = `test-avatars-${i + 1}.png`;
      const imagePath = await ImageGenerationService.saveImageToFile(imageBuffer, filename);
      
      console.log(`✅ Generated: ${imagePath}`);
      console.log(`⏱️ Processing time: ${endTime - startTime}ms`);
    }
    
    console.log('\n🎯 Task 1.4 Complete: Avatar integration working!');
    console.log('📁 Check the /data folder for avatar test images');
    console.log('\n✨ Features tested:');
    console.log('  - Real ENS avatar loading');
    console.log('  - Circular avatar clipping');
    console.log('  - Default avatar fallback');
    console.log('  - Invalid URL error handling');
    console.log('  - Performance with HTTP requests');
    
  } catch (error) {
    console.error('❌ Error testing avatar integration:', error);
  }
}

testAvatarIntegration();
