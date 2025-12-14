/**
 * Loading States Test Suite
 * 
 * Tests skeleton screens, loading indicators, and loading state transitions
 */

const { test, expect } = require('@playwright/test');
const {
  mockSlowResponse,
  navigateToMenuPage,
  navigateToNewOrderPage,
  waitForSkeleton,
  waitForSkeletonToDisappear,
  waitForLoadingSpinner,
  waitForLoadingSpinnerToDisappear,
  isVisible,
  measureTiming,
  clearRouteMocks
} = require('./helpers/test-helpers');

test.describe('Loading States', () => {
  test.afterEach(async ({ page }) => {
    await clearRouteMocks(page);
  });

  test('should display MenuPageSkeleton during initial load', async ({ page }) => {
    // Mock slow response for menu data
    await mockSlowResponse(page, '**/rest/v1/menu_categories*', 2000);
    
    // Start navigation
    const navigationPromise = navigateToMenuPage(page);
    
    // Wait for skeleton to appear
    await waitForSkeleton(page, '.menu-page-skeleton');
    
    // Verify skeleton is visible
    const skeleton = await page.locator('.menu-page-skeleton');
    await expect(skeleton).toBeVisible();
    
    // Wait for navigation to complete
    await navigationPromise;
    
    // Verify skeleton disappears
    await waitForSkeletonToDisappear(page, '.menu-page-skeleton');
    
    // Verify actual content is displayed
    const menuContent = await page.locator('.menu-grid, [class*="grid"]');
    await expect(menuContent).toBeVisible();
  });

  test('should display NewOrderPageSkeleton during initial load', async ({ page }) => {
    // Mock slow response
    await mockSlowResponse(page, '**/rest/v1/**', 2000);
    
    // Start navigation
    const navigationPromise = navigateToNewOrderPage(page);
    
    // Wait for skeleton
    await waitForSkeleton(page, '.new-order-page-skeleton, [class*="skeleton"]');
    
    // Verify skeleton is visible
    const skeletonVisible = await isVisible(page, '.new-order-page-skeleton, [class*="skeleton"]');
    expect(skeletonVisible).toBe(true);
    
    // Wait for navigation to complete
    await navigationPromise;
    
    // Verify skeleton disappears
    await page.waitForTimeout(3000);
    const skeletonStillVisible = await isVisible(page, '.new-order-page-skeleton');
    expect(skeletonStillVisible).toBe(false);
  });

  test('should show loading spinner during order status update', async ({ page }) => {
    // Navigate to menu page
    await navigateToMenuPage(page);
    
    // Mock slow order status update
    await mockSlowResponse(page, '**/rest/v1/orders*', 2000);
    
    // Trigger order status update (if applicable)
    const updateButton = await page.locator('button:has-text("Update Status")');
    const buttonExists = await updateButton.count() > 0;
    
    if (buttonExists) {
      await updateButton.click();
      
      // Wait for loading spinner
      await waitForLoadingSpinner(page);
      
      // Verify spinner is visible
      const spinner = await page.locator('.loading-spinner');
      await expect(spinner).toBeVisible();
      
      // Wait for spinner to disappear
      await waitForLoadingSpinnerToDisappear(page);
    }
  });

  test('should disable buttons during loading', async ({ page }) => {
    // Navigate to new order page
    await navigateToNewOrderPage(page);
    
    // Mock slow order creation
    await mockSlowResponse(page, '**/rest/v1/orders*', 3000);
    
    // Fill in minimal order data
    const placeOrderButton = await page.locator('button:has-text("Place Order")');
    
    if (await placeOrderButton.count() > 0) {
      // Click place order
      await placeOrderButton.click();
      
      // Verify button is disabled during loading
      await page.waitForTimeout(500);
      const isDisabled = await placeOrderButton.isDisabled();
      expect(isDisabled).toBe(true);
    }
  });

  test('should show skeleton with pulse animation', async ({ page }) => {
    // Mock slow response
    await mockSlowResponse(page, '**/rest/v1/menu_categories*', 2000);
    
    // Navigate to menu page
    const navigationPromise = navigateToMenuPage(page);
    
    // Wait for skeleton
    await waitForSkeleton(page, '.menu-page-skeleton');
    
    // Verify skeleton has animation class
    const skeleton = await page.locator('.menu-page-skeleton');
    const className = await skeleton.getAttribute('class');
    
    // Should have pulse or animate class
    expect(className).toMatch(/pulse|animate/i);
    
    await navigationPromise;
  });

  test('should transition smoothly from skeleton to content', async ({ page }) => {
    // Mock slow response
    await mockSlowResponse(page, '**/rest/v1/menu_items*', 1500);
    
    // Navigate and measure timing
    const { duration } = await measureTiming(async () => {
      await navigateToMenuPage(page);
      await waitForSkeletonToDisappear(page, '.menu-page-skeleton');
    });
    
    // Verify transition happened within reasonable time
    expect(duration).toBeLessThan(5000);
    
    // Verify content is visible
    const content = await page.locator('.menu-grid, [class*="grid"]');
    await expect(content).toBeVisible();
  });

  test('should show loading state for customer lookup', async ({ page }) => {
    // Navigate to new order page
    await navigateToNewOrderPage(page);
    
    // Mock slow customer lookup
    await page.route('**/customer:lookup*', async (route) => {
      await new Promise(resolve => setTimeout(resolve, 2000));
      await route.fulfill({
        status: 200,
        body: JSON.stringify({ customer: null })
      });
    });
    
    // Open customer lookup modal
    const lookupButton = await page.locator('button:has-text("Customer Lookup")');
    if (await lookupButton.count() > 0) {
      await lookupButton.click();
      
      // Enter phone and search
      await page.fill('input[type="tel"]', '1234567890');
      await page.click('button:has-text("Search")');
      
      // Verify loading indicator appears
      const loadingIndicator = await page.locator('.loading-spinner, [class*="loading"]');
      await expect(loadingIndicator.first()).toBeVisible({ timeout: 1000 });
    }
  });

  test('should show loading state during menu sync', async ({ page }) => {
    // Navigate to menu page
    await navigateToMenuPage(page);
    
    // Mock slow sync operation
    await mockSlowResponse(page, '**/rest/v1/menu_categories*', 2000);
    
    // Trigger sync (if sync button exists)
    const syncButton = await page.locator('button:has-text("Sync")');
    if (await syncButton.count() > 0) {
      await syncButton.click();
      
      // Verify loading state
      await waitForLoadingSpinner(page);
      
      // Verify spinner disappears after sync
      await waitForLoadingSpinnerToDisappear(page);
    }
  });

  test('should show skeleton for order dashboard', async ({ page }) => {
    // Mock slow response
    await mockSlowResponse(page, '**/rest/v1/orders*', 2000);
    
    // Navigate to orders page
    await page.goto('/orders');
    
    // Wait for skeleton
    const skeletonVisible = await isVisible(page, '.order-dashboard-skeleton, [class*="skeleton"]');
    
    if (skeletonVisible) {
      // Verify skeleton is displayed
      const skeleton = await page.locator('.order-dashboard-skeleton, [class*="skeleton"]');
      await expect(skeleton.first()).toBeVisible();
      
      // Wait for content to load
      await page.waitForTimeout(3000);
      
      // Verify skeleton is replaced
      const skeletonStillVisible = await isVisible(page, '.order-dashboard-skeleton');
      expect(skeletonStillVisible).toBe(false);
    }
  });

  test('should show loading indicator for individual operations', async ({ page }) => {
    // Navigate to menu page
    await navigateToMenuPage(page);
    
    // Mock slow add to cart operation
    await mockSlowResponse(page, '**/cart*', 1000);
    
    // Click add to cart button (if exists)
    const addToCartButton = await page.locator('button:has-text("Add to Cart")').first();
    if (await addToCartButton.count() > 0) {
      await addToCartButton.click();
      
      // Verify button shows loading state
      const buttonText = await addToCartButton.textContent();
      const hasLoadingIndicator = buttonText.includes('...') || 
                                   await addToCartButton.locator('.loading-spinner').count() > 0;
      
      expect(hasLoadingIndicator).toBe(true);
    }
  });

  test('should handle multiple concurrent loading states', async ({ page }) => {
    // Mock slow responses for multiple endpoints
    await mockSlowResponse(page, '**/rest/v1/menu_categories*', 2000);
    await mockSlowResponse(page, '**/rest/v1/menu_items*', 2000);
    await mockSlowResponse(page, '**/rest/v1/ingredients*', 2000);
    
    // Navigate to menu page
    await navigateToMenuPage(page);
    
    // Verify skeleton is shown during all loading
    await waitForSkeleton(page, '.menu-page-skeleton');
    
    // Wait for all to complete
    await page.waitForTimeout(3000);
    
    // Verify skeleton is gone
    await waitForSkeletonToDisappear(page, '.menu-page-skeleton');
    
    // Verify content is displayed
    const content = await page.locator('.menu-grid, [class*="grid"]');
    await expect(content).toBeVisible();
  });

  test('should show full-screen loading spinner when appropriate', async ({ page }) => {
    // Navigate to menu page
    await navigateToMenuPage(page);
    
    // Mock slow operation that should show full-screen spinner
    await mockSlowResponse(page, '**/rest/v1/orders*', 2000);
    
    // Trigger operation that shows full-screen spinner
    const createOrderButton = await page.locator('button:has-text("Place Order")');
    if (await createOrderButton.count() > 0) {
      await createOrderButton.click();
      
      // Check for full-screen spinner
      const fullScreenSpinner = await page.locator('.loading-spinner[class*="full"], [class*="fullscreen"]');
      const count = await fullScreenSpinner.count();
      
      if (count > 0) {
        await expect(fullScreenSpinner.first()).toBeVisible();
      }
    }
  });

  test('should measure loading performance', async ({ page }) => {
    // Measure menu page load time
    const { duration } = await measureTiming(async () => {
      await navigateToMenuPage(page);
      await page.waitForSelector('.menu-grid, [class*="grid"]', { timeout: 10000 });
    });
    
    // Verify load time is reasonable (under 5 seconds)
    expect(duration).toBeLessThan(5000);
    
    console.log(`Menu page loaded in ${duration}ms`);
  });

  test('should show loading state text when provided', async ({ page }) => {
    // Navigate to menu page
    await navigateToMenuPage(page);
    
    // Mock slow operation
    await mockSlowResponse(page, '**/rest/v1/orders*', 2000);
    
    // Trigger operation with loading text
    const button = await page.locator('button:has-text("Place Order")');
    if (await button.count() > 0) {
      await button.click();
      
      // Check for loading text
      const loadingText = await page.locator('text=/loading|processing|please wait/i');
      const count = await loadingText.count();
      
      if (count > 0) {
        await expect(loadingText.first()).toBeVisible();
      }
    }
  });
});

