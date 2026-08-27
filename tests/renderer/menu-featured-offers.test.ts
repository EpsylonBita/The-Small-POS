import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  buildFeaturedMenuNavigationShortcuts,
  rankFeaturedMenuItems,
} from '../../src/renderer/utils/featured-menu-items.ts';
import { evaluateCachedCatalogOffers } from '../../src/renderer/utils/catalog-offers.ts';

test('Featured resolves legacy sales IDs by normalized item name and category while preserving rank', () => {
  const menuItems = [
    { id: 'current-cola', name: 'Coca Cola', category_id: 'drinks', is_featured: false },
    { id: 'current-crepe', name: 'Κρέπα Αλμυρή', category_id: 'savory', is_featured: false },
  ];
  const ranked = rankFeaturedMenuItems(menuItems, [
    { menuItemId: 'legacy-crepe', name: ' ΚΡΕΠΑ   ΑΛΜΥΡΗ ', categoryId: 'savory' },
    { menuItemId: 'legacy-cola', name: 'coca cola', categoryId: 'drinks' },
  ]);

  assert.deepEqual(ranked.map((item) => item.id), ['current-crepe', 'current-cola']);
});

test('Featured remains useful on a fresh terminal by falling back to configured then available items', () => {
  const menuItems = [
    { id: 'plain', name: 'Plain', category_id: 'food', is_featured: false },
    { id: 'configured', name: 'Configured', category_id: 'food', is_featured: true },
  ];

  assert.deepEqual(
    rankFeaturedMenuItems(menuItems, []).map((item) => item.id),
    ['configured'],
  );
  assert.deepEqual(
    rankFeaturedMenuItems(
      menuItems.map((item) => ({ ...item, is_featured: false })),
      [],
    ).map((item) => item.id),
    ['plain', 'configured'],
  );
});

test('Featured derives ranked category and flavor shortcuts from the same catalog snapshot', () => {
  const menuItems = [
    { id: 'waffle-sweet', name: 'Sweet Waffle', category_id: 'waffles', flavor_type: 'sweet' as const },
    { id: 'crepe-savory', name: 'Savory Crepe', category_id: 'crepes', flavor_type: 'savory' as const },
    { id: 'waffle-savory', name: 'Savory Waffle', category_id: 'waffles', flavor_type: 'savory' as const },
    { id: 'cola', name: 'Cola', category_id: 'drinks', flavor_type: null },
  ];
  const rankedItems = rankFeaturedMenuItems(menuItems, [
    { menuItemId: 'waffle-sweet', name: 'Sweet Waffle', categoryId: 'waffles' },
    { menuItemId: 'crepe-savory', name: 'Savory Crepe', categoryId: 'crepes' },
    { menuItemId: 'waffle-savory', name: 'Savory Waffle', categoryId: 'waffles' },
    { menuItemId: 'cola', name: 'Cola', categoryId: 'drinks' },
  ]);

  const shortcuts = buildFeaturedMenuNavigationShortcuts(rankedItems, [
    { id: 'featured', name: 'Featured', icon: '⭐' },
    { id: 'combos', name: 'Offers', icon: '🎁' },
    { id: 'crepes', name: 'Crepes', icon: '🥞' },
    { id: 'waffles', name: 'Waffles', icon: '🧇' },
    { id: 'drinks', name: 'Drinks', icon: '🥤' },
    { id: 'empty', name: 'Empty', icon: '🍽️' },
  ]);

  assert.deepEqual(
    shortcuts.map((shortcut) => ({
      kind: shortcut.kind,
      categoryId: shortcut.categoryId,
      subcategoryId: shortcut.subcategoryId,
      flavorType: shortcut.flavorType,
    })),
    [
      { kind: 'category', categoryId: 'waffles', subcategoryId: undefined, flavorType: undefined },
      { kind: 'subcategory', categoryId: 'waffles', subcategoryId: 'waffles-sweet', flavorType: 'sweet' },
      { kind: 'subcategory', categoryId: 'waffles', subcategoryId: 'waffles-savory', flavorType: 'savory' },
      { kind: 'category', categoryId: 'crepes', subcategoryId: undefined, flavorType: undefined },
      { kind: 'subcategory', categoryId: 'crepes', subcategoryId: 'crepes-savory', flavorType: 'savory' },
      { kind: 'category', categoryId: 'drinks', subcategoryId: undefined, flavorType: undefined },
    ],
  );
  assert.equal(shortcuts[0]?.categoryName, 'Waffles');
  assert.equal(shortcuts[0]?.icon, '🧇');
  assert.equal(shortcuts[0]?.itemCount, 2);
  assert.ok(shortcuts.every((shortcut) => shortcut.categoryId !== 'featured'));
  assert.ok(shortcuts.every((shortcut) => shortcut.categoryId !== 'combos'));
  assert.ok(shortcuts.every((shortcut) => shortcut.categoryId !== 'empty'));
});

test('two qualifying savory items automatically produce the configured free Cola reward', () => {
  const result = evaluateCachedCatalogOffers(
    {
      branch_id: 'branch-1',
      catalog_type: 'menu',
      offers: [{
        id: 'offer-1',
        organization_id: 'org-1',
        branch_id: 'branch-1',
        catalog_type: 'menu',
        name: '2 αλμυρές + Cola δώρο',
        description: null,
        is_active: true,
        priority: 10,
        repeatable: true,
        has_time_restriction: false,
        available_days: [0, 1, 2, 3, 4, 5, 6],
        start_time: null,
        end_time: null,
        valid_from: null,
        valid_until: null,
        created_at: '2026-07-30T10:00:00Z',
        updated_at: '2026-07-30T10:00:00Z',
        triggers: [{
          id: 'trigger-1',
          offer_id: 'offer-1',
          trigger_type: 'category_quantity',
          item_id: null,
          category_id: 'savory',
          quantity: 2,
          display_order: 0,
          created_at: '2026-07-30T10:00:00Z',
        }],
        rewards: [{
          id: 'reward-1',
          offer_id: 'offer-1',
          reward_type: 'free_item',
          item_id: 'cola',
          quantity: 1,
          display_order: 0,
          created_at: '2026-07-30T10:00:00Z',
        }],
      }],
      reward_items: [{
        item_id: 'cola',
        item_name: 'Coca Cola',
        category_id: 'drinks',
        unit_price: 2.5,
      }],
    },
    [
      { item_id: 'crepe-1', category_id: 'savory', quantity: 1, unit_price: 6 },
      { item_id: 'crepe-2', category_id: 'savory', quantity: 1, unit_price: 7 },
    ],
    'menu',
  );

  assert.equal(result.matched_offers[0]?.offer_name, '2 αλμυρές + Cola δώρο');
  assert.equal(result.reward_actions[0]?.item_id, 'cola');
  assert.equal(result.reward_actions[0]?.quantity, 1);
});

test('MenuModal hides the legacy Combos & Offers category while preserving automatic offers', () => {
  const source = readFileSync(
    path.join(process.cwd(), 'src', 'renderer', 'components', 'modals', 'MenuModal.tsx'),
    'utf8',
  );

  assert.doesNotMatch(source, /\{\s*id:\s*["']combos["'][\s\S]*?modals\.menu\.combos/);
  assert.match(source, /validateCatalogOffers\(\{\s*catalogType:\s*'menu'/);
  assert.match(source, /createMenuRewardLine/);
  assert.match(source, /is_offer_reward:\s*true/);
  // The destructure also carries lastUpdated/refresh for the live-refresh
  // behavior (featured-live-refresh.test.ts); this pin only cares that the
  // ranking trio still flows from useFeaturedItems.
  assert.match(
    source,
    /const\s*\{\s*topSellerIds,\s*rankedTopSellerIds,\s*topSellers,[\s\S]{0,200}?\}\s*=\s*useFeaturedItems/,
  );
  assert.match(source, /topSellers=\{topSellers\}/);
  assert.match(source, /categories=\{categories\}/);
  assert.match(source, /onShortcutNavigate=\{handleFeaturedShortcutNavigate\}/);
});

test('offer reward chips are localized consistently in every POS locale', () => {
  const locales = ['en', 'el', 'de', 'fr', 'it'];
  for (const locale of locales) {
    const translations = JSON.parse(
      readFileSync(
        path.join(process.cwd(), 'src', 'locales', `${locale}.json`),
        'utf8',
      ),
    );
    const cart = translations.menu?.cart;
    assert.equal(typeof cart?.autoOfferReward, 'string', `${locale} autoOfferReward`);
    assert.equal(typeof cart?.freeLabel, 'string', `${locale} freeLabel`);
    assert.equal(typeof cart?.offerDiscount, 'string', `${locale} offerDiscount`);
    assert.match(
      cart?.offerDiscountWithNames ?? '',
      /\{\{names\}\}/,
      `${locale} offerDiscountWithNames must preserve the names interpolation`,
    );
  }

  const greekCart = JSON.parse(
    readFileSync(path.join(process.cwd(), 'src', 'locales', 'el.json'), 'utf8'),
  ).menu.cart;
  assert.equal(greekCart.autoOfferReward, 'Προσφορά');
  assert.equal(greekCart.freeLabel, 'Δωρεάν');
  assert.equal(greekCart.offerDiscount, 'Προσφορές');

  for (const component of [
    'src/renderer/components/menu/MenuCart.tsx',
    'src/renderer/components/modals/ProductCatalogModal.tsx',
  ]) {
    const source = readFileSync(path.join(process.cwd(), component), 'utf8');
    assert.match(source, /menu\.cart\.autoOfferReward/);
    assert.match(source, /menu\.cart\.freeLabel/);
    assert.match(source, /menu\.cart\.offerDiscount/);
    assert.match(source, /menu\.cart\.offerDiscountWithNames/);
  }
});

test('Featured navigation shortcuts use the existing Lucide icon language without emoji fallbacks', () => {
  const source = readFileSync(
    path.join(process.cwd(), 'src', 'renderer', 'components', 'menu', 'MenuItemGrid.tsx'),
    'utf8',
  );

  assert.match(source, /import\s*\{[^}]*Layers[^}]*LayoutGrid[^}]*\}\s*from 'lucide-react'/s);
  assert.match(source, /shortcut\.kind === 'category'[\s\S]*?<LayoutGrid/);
  assert.match(source, /<Layers/);
  assert.doesNotMatch(source, /🍽️|🍯|🧂/);
});
