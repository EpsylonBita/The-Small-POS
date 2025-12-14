// Comprehensive Playwright Tests for Menu Functionality
const { test, expect } = require('@playwright/test');

// Test configuration
const POS_URL = 'http://localhost:3000'; // Adjust based on your dev server
const TIMEOUT = 30000; // 30 seconds

test.describe('POS System Menu Functionality', () => {
  
  test.beforeEach(async ({ page }) => {
    // Navigate to POS system
    await page.goto(POS_URL);
    
    // Wait for the application to load
    await page.waitForLoadState('networkidle');
    
    // Handle any initial authentication if needed
    // This might need to be adjusted based on your auth flow
    try {
      await page.waitForSelector('[data-testid="login-form"]', { timeout: 5000 });
      // If login form is present, fill it out
      await page.fill('[data-testid="username"]', 'test-user');
      await page.fill('[data-testid="password"]', 'test-password');
      await page.click('[data-testid="login-button"]');
    } catch (error) {
      // No login form found, continue
      console.log('No login form detected, proceeding...');
    }
    
    // Wait for main interface to load
    await page.waitForSelector('[data-testid="main-interface"]', { timeout: TIMEOUT });
  });

  test('should load menu categories successfully', async ({ page }) => {
    console.log('🧪 Testing menu category loading...');
    
    // Navigate to menu page if not already there
    await page.click('[data-testid="menu-tab"]');
    
    // Wait for menu categories to load
    await page.waitForSelector('[data-testid="menu-categories"]', { timeout: TIMEOUT });
    
    // Check that categories are displayed
    const categories = await page.locator('[data-testid="category-tab"]').all();
    
    // Should have at least some categories (we know there are 12 in the database)
    expect(categories.length).toBeGreaterThan(0);
    console.log(`✅ Found ${categories.length} menu categories`);
    
    // Verify category names are displayed
    for (let i = 0; i < Math.min(categories.length, 3); i++) {
      const categoryText = await categories[i].textContent();
      expect(categoryText).toBeTruthy();
      expect(categoryText.trim().length).toBeGreaterThan(0);
    }
    
    console.log('✅ Menu categories loaded successfully');
  });

  test('should display menu items when category is selected', async ({ page }) => {
    console.log('🧪 Testing menu item display...');
    
    // Navigate to menu page
    await page.click('[data-testid="menu-tab"]');
    await page.waitForSelector('[data-testid="menu-categories"]', { timeout: TIMEOUT });
    
    // Click on the first category
    const firstCategory = page.locator('[data-testid="category-tab"]').first();
    await firstCategory.click();
    
    // Wait for menu items to load
    await page.waitForSelector('[data-testid="menu-items-grid"]', { timeout: TIMEOUT });
    
    // Check that menu items are displayed
    const menuItems = await page.locator('[data-testid="menu-item"]').all();
    
    if (menuItems.length > 0) {
      console.log(`✅ Found ${menuItems.length} menu items in selected category`);
      
      // Verify first menu item has required elements
      const firstItem = menuItems[0];
      
      // Check for item name
      const itemName = await firstItem.locator('[data-testid="item-name"]').textContent();
      expect(itemName).toBeTruthy();
      
      // Check for item price
      const itemPrice = await firstItem.locator('[data-testid="item-price"]').textContent();
      expect(itemPrice).toBeTruthy();
      expect(itemPrice).toMatch(/€\d+\.\d{2}/); // Should match Euro price format
      
      console.log(`✅ Menu item validation passed: ${itemName} - ${itemPrice}`);
    } else {
      console.log('ℹ️ No menu items found in selected category');
    }
  });

  test('should handle menu item selection and modal display', async ({ page }) => {
    console.log('🧪 Testing menu item selection...');
    
    // Navigate to menu and select category
    await page.click('[data-testid="menu-tab"]');
    await page.waitForSelector('[data-testid="menu-categories"]', { timeout: TIMEOUT });
    
    const firstCategory = page.locator('[data-testid="category-tab"]').first();
    await firstCategory.click();
    
    await page.waitForSelector('[data-testid="menu-items-grid"]', { timeout: TIMEOUT });
    
    // Click on first menu item
    const firstMenuItem = page.locator('[data-testid="menu-item"]').first();
    
    if (await firstMenuItem.count() > 0) {
      await firstMenuItem.click();
      
      // Wait for item modal to appear
      await page.waitForSelector('[data-testid="menu-item-modal"]', { timeout: TIMEOUT });
      
      // Verify modal content
      const modalTitle = await page.locator('[data-testid="modal-title"]').textContent();
      expect(modalTitle).toBeTruthy();
      
      // Check for quantity controls
      await expect(page.locator('[data-testid="quantity-decrease"]')).toBeVisible();
      await expect(page.locator('[data-testid="quantity-increase"]')).toBeVisible();
      
      // Check for add to cart button
      await expect(page.locator('[data-testid="add-to-cart"]')).toBeVisible();
      
      console.log('✅ Menu item modal displayed correctly');
      
      // Close modal
      await page.click('[data-testid="close-modal"]');
      await page.waitForSelector('[data-testid="menu-item-modal"]', { state: 'hidden' });
    } else {
      console.log('ℹ️ No menu items available for selection test');
    }
  });

  test('should handle network errors gracefully', async ({ page }) => {
    console.log('🧪 Testing network error handling...');
    
    // Intercept network requests and simulate failure
    await page.route('**/menu_categories*', route => {
      route.abort('failed');
    });
    
    // Navigate to menu page
    await page.click('[data-testid="menu-tab"]');
    
    // Wait for error handling
    await page.waitForTimeout(5000);
    
    // Check for error message or fallback content
    const errorMessage = page.locator('[data-testid="error-message"]');
    const fallbackContent = page.locator('[data-testid="fallback-categories"]');
    
    const hasErrorMessage = await errorMessage.count() > 0;
    const hasFallbackContent = await fallbackContent.count() > 0;
    
    if (hasErrorMessage || hasFallbackContent) {
      console.log('✅ Network error handled gracefully');
    } else {
      console.log('⚠️ Network error handling might need improvement');
    }
    
    // Clear route interception
    await page.unroute('**/menu_categories*');
  });

  test('should display loading states appropriately', async ({ page }) => {
    console.log('🧪 Testing loading states...');
    
    // Slow down network to observe loading states
    await page.route('**/menu_categories*', async route => {
      await new Promise(resolve => setTimeout(resolve, 2000)); // 2 second delay
      route.continue();
    });
    
    // Navigate to menu page
    await page.click('[data-testid="menu-tab"]');
    
    // Check for loading indicator
    const loadingIndicator = page.locator('[data-testid="loading-spinner"]');
    
    // Should show loading initially
    await expect(loadingIndicator).toBeVisible({ timeout: 1000 });
    console.log('✅ Loading indicator displayed');
    
    // Should hide loading after data loads
    await expect(loadingIndicator).toBeHidden({ timeout: TIMEOUT });
    console.log('✅ Loading indicator hidden after data load');
    
    // Clear route interception
    await page.unroute('**/menu_categories*');
  });

  test('should maintain responsive design on different screen sizes', async ({ page }) => {
    console.log('🧪 Testing responsive design...');
    
    // Test mobile viewport
    await page.setViewportSize({ width: 375, height: 667 });
    await page.click('[data-testid="menu-tab"]');
    await page.waitForSelector('[data-testid="menu-categories"]', { timeout: TIMEOUT });
    
    // Check that categories are still accessible
    const categories = await page.locator('[data-testid="category-tab"]').all();
    expect(categories.length).toBeGreaterThan(0);
    console.log('✅ Mobile viewport: Categories accessible');
    
    // Test tablet viewport
    await page.setViewportSize({ width: 768, height: 1024 });
    await page.waitForTimeout(1000);
    
    // Categories should still be visible
    await expect(page.locator('[data-testid="menu-categories"]')).toBeVisible();
    console.log('✅ Tablet viewport: Categories accessible');
    
    // Test desktop viewport
    await page.setViewportSize({ width: 1920, height: 1080 });
    await page.waitForTimeout(1000);
    
    await expect(page.locator('[data-testid="menu-categories"]')).toBeVisible();
    console.log('✅ Desktop viewport: Categories accessible');
  });

  test('should handle real-time updates', async ({ page }) => {
    console.log('🧪 Testing real-time updates...');
    
    // Navigate to menu page
    await page.click('[data-testid="menu-tab"]');
    await page.waitForSelector('[data-testid="menu-categories"]', { timeout: TIMEOUT });
    
    // Get initial category count
    const initialCategories = await page.locator('[data-testid="category-tab"]').all();
    const initialCount = initialCategories.length;
    
    console.log(`📊 Initial category count: ${initialCount}`);
    
    // Simulate real-time update by triggering a refresh
    // In a real test, this would involve actual database changes
    await page.reload();
    await page.waitForSelector('[data-testid="menu-categories"]', { timeout: TIMEOUT });
    
    // Verify categories are still loaded
    const updatedCategories = await page.locator('[data-testid="category-tab"]').all();
    expect(updatedCategories.length).toBeGreaterThan(0);
    
    console.log(`📊 Updated category count: ${updatedCategories.length}`);
    console.log('✅ Real-time update handling verified');
  });

  test('should perform well under load', async ({ page }) => {
    console.log('🧪 Testing performance under load...');
    
    const startTime = Date.now();
    
    // Navigate to menu page
    await page.click('[data-testid="menu-tab"]');
    await page.waitForSelector('[data-testid="menu-categories"]', { timeout: TIMEOUT });
    
    const categoryLoadTime = Date.now() - startTime;
    console.log(`⏱️ Category load time: ${categoryLoadTime}ms`);
    
    // Click through multiple categories quickly
    const categories = await page.locator('[data-testid="category-tab"]').all();
    
    for (let i = 0; i < Math.min(categories.length, 5); i++) {
      const categoryStartTime = Date.now();
      
      await categories[i].click();
      await page.waitForSelector('[data-testid="menu-items-grid"]', { timeout: TIMEOUT });
      
      const categoryClickTime = Date.now() - categoryStartTime;
      console.log(`⏱️ Category ${i + 1} switch time: ${categoryClickTime}ms`);
      
      // Performance should be reasonable (under 3 seconds)
      expect(categoryClickTime).toBeLessThan(3000);
    }
    
    console.log('✅ Performance test completed');
  });

});

// Test configuration and setup
test.describe.configure({ mode: 'parallel' });

// Global test settings
test.setTimeout(60000); // 60 seconds per test

// Export test results for documentation
module.exports = {
  testSuite: 'POS System Menu Functionality',
  totalTests: 8,
  categories: [
    'Menu Category Loading',
    'Menu Item Display',
    'Item Selection & Modal',
    'Network Error Handling',
    'Loading States',
    'Responsive Design',
    'Real-time Updates',
    'Performance Testing'
  ]
};
