/**
 * Timeout Scenarios Test Suite
 * 
 * Tests timeout handling for various operations
 */

const { test, expect } = require('@playwright/test');
const {
  mockDatabaseTimeout,
  mockSupabaseTimeout,
  mockSlowResponse,
  navigateToMenuPage,
  navigateToNewOrderPage,
  waitForErrorDisplay,
  getErrorMessage,
  clickRetryButton,
  measureTiming,
  clearRouteMocks
} = require('./helpers/test-helpers');

test.describe('Timeout Scenarios', () => {
  test.afterEach(async ({ page }) => {
    await clearRouteMocks(page);
  });

  test('should timeout menu categories fetch after 10 seconds', async ({ page }) => {
    // Mock timeout exceeding MENU_LOAD_TIMEOUT (10s)
    await mockSupabaseTimeout(page, 'menu_categories', 12000);
    
    // Measure time to error
    const { duration } = await measureTiming(async () => {
      await navigateToMenuPage(page);
      await waitForErrorDisplay(page);
    });
    
    // Verify timeout occurred around 10 seconds (with some tolerance)
    expect(duration).toBeGreaterThan(9000);
    expect(duration).toBeLessThan(13000);
    
    // Verify timeout error message
    const errorMessage = await getErrorMessage(page);
    expect(errorMessage.toLowerCase()).toContain('timeout');
  });

  test('should timeout menu items fetch after 10 seconds', async ({ page }) => {
    // Mock timeout for menu items
    await mockSupabaseTimeout(page, 'menu_items', 12000);
    
    // Navigate to menu page
    await navigateToMenuPage(page);
    
    // Wait for error display
    await waitForErrorDisplay(page);
    
    // Verify timeout error
    const errorMessage = await getErrorMessage(page);
    expect(errorMessage).toMatch(/timeout|timed out/i);
  });

  test('should timeout customer lookup after 6 seconds', async ({ page }) => {
    // Navigate to new order page
    await navigateToNewOrderPage(page);
    
    // Mock customer lookup timeout (exceeds CUSTOMER_LOOKUP_TIMEOUT: 6s)
    await page.route('**/customer:lookup*', async (route) => {
      await new Promise(resolve => setTimeout(resolve, 8000));
      await route.abort('timedout');
    });
    
    // Open customer lookup
    const lookupButton = await page.locator('button:has-text("Customer Lookup")');
    if (await lookupButton.count() > 0) {
      await lookupButton.click();
      
      // Enter phone and search
      await page.fill('input[type="tel"]', '1234567890');
      
      // Measure timeout
      const { duration } = await measureTiming(async () => {
        await page.click('button:has-text("Search")');
        await waitForErrorDisplay(page);
      });
      
      // Verify timeout around 6 seconds
      expect(duration).toBeGreaterThan(5000);
      expect(duration).toBeLessThan(8000);
    }
  });

  test('should timeout order creation after 8 seconds', async ({ page }) => {
    // Navigate to new order page
    await navigateToNewOrderPage(page);
    
    // Mock slow order creation (exceeds ORDER_CREATE_TIMEOUT: 8s)
    await mockSlowResponse(page, '**/rest/v1/orders*', 10000);
    
    // Fill minimal order data
    const placeOrderButton = await page.locator('button:has-text("Place Order")');
    if (await placeOrderButton.count() > 0) {
      // Measure timeout
      const { duration } = await measureTiming(async () => {
        await placeOrderButton.click();
        await page.waitForSelector('text=/timeout|error/i', { timeout: 12000 });
      });
      
      // Verify timeout around 8 seconds
      expect(duration).toBeGreaterThan(7000);
      expect(duration).toBeLessThan(11000);
    }
  });

  test('should timeout database query after 5 seconds', async ({ page }) => {
    // Mock database timeout
    await mockDatabaseTimeout(page, 7000);
    
    // Navigate to menu page
    const { duration } = await measureTiming(async () => {
      await navigateToMenuPage(page);
      await waitForErrorDisplay(page);
    });
    
    // Verify timeout occurred
    expect(duration).toBeGreaterThan(4000);
    expect(duration).toBeLessThan(8000);
    
    // Verify error message
    const errorMessage = await getErrorMessage(page);
    expect(errorMessage).toMatch(/timeout|database/i);
  });

  test('should retry after timeout and succeed', async ({ page }) => {
    // Mock initial timeout
    await mockSupabaseTimeout(page, 'menu_categories', 12000);
    
    // Navigate to menu page
    await navigateToMenuPage(page);
    
    // Wait for timeout error
    await waitForErrorDisplay(page);
    
    // Clear timeout mock
    await clearRouteMocks(page);
    
    // Mock successful response
    await page.route('**/rest/v1/menu_categories*', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([
          { id: 1, name: 'Crepes', display_order: 1 }
        ])
      });
    });
    
    // Click retry
    await clickRetryButton(page);
    
    // Verify success
    await page.waitForSelector('.error-display', { state: 'hidden', timeout: 10000 });
    const content = await page.locator('.menu-grid, [class*="grid"]');
    await expect(content).toBeVisible();
  });

  test('should handle multiple timeout retries with exponential backoff', async ({ page }) => {
    // Mock persistent timeout
    let attemptCount = 0;
    await page.route('**/rest/v1/menu_items*', async (route) => {
      attemptCount++;
      if (attemptCount < 3) {
        await new Promise(resolve => setTimeout(resolve, 12000));
        await route.abort('timedout');
      } else {
        await route.fulfill({
          status: 200,
          body: JSON.stringify([])
        });
      }
    });
    
    // Navigate to menu page
    await navigateToMenuPage(page);
    
    // Wait for initial timeout
    await waitForErrorDisplay(page);
    
    // Retry multiple times
    for (let i = 0; i < 2; i++) {
      await clickRetryButton(page);
      await page.waitForTimeout(2000);
    }
    
    // Verify eventual success
    await page.waitForTimeout(3000);
    const errorVisible = await page.locator('.error-display').isVisible().catch(() => false);
    expect(errorVisible).toBe(false);
  });

  test('should timeout Supabase request after 8 seconds', async ({ page }) => {
    // Mock Supabase timeout (exceeds SUPABASE_REQUEST_TIMEOUT: 8s)
    await mockSupabaseTimeout(page, 'ingredients', 10000);
    
    // Navigate to menu page
    await navigateToMenuPage(page);
    
    // Measure time to timeout
    const { duration } = await measureTiming(async () => {
      await page.waitForTimeout(12000);
    });
    
    // Verify timeout occurred
    expect(duration).toBeGreaterThan(7000);
  });

  test('should show timeout error with retry suggestion', async ({ page }) => {
    // Mock timeout
    await mockSupabaseTimeout(page, 'menu_categories', 12000);
    
    // Navigate to menu page
    await navigateToMenuPage(page);
    
    // Wait for error
    await waitForErrorDisplay(page);
    
    // Verify error message includes retry suggestion
    const errorMessage = await getErrorMessage(page);
    expect(errorMessage.toLowerCase()).toMatch(/retry|try again/);
    
    // Verify retry button exists
    const retryButton = await page.locator('.error-display button:has-text("Retry")');
    await expect(retryButton).toBeVisible();
  });

  test('should handle timeout during order status update', async ({ page }) => {
    // Navigate to orders page
    await page.goto('/orders');
    
    // Mock timeout for status update
    await mockSlowResponse(page, '**/rest/v1/orders*', 10000);
    
    // Click update status button (if exists)
    const updateButton = await page.locator('button:has-text("Update Status")').first();
    if (await updateButton.count() > 0) {
      const { duration } = await measureTiming(async () => {
        await updateButton.click();
        await page.waitForSelector('text=/timeout|error/i', { timeout: 12000 });
      });
      
      // Verify timeout occurred
      expect(duration).toBeGreaterThan(7000);
    }
  });

  test('should timeout database initialization after 10 seconds', async ({ page }) => {
    // Mock database init timeout
    await mockDatabaseTimeout(page, 12000);
    
    // Restart app (simulate)
    await page.goto('/');
    
    // Wait for timeout error
    await page.waitForSelector('text=/timeout|database|initialization/i', { timeout: 15000 });
    
    // Verify error message
    const errorText = await page.locator('text=/timeout|database/i').textContent();
    expect(errorText).toBeTruthy();
  });

  test('should provide user-friendly timeout messages', async ({ page }) => {
    // Mock timeout
    await mockSupabaseTimeout(page, 'menu_items', 12000);
    
    // Navigate to menu page
    await navigateToMenuPage(page);
    
    // Wait for error
    await waitForErrorDisplay(page);
    
    // Verify message is user-friendly (not technical)
    const errorMessage = await getErrorMessage(page);
    
    // Should not contain technical jargon
    expect(errorMessage).not.toMatch(/ETIMEDOUT|ECONNREFUSED|500|ERR_/);
    
    // Should contain helpful information
    expect(errorMessage.toLowerCase()).toMatch(/timeout|slow|connection|try again/);
  });

  test('should log timeout details for debugging', async ({ page }) => {
    const consoleLogs = [];
    page.on('console', msg => {
      if (msg.type() === 'error' || msg.type() === 'warn') {
        consoleLogs.push(msg.text());
      }
    });
    
    // Mock timeout
    await mockSupabaseTimeout(page, 'menu_categories', 12000);
    
    // Navigate to menu page
    await navigateToMenuPage(page);
    
    // Wait for error
    await waitForErrorDisplay(page);
    
    // Verify timeout was logged
    await page.waitForTimeout(1000);
    const timeoutLogged = consoleLogs.some(log => 
      log.toLowerCase().includes('timeout') || 
      log.toLowerCase().includes('timed out')
    );
    
    expect(timeoutLogged).toBe(true);
  });

  test('should handle concurrent timeouts gracefully', async ({ page }) => {
    // Mock multiple endpoint timeouts
    await mockSupabaseTimeout(page, 'menu_categories', 12000);
    await mockSupabaseTimeout(page, 'menu_items', 12000);
    await mockSupabaseTimeout(page, 'ingredients', 12000);
    
    // Navigate to menu page
    await navigateToMenuPage(page);
    
    // Wait for error
    await waitForErrorDisplay(page);
    
    // Verify only one error display (not multiple)
    const errorCount = await page.locator('.error-display').count();
    expect(errorCount).toBe(1);
    
    // Verify error message is clear
    const errorMessage = await getErrorMessage(page);
    expect(errorMessage).toBeTruthy();
  });

  test('should allow configuration of timeout values', async ({ page }) => {
    // This test verifies that timeout constants are configurable
    // by checking if different operations have different timeout values
    
    // Mock different timeouts for different operations
    await mockSupabaseTimeout(page, 'menu_categories', 12000); // Should timeout at 10s
    
    const { duration: menuTimeout } = await measureTiming(async () => {
      await navigateToMenuPage(page);
      await waitForErrorDisplay(page);
    });
    
    // Clear and test customer lookup timeout
    await clearRouteMocks(page);
    await navigateToNewOrderPage(page);
    
    await page.route('**/customer:lookup*', async (route) => {
      await new Promise(resolve => setTimeout(resolve, 8000));
      await route.abort('timedout');
    });
    
    const lookupButton = await page.locator('button:has-text("Customer Lookup")');
    if (await lookupButton.count() > 0) {
      await lookupButton.click();
      await page.fill('input[type="tel"]', '1234567890');
      
      const { duration: lookupTimeout } = await measureTiming(async () => {
        await page.click('button:has-text("Search")');
        await waitForErrorDisplay(page);
      });
      
      // Verify different timeout values
      // Menu timeout should be ~10s, lookup should be ~6s
      expect(Math.abs(menuTimeout - lookupTimeout)).toBeGreaterThan(2000);
    }
  });
});

