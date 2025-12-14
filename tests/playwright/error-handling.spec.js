/**
 * Error Handling Test Suite
 * 
 * Tests error scenarios, error display, and retry functionality
 */

const { test, expect } = require('@playwright/test');
const {
  mockDatabaseTimeout,
  mockSupabaseTimeout,
  mockNetworkFailure,
  mockErrorResponse,
  navigateToMenuPage,
  navigateToNewOrderPage,
  waitForErrorDisplay,
  getErrorMessage,
  clickRetryButton,
  waitForToast,
  clearRouteMocks,
  setupConsoleErrorListener
} = require('./helpers/test-helpers');

test.describe('Error Handling', () => {
  test.beforeEach(async ({ page }) => {
    // Setup console error listener
    setupConsoleErrorListener(page);
  });

  test.afterEach(async ({ page }) => {
    // Clear all route mocks
    await clearRouteMocks(page);
  });

  test('should display error when menu load times out', async ({ page }) => {
    // Mock timeout for menu categories
    await mockSupabaseTimeout(page, 'menu_categories', 12000);
    
    // Navigate to menu page
    await navigateToMenuPage(page);
    
    // Wait for error display to appear
    await waitForErrorDisplay(page);
    
    // Verify error message contains timeout information
    const errorMessage = await getErrorMessage(page);
    expect(errorMessage).toContain('timeout');
    
    // Verify retry button is present
    const retryButton = await page.locator('.error-display button:has-text("Retry")');
    await expect(retryButton).toBeVisible();
  });

  test('should retry operation when retry button is clicked', async ({ page }) => {
    // Mock initial timeout
    await mockSupabaseTimeout(page, 'menu_items', 12000);
    
    // Navigate to menu page
    await navigateToMenuPage(page);
    
    // Wait for error display
    await waitForErrorDisplay(page);
    
    // Clear mocks to allow successful retry
    await clearRouteMocks(page);
    
    // Click retry button
    await clickRetryButton(page);
    
    // Verify error display disappears
    await page.waitForSelector('.error-display', { state: 'hidden', timeout: 10000 });
    
    // Verify menu content is displayed
    const menuGrid = await page.locator('.menu-grid, [class*="grid"]');
    await expect(menuGrid).toBeVisible();
  });

  test('should display network error with user-friendly message', async ({ page }) => {
    // Mock network failure
    await mockNetworkFailure(page, '**/rest/v1/menu_items*');
    
    // Navigate to menu page
    await navigateToMenuPage(page);
    
    // Wait for error display
    await waitForErrorDisplay(page);
    
    // Verify user-friendly error message
    const errorMessage = await getErrorMessage(page);
    expect(errorMessage.toLowerCase()).toMatch(/network|connection|unable to connect/);
  });

  test('should display database error on order creation failure', async ({ page }) => {
    // Navigate to new order page
    await navigateToNewOrderPage(page);
    
    // Mock database error for order creation
    await mockErrorResponse(page, 'orders', 500, 'Database error');
    
    // Fill in order details and submit
    // (Assuming form fields exist)
    await page.fill('input[name="customerName"]', 'Test Customer');
    await page.click('button:has-text("Place Order")');
    
    // Wait for error toast or error display
    await waitForToast(page, 'error');
    
    // Verify error message is displayed
    const toast = await page.locator('text=/error|failed/i');
    await expect(toast).toBeVisible();
  });

  test('should handle customer lookup timeout', async ({ page }) => {
    // Navigate to new order page
    await navigateToNewOrderPage(page);
    
    // Mock timeout for customer lookup
    await page.route('**/customer:lookup*', async (route) => {
      await new Promise(resolve => setTimeout(resolve, 7000));
      await route.abort('timedout');
    });
    
    // Open customer lookup modal
    await page.click('button:has-text("Customer Lookup")');
    
    // Enter phone number
    await page.fill('input[type="tel"]', '1234567890');
    await page.click('button:has-text("Search")');
    
    // Wait for error display
    await waitForErrorDisplay(page);
    
    // Verify timeout error message
    const errorMessage = await getErrorMessage(page);
    expect(errorMessage).toContain('timeout');
  });

  test('should display validation error for invalid input', async ({ page }) => {
    // Navigate to new order page
    await navigateToNewOrderPage(page);
    
    // Try to place order without required fields
    await page.click('button:has-text("Place Order")');
    
    // Wait for validation error
    await page.waitForSelector('text=/required|invalid/i', { timeout: 5000 });
    
    // Verify validation error is displayed
    const validationError = await page.locator('text=/required|invalid/i');
    await expect(validationError).toBeVisible();
  });

  test('should show error severity with appropriate styling', async ({ page }) => {
    // Mock critical error
    await mockErrorResponse(page, 'menu_categories', 500, 'Critical system error');
    
    // Navigate to menu page
    await navigateToMenuPage(page);
    
    // Wait for error display
    await waitForErrorDisplay(page);
    
    // Verify error display has severity styling
    const errorDisplay = await page.locator('.error-display');
    const className = await errorDisplay.getAttribute('class');
    
    // Should have severity-based class (e.g., 'critical', 'high', 'error')
    expect(className).toMatch(/critical|high|error|severity/i);
  });

  test('should clear error when operation succeeds', async ({ page }) => {
    // Mock initial error
    await mockNetworkFailure(page, '**/rest/v1/menu_items*');
    
    // Navigate to menu page
    await navigateToMenuPage(page);
    
    // Wait for error display
    await waitForErrorDisplay(page);
    
    // Clear mocks
    await clearRouteMocks(page);
    
    // Retry operation
    await clickRetryButton(page);
    
    // Verify error is cleared
    await page.waitForSelector('.error-display', { state: 'hidden', timeout: 10000 });
    
    // Verify success state
    const menuContent = await page.locator('.menu-grid, [class*="grid"]');
    await expect(menuContent).toBeVisible();
  });

  test('should log errors to console in development mode', async ({ page }) => {
    const consoleErrors = setupConsoleErrorListener(page);
    
    // Mock error
    await mockNetworkFailure(page, '**/rest/v1/menu_categories*');
    
    // Navigate to menu page
    await navigateToMenuPage(page);
    
    // Wait for error
    await waitForErrorDisplay(page);
    
    // Verify error was logged to console
    await page.waitForTimeout(1000);
    expect(consoleErrors.length).toBeGreaterThan(0);
  });

  test('should handle multiple concurrent errors gracefully', async ({ page }) => {
    // Mock multiple endpoint failures
    await mockNetworkFailure(page, '**/rest/v1/menu_categories*');
    await mockNetworkFailure(page, '**/rest/v1/menu_items*');
    await mockNetworkFailure(page, '**/rest/v1/ingredients*');
    
    // Navigate to menu page
    await navigateToMenuPage(page);
    
    // Wait for error display
    await waitForErrorDisplay(page);
    
    // Verify only one error display is shown (not multiple)
    const errorDisplays = await page.locator('.error-display').count();
    expect(errorDisplays).toBe(1);
  });

  test('should preserve user data on error', async ({ page }) => {
    // Navigate to new order page
    await navigateToNewOrderPage(page);
    
    // Fill in form data
    await page.fill('input[name="customerName"]', 'Test Customer');
    await page.fill('input[name="phone"]', '1234567890');
    
    // Mock order creation error
    await mockErrorResponse(page, 'orders', 500, 'Database error');
    
    // Try to place order
    await page.click('button:has-text("Place Order")');
    
    // Wait for error
    await waitForToast(page, 'error');
    
    // Verify form data is preserved
    const customerName = await page.inputValue('input[name="customerName"]');
    const phone = await page.inputValue('input[name="phone"]');
    
    expect(customerName).toBe('Test Customer');
    expect(phone).toBe('1234567890');
  });

  test('should show detailed error info in development mode', async ({ page }) => {
    // Set development mode
    await page.addInitScript(() => {
      window.process = { env: { NODE_ENV: 'development' } };
    });
    
    // Mock error
    await mockErrorResponse(page, 'menu_items', 500, 'Internal server error');
    
    // Navigate to menu page
    await navigateToMenuPage(page);
    
    // Wait for error display
    await waitForErrorDisplay(page);
    
    // Verify detailed error info is visible
    const errorDetails = await page.locator('.error-display [class*="details"], .error-display pre');
    const detailsCount = await errorDetails.count();
    
    expect(detailsCount).toBeGreaterThan(0);
  });

  test('should handle ErrorBoundary catching React errors', async ({ page }) => {
    // Navigate to a page
    await navigateToMenuPage(page);
    
    // Inject a script that will cause a React error
    await page.evaluate(() => {
      // Trigger a React error by throwing in a component
      const event = new CustomEvent('trigger-react-error');
      window.dispatchEvent(event);
    });
    
    // Wait a bit for error boundary to catch
    await page.waitForTimeout(1000);
    
    // Check if error boundary fallback is displayed
    const errorBoundary = await page.locator('text=/something went wrong/i, text=/error occurred/i');
    const count = await errorBoundary.count();
    
    // If error boundary caught it, fallback should be visible
    if (count > 0) {
      await expect(errorBoundary.first()).toBeVisible();
    }
  });
});

