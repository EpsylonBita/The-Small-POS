# POS System Menu Functionality - Playwright Test Documentation

## Overview
This document provides comprehensive documentation for the Playwright browser automation tests covering the POS system menu functionality.

## Test Suite: Menu Functionality

### Test Environment
- **Base URL**: http://localhost:3000
- **Browsers Tested**: Chromium, Firefox, WebKit
- **Mobile Devices**: Pixel 5, iPhone 12
- **Tablet Devices**: iPad Pro
- **Timeout**: 60 seconds per test
- **Retries**: 2 on CI, 0 locally

### Test Categories

#### 1. Menu Category Loading
**Purpose**: Verify that menu categories load correctly from the database
**Expected Behavior**:
- Categories should load within 30 seconds
- Should display at least 1 category (database has 12)
- Category names should be visible and non-empty
- Categories should be clickable

**Test Steps**:
1. Navigate to menu page
2. Wait for categories to load
3. Verify category count > 0
4. Validate category text content
5. Confirm categories are interactive

#### 2. Menu Item Display
**Purpose**: Ensure menu items display correctly when a category is selected
**Expected Behavior**:
- Items should load when category is clicked
- Each item should have name and price
- Price should be in Euro format (€X.XX)
- Items should be clickable

**Test Steps**:
1. Navigate to menu page
2. Click first category
3. Wait for items to load
4. Verify item structure (name, price)
5. Validate price format

#### 3. Item Selection & Modal
**Purpose**: Test menu item selection and modal functionality
**Expected Behavior**:
- Clicking item opens modal
- Modal shows item details
- Quantity controls are present
- Add to cart button is visible
- Modal can be closed

**Test Steps**:
1. Select category and item
2. Click menu item
3. Verify modal opens
4. Check modal content
5. Test modal closure

#### 4. Network Error Handling
**Purpose**: Verify graceful handling of network failures
**Expected Behavior**:
- Network failures should not crash the app
- Error messages or fallback content should appear
- User should be informed of the issue

**Test Steps**:
1. Intercept and fail network requests
2. Navigate to menu page
3. Verify error handling
4. Check for user feedback

#### 5. Loading States
**Purpose**: Ensure appropriate loading indicators are shown
**Expected Behavior**:
- Loading spinner appears during data fetch
- Loading state disappears when data loads
- User is aware of loading progress

**Test Steps**:
1. Slow down network requests
2. Navigate to menu page
3. Verify loading indicator appears
4. Confirm loading indicator disappears

#### 6. Responsive Design
**Purpose**: Test menu functionality across different screen sizes
**Expected Behavior**:
- Menu works on mobile (375px width)
- Menu works on tablet (768px width)
- Menu works on desktop (1920px width)
- Categories remain accessible on all sizes

**Test Steps**:
1. Test mobile viewport
2. Test tablet viewport
3. Test desktop viewport
4. Verify functionality on each

#### 7. Real-time Updates
**Purpose**: Verify the system handles real-time data updates
**Expected Behavior**:
- Menu data refreshes appropriately
- Categories remain consistent
- No data corruption occurs

**Test Steps**:
1. Load initial menu data
2. Trigger refresh/update
3. Verify data consistency
4. Check for proper updates

#### 8. Performance Testing
**Purpose**: Ensure menu functionality performs well under normal load
**Expected Behavior**:
- Category loading < 3 seconds
- Category switching < 3 seconds
- No significant performance degradation

**Test Steps**:
1. Measure category load time
2. Test rapid category switching
3. Verify performance metrics
4. Check for memory leaks

## Test Data Requirements

### Database State
- Minimum 1 menu category (actual: 12)
- Categories should have `is_active = true`
- Categories should have valid `display_order`
- Menu items should exist for at least one category

### Test Selectors
The tests rely on specific `data-testid` attributes:
- `menu-tab`: Main menu navigation
- `menu-categories`: Category container
- `category-tab`: Individual category buttons
- `menu-items-grid`: Items container
- `menu-item`: Individual menu items
- `item-name`: Item name display
- `item-price`: Item price display
- `menu-item-modal`: Item detail modal
- `modal-title`: Modal title
- `quantity-decrease/increase`: Quantity controls
- `add-to-cart`: Add to cart button
- `close-modal`: Modal close button
- `loading-spinner`: Loading indicator
- `error-message`: Error display
- `fallback-categories`: Fallback content

## Performance Benchmarks

### Expected Performance Metrics
- **Category Load Time**: < 3 seconds
- **Item Load Time**: < 2 seconds
- **Modal Open Time**: < 500ms
- **Category Switch Time**: < 1 second

### Performance Monitoring
Tests automatically measure and report:
- Page load times
- Category switching performance
- Modal interaction speed
- Network request duration

## Error Scenarios Tested

### Network Failures
- Complete network failure
- Slow network responses
- Partial data loading failures
- Authentication errors

### Data Issues
- Empty category responses
- Malformed item data
- Missing required fields
- Invalid price formats

### UI Failures
- Modal rendering issues
- Category display problems
- Responsive layout failures
- Loading state problems

## Test Reporting

### Generated Reports
- **HTML Report**: Visual test results with screenshots
- **JSON Report**: Machine-readable test data
- **JUnit XML**: CI/CD integration format
- **Summary Report**: High-level test metrics

### Artifacts Collected
- Screenshots on failure
- Video recordings on failure
- Network traces on retry
- Performance metrics
- Console logs

## Maintenance Guidelines

### Adding New Tests
1. Follow existing naming conventions
2. Use appropriate `data-testid` selectors
3. Include performance measurements
4. Add error scenario coverage
5. Update this documentation

### Updating Selectors
1. Coordinate with development team
2. Update all affected tests
3. Verify cross-browser compatibility
4. Test on all supported devices

### Performance Thresholds
Review and update performance expectations:
- Monitor actual performance metrics
- Adjust thresholds based on real usage
- Consider hardware variations
- Account for network conditions

## Troubleshooting

### Common Issues
1. **Test Timeouts**: Increase timeout values or optimize queries
2. **Selector Failures**: Verify `data-testid` attributes exist
3. **Network Issues**: Check development server status
4. **Performance Failures**: Review database query efficiency

### Debug Mode
Run tests with additional debugging:
```bash
npx playwright test --debug
npx playwright test --headed
npx playwright test --trace on
```

## Integration with CI/CD

### Prerequisites
- Node.js environment
- Playwright browsers installed
- Development server running
- Database with test data

### CI Configuration
```yaml
- name: Install Playwright
  run: npx playwright install
- name: Run tests
  run: npx playwright test
- name: Upload results
  uses: actions/upload-artifact@v3
  with:
    name: playwright-report
    path: test-results/
```
