#!/usr/bin/env node

/**
 * Test Puppeteer on VPS to debug image generation issues
 */

async function testPuppeteer() {
  console.log('🔍 Testing Puppeteer on VPS...\n');
  
  try {
    console.log('1. Checking environment...');
    console.log(`   NODE_ENV: ${process.env.NODE_ENV}`);
    console.log(`   VERCEL: ${process.env.VERCEL}`);
    console.log(`   Platform: ${process.platform}`);
    console.log(`   Arch: ${process.arch}\n`);
    
    console.log('2. Attempting to import Puppeteer...');
    const puppeteer = await import('puppeteer');
    console.log('   ✅ Puppeteer imported successfully\n');
    
    console.log('3. Attempting to launch browser...');
    const browser = await puppeteer.default.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--no-zygote',
        '--single-process',
        '--disable-gpu'
      ]
    });
    console.log('   ✅ Browser launched successfully\n');
    
    console.log('4. Creating new page...');
    const page = await browser.newPage();
    console.log('   ✅ Page created successfully\n');
    
    console.log('5. Setting viewport...');
    await page.setViewport({ width: 800, height: 600 });
    console.log('   ✅ Viewport set successfully\n');
    
    console.log('6. Setting HTML content...');
    await page.setContent(`
      <!DOCTYPE html>
      <html>
        <head>
          <style>
            body { 
              font-family: Arial, sans-serif; 
              background: linear-gradient(45deg, #1e3c72, #2a5298);
              color: white;
              display: flex;
              align-items: center;
              justify-content: center;
              height: 100vh;
              margin: 0;
            }
            .test { 
              text-align: center;
              padding: 20px;
              border: 2px solid white;
              border-radius: 10px;
            }
          </style>
        </head>
        <body>
          <div class="test">
            <h1>🚀 VPS Puppeteer Test</h1>
            <p>If you can see this image, Puppeteer is working!</p>
            <p>Timestamp: ${new Date().toISOString()}</p>
          </div>
        </body>
      </html>
    `, { waitUntil: 'networkidle0', timeout: 5000 });
    console.log('   ✅ HTML content set successfully\n');
    
    console.log('7. Taking screenshot...');
    const screenshot = await page.screenshot({
      type: 'png',
      clip: { x: 0, y: 0, width: 800, height: 600 }
    });
    console.log('   ✅ Screenshot taken successfully\n');
    
    console.log('8. Closing browser...');
    await browser.close();
    console.log('   ✅ Browser closed successfully\n');
    
    console.log('9. Saving test image...');
    const fs = await import('fs');
    const path = await import('path');
    
    const testImagePath = path.default.join(process.cwd(), 'puppeteer-test.png');
    fs.default.writeFileSync(testImagePath, screenshot);
    console.log(`   ✅ Test image saved: ${testImagePath}\n`);
    
    console.log('🎉 SUCCESS! Puppeteer is working correctly on VPS');
    console.log(`📸 Test image size: ${screenshot.length} bytes`);
    console.log(`📁 Image saved to: ${testImagePath}`);
    
  } catch (error) {
    console.error('❌ PUPPETEER TEST FAILED:');
    console.error('Error name:', error.name);
    console.error('Error message:', error.message);
    console.error('Error stack:', error.stack);
    
    if (error.message.includes('Could not find expected browser')) {
      console.error('\n💡 FIX: Install Chromium dependencies:');
      console.error('   sudo apt update');
      console.error('   sudo apt install -y chromium-browser');
      console.error('   # OR install all dependencies:');
      console.error('   sudo apt install -y gconf-service libasound2 libatk1.0-0 libc6 libcairo2 libcups2 libdbus-1-3 libexpat1 libfontconfig1 libgcc1 libgconf-2-4 libgdk-pixbuf2.0-0 libglib2.0-0 libgtk-3-0 libnspr4 libpango-1.0-0 libpangocairo-1.0-0 libstdc++6 libx11-6 libx11-xcb1 libxcb1 libxcomposite1 libxcursor1 libxdamage1 libxext6 libxfixes3 libxi6 libxrandr2 libxrender1 libxss1 libxtst6 ca-certificates fonts-liberation libappindicator1 libnss3 lsb-release xdg-utils wget');
    }
    
    if (error.message.includes('Permission denied')) {
      console.error('\n💡 FIX: Permission issue - try running with different user or check file permissions');
    }
    
    process.exit(1);
  }
}

testPuppeteer();
