import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const projectRoot = process.cwd();
const tabsPath = path.join(projectRoot, 'src', 'renderer', 'components', 'menu', 'MenuCategoryTabs.tsx');
const itemCardPath = path.join(projectRoot, 'src', 'renderer', 'components', 'menu', 'MenuItemCard.tsx');
const itemGridPath = path.join(projectRoot, 'src', 'renderer', 'components', 'menu', 'MenuItemGrid.tsx');
const itemModalPath = path.join(projectRoot, 'src', 'renderer', 'components', 'menu', 'MenuItemModal.tsx');
const cartPath = path.join(projectRoot, 'src', 'renderer', 'components', 'menu', 'MenuCart.tsx');
const menuPagePath = path.join(projectRoot, 'src', 'renderer', 'pages', 'MenuPage.tsx');
const menuModalPath = path.join(projectRoot, 'src', 'renderer', 'components', 'modals', 'MenuModal.tsx');
const enLocalePath = path.join(projectRoot, 'src', 'locales', 'en.json');

test('MenuCategoryTabs only renders flavor filters backed by real category items', () => {
  const source = readFileSync(tabsPath, 'utf8');

  assert.match(source, /menuItems = \[\]/);
  assert.match(source, /hasSavoryItems/);
  assert.match(source, /hasSweetItems/);
  assert.match(source, /normalizeFlavorType\(item\.flavor_type \?\? item\.flavorType\)/);
  assert.match(source, /onSubcategoryChange\(subcategories\[0\]\?\.id \?\? ''\)/);
  assert.doesNotMatch(source, /return\s*\[\s*\{\s*id:\s*`\$\{categoryId\}-savory`[\s\S]*\{\s*id:\s*`\$\{categoryId\}-sweet`/);
});

test('menu views pass real item data into flavor tabs and filter by flavor_type', () => {
  const pageSource = readFileSync(menuPagePath, 'utf8');
  const modalSource = readFileSync(menuModalPath, 'utf8');

  assert.match(pageSource, /menuItems=\{menuItems\}/);
  assert.match(pageSource, /item\.flavor_type === targetFlavorType/);
  assert.match(modalSource, /menuItemsForCategoryTabs/);
  assert.match(modalSource, /menuItems=\{menuItemsForCategoryTabs\}/);
});

test('flavor tab copy and selected styling avoid clipped glow artifacts', () => {
  const tabsSource = readFileSync(tabsPath, 'utf8');
  const itemModalSource = readFileSync(itemModalPath, 'utf8');
  const enLocale = JSON.parse(readFileSync(enLocalePath, 'utf8'));

  assert.equal(enLocale.menu.categories.savory, 'Savoury');
  assert.equal(enLocale.menu.itemModal.savory, 'Savoury');
  assert.match(tabsSource, /border-yellow-300\/55 bg-yellow-400 text-black/);
  assert.match(tabsSource, /border-yellow-500\/60 bg-yellow-400 text-black/);
  assert.doesNotMatch(tabsSource, /border-blue-300\/45 bg-blue-500\/85 text-white/);
  assert.doesNotMatch(tabsSource, /border-blue-400\/50 bg-blue-500 text-white/);
  assert.match(tabsSource, /bg-emerald-500\/75/);
  assert.match(tabsSource, /border-b border-gray-200\/20 pb-1/);
  assert.match(tabsSource, /relative px-2 py-3 sm:px-3 sm:py-4/);
  assert.match(tabsSource, /cursor-grab select-none touch-pan-x py-1\.5/);
  assert.match(tabsSource, /px-2 pb-4 pt-1 sm:px-4 sm:pb-5/);
  assert.match(tabsSource, /overflow-x-auto scrollbar-hide touch-pan-x py-1\.5/);
  assert.doesNotMatch(tabsSource, /from-emerald-500\/95/);
  assert.doesNotMatch(tabsSource, /shadow-\[0_10px_28px/);
  assert.match(itemModalSource, /flavorFilterButtonBaseClass/);
  assert.match(itemModalSource, /inline-flex h-12 min-w-\[7rem\] items-center justify-center rounded-full border px-5/);
  assert.match(itemModalSource, /border-orange-400\/70 bg-orange-500/);
  assert.match(itemModalSource, /border-pink-400\/70 bg-pink-500/);
  assert.match(itemModalSource, /overflow-x-auto overflow-y-hidden scrollbar-hide touch-pan-x/);
  assert.match(itemModalSource, /<Minus className="w-5 h-5" strokeWidth=\{3\}/);
  assert.doesNotMatch(itemModalSource, /activeFlavorType === 'savory'[\s\S]{0,160}liquid-glass-modal-button/);
  assert.doesNotMatch(itemModalSource, /activeFlavorType === 'sweet'[\s\S]{0,160}liquid-glass-modal-button/);
  assert.doesNotMatch(itemModalSource, /overflow-x-auto overflow-y-hidden pos-scrollbar-glass/);
});

test('menu modal cards and cart keep the compact glass layout', () => {
  const cardSource = readFileSync(itemCardPath, 'utf8');
  const gridSource = readFileSync(itemGridPath, 'utf8');
  const cartSource = readFileSync(cartPath, 'utf8');
  const modalSource = readFileSync(menuModalPath, 'utf8');

  assert.match(cardSource, /text-yellow-300/);
  assert.match(cardSource, /text-yellow-800/);
  assert.match(cardSource, /text-emerald-800/);
  assert.match(cardSource, /bg-white border-slate-300\/80/);
  assert.match(cardSource, /bg-amber-100\/95/);
  assert.match(cardSource, /Settings2/);
  assert.doesNotMatch(cardSource, /hover:-translate-y/);
  assert.doesNotMatch(cardSource, /hover:scale/);
  assert.doesNotMatch(cardSource, /hover:bg-white/);
  assert.match(cardSource, /mt-auto flex justify-end/);
  assert.doesNotMatch(cardSource, /menu\.item\.pickup/);
  assert.doesNotMatch(cardSource, /menu\.item\.delivery/);

  assert.match(gridSource, /2xl:grid-cols-6/);
  assert.match(gridSource, /p-2 sm:p-3/);
  assert.match(gridSource, /gap-2\.5 sm:gap-3/);

  assert.match(modalSource, /md:w-\[19rem\]/);
  assert.match(modalSource, /bg-transparent py-2 pl-3 pr-2/);
  assert.match(modalSource, /overflow-visible bg-transparent/);
  assert.match(modalSource, /bg-transparent/);
  assert.doesNotMatch(modalSource, /rounded-\[26px\] border border-white\/22/);
  assert.doesNotMatch(modalSource, /shadow-\[0_18px_42px_rgba\(0,0,0,0\.22\)\]/);
  assert.doesNotMatch(modalSource, /bg-white\/\[0\.025\]/);
  assert.doesNotMatch(modalSource, /backdrop-blur-2xl/);
  assert.match(cartSource, /rounded-\[28px\] border border-black\/15 bg-transparent/);
  assert.match(cartSource, /dark:border-white\/60/);
  assert.match(cartSource, /shadow-\[0_10px_28px_rgba\(15,23,42,0\.06\)\]/);
  assert.match(cartSource, /overflow-y-auto p-3 touch-scroll scrollbar-hide/);
  assert.doesNotMatch(cartSource, /overflow-y-auto p-3 touch-scroll pos-scrollbar-glass/);
  assert.match(cartSource, /bg-transparent space-y-3/);
  assert.match(cartSource, /bg-transparent border-0 p-0 shadow-none/);
  assert.match(cartSource, /<Ticket className="h-8 w-8 flex-shrink-0"/);
  assert.match(cartSource, /<Award className="h-8 w-8 flex-shrink-0"/);
  assert.match(cartSource, /<Percent className="h-8 w-8 flex-shrink-0"/);
  assert.doesNotMatch(cartSource, /border-sky-500\/35 bg-sky-500\/12/);
  assert.doesNotMatch(cartSource, /<Gift className="w-5 h-5 flex-shrink-0"/);
  assert.match(cartSource, /bg-yellow-400 text-black hover:bg-yellow-300/);
  assert.doesNotMatch(cartSource, /: 'bg-blue-600 text-white hover:bg-blue-700 hover:scale-\[1\.02\]'/);
});

test('menu modal keeps search in the title bar and cards expose hold preview details', () => {
  const cardSource = readFileSync(itemCardPath, 'utf8');
  const gridSource = readFileSync(itemGridPath, 'utf8');
  const modalSource = readFileSync(menuModalPath, 'utf8');

  assert.match(modalSource, /liquid-glass-modal-title text-xl flex-shrink-0/);
  assert.match(modalSource, /ref=\{menuSearchRef\}/);
  assert.match(modalSource, /min-w-\[14rem\] max-w-2xl flex-1/);
  assert.match(modalSource, /focus:border-yellow-400\/70 focus:outline-none focus:ring-1 focus:ring-yellow-400/);
  assert.match(modalSource, /border border-blue-500\/40 bg-transparent px-3 py-1\.5 text-sm text-white/);
  assert.match(modalSource, /<User className="w-3\.5 h-3\.5 text-blue-400" \/>/);
  assert.doesNotMatch(modalSource, /bg-blue-500\/20 text-blue-300 border border-blue-500\/30/);
  assert.doesNotMatch(modalSource, /focus:ring-blue-400/);
  assert.doesNotMatch(modalSource, /\/\* Search bar \*\//);

  assert.match(cardSource, /holdTimerRef/);
  assert.match(cardSource, /suppressNextClickRef/);
  assert.match(cardSource, /onPreview\?\.\(item,\s*cardRef\.current\.getBoundingClientRect\(\)\)/);
  assert.doesNotMatch(cardSource, /absolute inset-0 z-20/);

  assert.match(gridSource, /createPortal/);
  assert.match(gridSource, /MenuItemPreviewState/);
  assert.match(gridSource, /fixed inset-0 z-\[2147483001\]/);
  assert.match(gridSource, /setPreview\(\{ item: previewItem, anchorRect \}\)/);
  assert.match(gridSource, /menu\.cart\.ingredients/);
  assert.match(gridSource, /ingredients: item\.ingredients \|\| null/);
});

test('menu modal edit mode formats order numbers and flattens kiosk customizations', () => {
  const modalSource = readFileSync(menuModalPath, 'utf8');

  assert.match(modalSource, /formatCompactOrderNumberForDisplay\(editOrderNumber\)/);
  assert.doesNotMatch(modalSource, /#\$\{editOrderNumber\}/);
  assert.match(modalSource, /parsed\.added/);
  assert.match(modalSource, /parsed\.groups/);
  assert.match(modalSource, /JSON\.parse\(trimmed\)/);
  assert.match(modalSource, /Promise\.allSettled/);
  assert.match(modalSource, /menuService\.getIngredients\(\)/);
  assert.match(modalSource, /menuService\.getMenuItems\(\)/);
  assert.match(modalSource, /menuService\.getMenuCategories\(\)/);
  assert.match(modalSource, /buildMenuItemLookup/);
  assert.match(modalSource, /catalogMenuItem\?\.categoryName/);
  assert.match(modalSource, /item\.selectedIngredients/);
  assert.match(modalSource, /item\.modifiers/);
  assert.match(modalSource, /item\.ingredients/);
  assert.match(modalSource, /resolveCustomizationIngredient\(c, ingredientLookup\)/);
});
