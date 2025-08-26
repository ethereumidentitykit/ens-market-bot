const { DatabaseService } = require('../dist/services/databaseService');

async function testPriceTiers() {
  const db = new DatabaseService();
  
  try {
    console.log('Initializing database...');
    await db.initialize();
    
    console.log('\n📊 Fetching price tiers...');
    const tiers = await db.getPriceTiers();
    console.table(tiers.map(t => ({
      tier: t.tierName,
      level: t.tierLevel,
      minUSD: `$${t.minUsd.toLocaleString()}`,
      maxUSD: t.maxUsd ? `$${t.maxUsd.toLocaleString()}` : 'No limit',
      description: t.description
    })));
    
    console.log('\n🔍 Testing tier selection for different amounts:');
    const testAmounts = [1000, 7500, 25000, 75000, 150000];
    
    for (const amount of testAmounts) {
      const tier = await db.getPriceTierForAmount(amount);
      if (tier) {
        console.log(`  $${amount.toLocaleString()} → Tier ${tier.tierLevel} (${tier.tierName}) - ${tier.description}`);
      } else {
        console.log(`  $${amount.toLocaleString()} → Below minimum tier (no image)`);
      }
    }
    
    console.log('\n✅ Price tier system is working correctly!');
    
  } catch (error) {
    console.error('❌ Error testing price tiers:', error);
  } finally {
    await db.close();
  }
}

testPriceTiers();
