const { ImageGenerationService } = require('./dist/services/imageGenerationService');

async function testPillShape() {
  console.log('🧪 Testing pill shape with perfect capsule ends...');
  
  const testData = {
    priceEth: 5.51,
    priceUsd: 22560.01,
    ensName: 'test.eth',
    buyerEns: 'buyer.eth',
    sellerEns: 'seller.eth'
  };

  try {
    const imageBuffer = await ImageGenerationService.generateSaleImage(testData);
    const filename = `test-pill-shape-${Date.now()}.png`;
    
    await ImageGenerationService.saveImageToFile(imageBuffer, filename);
    
    console.log(`✅ Generated pill shape test: data/${filename}`);
    console.log('📏 Pill dimensions: 433x132px with 66px border radius');
    console.log('🎯 Should show perfect capsule ends (semicircular)');
    
  } catch (error) {
    console.error('❌ Error:', error);
  }
}

testPillShape();
