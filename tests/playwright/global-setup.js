// Global Setup for Playwright Tests
const { chromium } = require('@playwright/test');

async function globalSetup(config) {
  console.log('🚀 Starting Playwright Global Setup...');
  
  // Create a browser instance for setup
  const browser = await chromium.launch();
  const context = await browser.newContext();
  const page = await context.newPage();
  
  try {
    // Wait for the development server to be ready
    console.log('⏳ Waiting for development server...');
    
    let retries = 0;
    const maxRetries = 30; // 30 attempts = 1 minute
    
    while (retries < maxRetries) {
      try {
        await page.goto(config.use.baseURL, { timeout: 5000 });
        console.log('✅ Development server is ready');
        break;
      } catch (error) {
        retries++;
        console.log(`⏳ Attempt ${retries}/${maxRetries} - Server not ready yet...`);
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
    }
    
    if (retries >= maxRetries) {
      throw new Error('Development server failed to start within timeout');
    }
    
    // Perform any additional setup tasks
    console.log('🔧 Performing additional setup tasks...');
    
    // Check if the application loads correctly
    await page.waitForLoadState('networkidle');
    
    // Verify critical elements are present
    const hasMainInterface = await page.locator('body').count() > 0;
    if (!hasMainInterface) {
      throw new Error('Main interface not found - application may not be loading correctly');
    }
    
    console.log('✅ Application verification completed');
    
    // Store any global state if needed
    // This could include authentication tokens, test data setup, etc.
    
    console.log('🎉 Global setup completed successfully');
    
  } catch (error) {
    console.error('❌ Global setup failed:', error.message);
    throw error;
  } finally {
    await context.close();
    await browser.close();
  }
}

module.exports = globalSetup;
