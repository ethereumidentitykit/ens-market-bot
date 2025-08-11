const { ImageGenerationService } = require('./dist/services/imageGenerationService');

async function testImprovedLayout() {
  try {
    console.log('🎨 Testing improved layout matching your design...');
    
    // Test with the updated mock data (vitalik.eth)
    const mockData = ImageGenerationService.getMockData();
    console.log('📊 Mock data:', {
      priceEth: mockData.priceEth,
      priceUsd: mockData.priceUsd,
      ensName: mockData.ensName,
      buyerEns: mockData.buyerEns,
      sellerEns: mockData.sellerEns
    });
    
    const startTime = Date.now();
    const imageBuffer = await ImageGenerationService.generateSaleImage(mockData);
    const endTime = Date.now();
    
    const filename = `improved-layout-${Date.now()}.png`;
    const imagePath = await ImageGenerationService.saveImageToFile(imageBuffer, filename);
    
    console.log(`✅ Generated improved layout: ${imagePath}`);
    console.log(`⏱️ Processing time: ${endTime - startTime}ms`);
    
    console.log('\n🎯 Key Improvements:');
    console.log('  - Added card container with rounded corners');
    console.log('  - Better positioning matching your design');
    console.log('  - Larger font sizes for better readability');
    console.log('  - ENS image integration (with fallback)');
    console.log('  - Improved spacing and proportions');
    
  } catch (error) {
    console.error('❌ Error testing improved layout:', error);
  }
}

testImprovedLayout();
