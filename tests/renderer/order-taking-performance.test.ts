import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const projectRoot = process.cwd();
const menuModalPath = path.join(
  projectRoot,
  'src',
  'renderer',
  'components',
  'modals',
  'MenuModal.tsx',
);
const menuItemGridPath = path.join(
  projectRoot,
  'src',
  'renderer',
  'components',
  'menu',
  'MenuItemGrid.tsx',
);
const glassStylesPath = path.join(
  projectRoot,
  'src',
  'renderer',
  'styles',
  'glassmorphism.css',
);

test('order-taking shares one menu catalog snapshot between category tabs and item grid', () => {
  const modalSource = readFileSync(menuModalPath, 'utf8');
  const gridSource = readFileSync(menuItemGridPath, 'utf8');

  assert.match(modalSource, /menuItems=\{menuItemsForCategoryTabs\}/);
  assert.match(modalSource, /loading=\{isMenuCatalogLoading\}/);
  assert.match(gridSource, /menuItems:\s*MenuItem\[\]/);
  assert.doesNotMatch(gridSource, /menuService\.getMenuItems(?:ByCategory)?\(/);
});

test('category switches and menu search derive locally without showing a new loading skeleton', () => {
  const gridSource = readFileSync(menuItemGridPath, 'utf8');

  assert.match(gridSource, /const visibleMenuItems = useMemo\(\(\) =>/);
  assert.match(gridSource, /const seenItemIds = new Set<string>\(\)/);
  assert.match(gridSource, /const normalizedSearchQuery = searchQuery\.trim\(\)\.toLocaleLowerCase\(\)/);
  assert.match(gridSource, /visibleMenuItems\.map\(\(item\) =>/);
  assert.match(
    gridSource,
    /featuredRankedIds\.length > 0[\s\S]*?Array\.from\(topSellerIds \?\? \[\]\)/,
    'legacy callers that only provide topSellerIds keep their ranked Featured fallback',
  );
});

test('the shared catalog snapshot refreshes in the background after native menu sync events', () => {
  const modalSource = readFileSync(menuModalPath, 'utf8');

  assert.match(modalSource, /menuService\.clearCacheEntry\('menu_items'\)/);
  assert.match(modalSource, /onEvent\('menu:sync', handleMenuCatalogRefresh\)/);
  assert.match(modalSource, /offEvent\('menu:sync', handleMenuCatalogRefresh\)/);
  assert.match(
    modalSource,
    /menuService\.getLoadingStatus\(\)\.menuItems === 'error'[\s\S]*?setMenuCatalogError/,
    'an IPC failure that resolves to an empty array must surface the error state',
  );
});

test('order-flow modals use a short enter and exit motion budget', () => {
  const styles = readFileSync(glassStylesPath, 'utf8');

  assert.match(styles, /animation:\s*backdropEnter 180ms/);
  assert.match(styles, /animation:\s*liquidModalEnter 180ms/);
  assert.match(styles, /\.liquid-glass-modal-shell\.leaving\s*\{[^}]*liquidModalExit 180ms/s);
  assert.match(styles, /\.liquid-glass-modal-backdrop\.leaving\s*\{[^}]*backdropExit 180ms/s);
});
