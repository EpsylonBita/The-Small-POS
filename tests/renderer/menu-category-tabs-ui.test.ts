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
const contextChipPath = path.join(projectRoot, 'src', 'renderer', 'components', 'menu', 'OrderContextChip.tsx');
const contextChipCssPath = path.join(projectRoot, 'src', 'renderer', 'components', 'menu', 'order-context-chip.css');
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

test('MenuCategoryTabs does not fade the trailing edge of category labels', () => {
  const source = readFileSync(tabsPath, 'utf8');

  // A permanent right-edge mask made the final pill label (e.g. "Room Service") read as clipped. Founder 01/11:
  // the rows are kit scroll rows — an edge fades only while there is more to see that way (utils/scroll-rows.ts),
  // so the last label shows in full at the end, and a mouse drag moves the row.
  assert.doesNotMatch(source, /showRightFade|showLeftFade|handleMouseDown/);
  assert.match(source, /<div className="pos-scroll-row max-w-full select-none gap-1 sm:gap-1\.5" data-testid="menu-categories">/);
  // Pills must not shrink or wrap, and the tighter padding keeps standard categories visible.
  assert.match(source, /min-h-\[38px\] shrink-0 whitespace-nowrap rounded-xl border px-3 py-2 text-\[13px\]/);
});

test('menu views pass real item data into flavor tabs and filter by flavor_type', () => {
  const pageSource = readFileSync(menuPagePath, 'utf8');
  const modalSource = readFileSync(menuModalPath, 'utf8');

  assert.match(pageSource, /menuItems=\{menuItems\}/);
  assert.match(pageSource, /item\.flavor_type === targetFlavorType/);
  assert.match(modalSource, /menuItemsForCategoryTabs/);
  assert.match(modalSource, /menuItems=\{menuItemsForCategoryTabs\}/);
});

test('MenuPage keeps category icons source-safe and uses touch-first page controls', () => {
  const pageSource = readFileSync(menuPagePath, 'utf8');

  assert.match(pageSource, /'crepes': '\\u\{1F95E\}'/);
  assert.match(pageSource, /'waffles': '\\u\{1F9C7\}'/);
  assert.match(pageSource, /icon: "\\u\{1F37D\}\\uFE0F"/);
  assert.match(pageSource, /icon: "\\u2B50"/);
  assert.doesNotMatch(pageSource, /[Ââð�]/);
  assert.doesNotMatch(pageSource, /hover:/);
  assert.doesNotMatch(pageSource, /bg-blue-|text-blue-|border-blue-/);
  assert.doesNotMatch(pageSource, /rounded-lg|rounded-md/);
  assert.match(pageSource, /rounded-2xl shadow-lg overflow-hidden/);
  assert.match(pageSource, /active:scale-\[0\.98\]/);
  assert.match(pageSource, /bg-\(--pos-s-surface-2\) text-yellow-900/);
  assert.match(pageSource, /bg-black text-white/);
});

test('MenuModal uses existing translation keys for dine-in title and search placeholder', () => {
  const modalSource = readFileSync(menuModalPath, 'utf8');

  assert.match(modalSource, /t\('orders\.type\.dineIn', \{ defaultValue: 'Dine In' \}\)/);
  assert.match(modalSource, /placeholder=\{salonMode \? t\('salonSale\.search'\) : t\('menu\.search', \{ defaultValue: 'Search menu items\.\.\.' \}\)\}/);
  assert.doesNotMatch(modalSource, /orders\.type\.dine_in/);
  assert.doesNotMatch(modalSource, /menu\.search\.placeholder/);
});

test('flavor tab copy and selected styling avoid clipped glow artifacts', () => {
  const tabsSource = readFileSync(tabsPath, 'utf8');
  const itemModalSource = readFileSync(itemModalPath, 'utf8');
  const enLocale = JSON.parse(readFileSync(enLocalePath, 'utf8'));

  assert.equal(enLocale.menu.categories.savory, 'Savoury');
  assert.equal(enLocale.menu.itemModal.savory, 'Savoury');
  // Wave ΣΤ8: the selected tab is the kit selection (dark in light, white in dark), not yellow.
  assert.match(tabsSource, /border-\(--pos-s-sel-bg\) bg-\(--pos-s-sel-bg\) text-\(--pos-s-sel-fg\)/);
  assert.doesNotMatch(tabsSource, /bg-yellow-400 text-black/);
  assert.doesNotMatch(tabsSource, /border-blue-300\/45 bg-blue-500\/85 text-white/);
  assert.doesNotMatch(tabsSource, /border-blue-400\/50 bg-blue-500 text-white/);
  // Round 251: guard that the old emerald selected glow stays gone.
  assert.doesNotMatch(tabsSource, /bg-emerald-500\/75/);
  assert.match(tabsSource, /border-b border-gray-200\/20 pb-1/);
  assert.match(tabsSource, /relative px-2 py-3 sm:px-3 sm:py-4/);
  assert.match(tabsSource, /pos-scroll-row max-w-full select-none/);
  assert.match(tabsSource, /px-2 pb-4 pt-1 sm:px-4 sm:pb-5/);
  assert.match(tabsSource, /<div className="pos-scroll-row gap-2" data-testid="menu-subcategories">/);
  assert.doesNotMatch(tabsSource, /from-emerald-500\/95/);
  assert.doesNotMatch(tabsSource, /shadow-\[0_10px_28px/);
  // Founder 01/11/2026 (proposal A): flavour and mode are the kit's segmented controls, the chosen segment in the
  // selection yellow; no orange, slate or pink fills.
  // The yellow slides to the new choice (founder 01/11/2026), as the order tabs' indicator; the press still selects.
  assert.match(itemModalSource, /layoutId=\{`ingredients-\$\{group\}-indicator`\}/);
  assert.match(itemModalSource, /transition=\{\{ duration: 0\.18, ease: \[0\.2, 0\.8, 0\.2, 1\] \}\}\s*className="absolute inset-0 rounded-full bg-\(--pos-s-sel-bg\) shadow-\(--pos-s-depth-yellow\)"/);
  assert.match(itemModalSource, /\{activeFlavorType === 'savory' && segmentIndicator\('flavor'\)\}/);
  assert.match(itemModalSource, /\{ingredientMode === 'without' && segmentIndicator\('mode'\)\}/);
  assert.match(itemModalSource, /aria-pressed=\{activeFlavorType === 'savory'\}[\s\S]{0,120}className=\{segmentClass\(activeFlavorType === 'savory'\)\}/);
  assert.match(itemModalSource, /aria-pressed=\{activeFlavorType === 'sweet'\}[\s\S]{0,120}className=\{segmentClass\(activeFlavorType === 'sweet'\)\}/);
  assert.doesNotMatch(itemModalSource, /border-orange-600 bg-orange-500|border-slate-300\/70 bg-slate-500|border-pink-400\/70 bg-pink-500/);
  // Founder 01/11/2026: the chosen ingredients wrap in a grid of plain rows, every one in view; no sideways strip,
  // and the list grows with the choice (no inner scroll). Ingredients are unlimited: no cap, no «n / max».
  assert.match(itemModalSource, /<ul className="mt-1 grid grid-cols-2 gap-x-4 sm:grid-cols-3 lg:grid-cols-4">/);
  assert.doesNotMatch(itemModalSource, /overflow-x-auto overflow-y-hidden scrollbar-hide touch-pan-x/);
  assert.doesNotMatch(itemModalSource, /menu\.validation\.maxIngredients|selectedOfMax|selectedIngredients\.length >= menuItem\.max_ingredients/);
  assert.match(itemModalSource, /<Minus className="h-5 w-5" strokeWidth=\{3\.5\}/);
  assert.doesNotMatch(itemModalSource, /activeFlavorType === 'savory'[\s\S]{0,160}liquid-glass-modal-button/);
  assert.doesNotMatch(itemModalSource, /activeFlavorType === 'sweet'[\s\S]{0,160}liquid-glass-modal-button/);
  assert.doesNotMatch(itemModalSource, /overflow-x-auto overflow-y-hidden pos-scrollbar-glass/);
});

test('menu modal cards and cart keep the compact glass layout', () => {
  const cardSource = readFileSync(itemCardPath, 'utf8');
  const gridSource = readFileSync(itemGridPath, 'utf8');
  const cartSource = readFileSync(cartPath, 'utf8');
  const modalSource = readFileSync(menuModalPath, 'utf8');

  // Wave ΣΤ8b: the description is muted neutral; the card border is the kit border.
  assert.match(cardSource, /'text-\(--pos-s-muted\)'/);
  assert.match(cardSource, /text-yellow-800/);
  assert.match(cardSource, /text-emerald-800/);
  assert.match(cardSource, /bg-white border-\(--pos-s-border\)/);
  assert.match(cardSource, /bg-\(--pos-s-surface-2\)/);
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

  assert.match(modalSource, /md:w-76(?![\w.-])/);
  assert.match(modalSource, /bg-transparent py-2 pl-3 pr-2/);
  assert.match(modalSource, /overflow-visible bg-transparent/);
  assert.match(modalSource, /bg-transparent/);
  assert.doesNotMatch(modalSource, /rounded-\[26px\] border border-white\/22/);
  assert.doesNotMatch(modalSource, /shadow-\[0_18px_42px_rgba\(0,0,0,0\.22\)\]/);
  assert.doesNotMatch(modalSource, /bg-white\/2\.5(?![\w.-])/);
  assert.doesNotMatch(modalSource, /backdrop-blur-2xl/);
  // founder 11/11/2026: frosted cart body, with an explicitly opaque checkout/total area.
  // Founder 31/10 («το καλάθι δεν είναι εύκολα αναγνώσιμο»): the cart is a solid kit panel, not see-through.
  assert.match(cartSource, /pos-glass-form-card p-0! flex h-full w-full flex-col overflow-hidden rounded-\[28px\]! text-\(--pos-s-fg\)/);
  assert.doesNotMatch(cartSource, /bg-black\/3 dark:bg-white\/6|bg-black\/8 dark:bg-white\/12|bg-slate-500\/15/);
  // Wave ΣΤ2: flat solid surfaces, no tinted elevation shadow.
  assert.doesNotMatch(cartSource, /shadow-\[0_10px_28px_rgba/);
  assert.match(cartSource, /overflow-y-auto p-3 touch-scroll scrollbar-hide/);
  assert.doesNotMatch(cartSource, /overflow-y-auto p-3 touch-scroll pos-scrollbar-glass/);
  assert.match(cartSource, /shrink-0 p-3 bg-\(--pos-s-surface\) space-y-3/);
  assert.match(cartSource, /bg-transparent border-0 p-0 shadow-none/);
  assert.match(cartSource, /<Ticket className="h-8 w-8 shrink-0"/);
  assert.match(cartSource, /<Award className="h-8 w-8 shrink-0"/);
  assert.match(cartSource, /<Percent className="h-8 w-8 shrink-0"/);
  assert.doesNotMatch(cartSource, /border-sky-500\/35 bg-sky-500\/12/);
  assert.doesNotMatch(cartSource, /<Gift className="w-5 h-5 shrink-0"/);
  // Round 251: the touchscreen complete-order action uses active: press feedback, not hover:.
  assert.match(cartSource, /bg-yellow-400 text-black active:bg-yellow-300/);
  assert.doesNotMatch(cartSource, /: 'bg-blue-600 text-white hover:bg-blue-700 hover:scale-\[1\.02\]'/);
});

test('menu modal keeps search below the wrapping title and cards expose hold preview details', () => {
  const cardSource = readFileSync(itemCardPath, 'utf8');
  const gridSource = readFileSync(itemGridPath, 'utf8');
  const modalSource = readFileSync(menuModalPath, 'utf8');
  const chipSource = readFileSync(contextChipPath, 'utf8');
  const chipCss = readFileSync(contextChipCssPath, 'utf8');

  // Long edit titles wrap and search has a full-width second row.
  assert.match(modalSource, /liquid-glass-modal-title text-xl flex flex-wrap items-center gap-2 min-w-0/);
  assert.match(modalSource, /whitespace-normal wrap-break-word/);
  assert.match(modalSource, /ref=\{menuSearchRef\}/);
  assert.match(modalSource, /relative min-w-0 col-span-2 row-start-2/);
  assert.match(modalSource, /focus:border-\(--pos-s-yellow\) focus:outline-hidden focus:ring-1 focus:ring-yellow-400/);
  // Both customer states use the reviewed neutral chip; the editable one retains its action.
  assert.match(modalSource, /<OrderContextChip onClick=\{\(\) => setShowCustomerPopover\(true\)\}>/);
  assert.match(chipSource, /<User size=\{15\} aria-hidden="true" \/>/);
  assert.match(chipSource, /<button type="button" className=\{className\} onClick=\{onClick\}>/);
  assert.match(chipCss, /min-height:\s*44px/);
  assert.match(chipCss, /background:\s*#f4f5f6;\s*color:\s*#27272a/);
  assert.match(chipCss, /\.order-context-chip--dark\s*\{[^}]*background:\s*#24272b;\s*color:\s*#f4f4f5/);
  assert.match(chipCss, /\.order-context-chip > svg\s*\{[^}]*color:\s*currentColor/);
  assert.doesNotMatch(chipCss, /backdrop-filter:\s*blur|rgba\(/);
  assert.doesNotMatch(modalSource, /bg-blue-500\/20 text-blue-300 border border-blue-500\/30/);
  assert.doesNotMatch(modalSource, /focus:ring-blue-400/);
  assert.doesNotMatch(modalSource, /\/\* Search bar \*\//);

  assert.match(cardSource, /holdTimerRef/);
  assert.match(cardSource, /suppressNextClickRef/);
  assert.match(cardSource, /onPreview\?\.\(item,\s*cardRef\.current\.getBoundingClientRect\(\)\)/);
  assert.doesNotMatch(cardSource, /absolute inset-0 z-20/);

  assert.match(gridSource, /createPortal/);
  assert.match(gridSource, /MenuItemPreviewState/);
  assert.match(gridSource, /fixed inset-0 z-2147483001(?![\w.-])/);
  assert.match(gridSource, /setPreview\(\{ item: previewItem, anchorRect \}\)/);
  assert.match(gridSource, /menu\.cart\.ingredients/);
  assert.match(gridSource, /ingredients: item\.ingredients \|\| null/);
});

test('menu modal edit mode formats order numbers and flattens kiosk customizations', () => {
  const modalSource = readFileSync(menuModalPath, 'utf8');

  assert.match(modalSource, /formatCompactOrderNumberForDisplay\(editOrderNumber, original\?\.created_at \|\| original\?\.createdAt\)/);
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
  assert.match(modalSource, /const sourceOrderItemId =/);
  assert.match(modalSource, /source_order_item_id: sourceOrderItemId/);
  assert.match(modalSource, /editingCartItem\?\.source_order_item_id/);
});
