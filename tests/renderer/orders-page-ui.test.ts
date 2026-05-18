import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const ordersPageSource = () =>
  readFileSync(
    path.join(process.cwd(), 'src', 'renderer', 'pages', 'OrdersPage.tsx'),
    'utf8',
  );

test('OrdersPage hides the orders-list scrollbar without disabling scroll', () => {
  const source = ordersPageSource();

  assert.match(
    source,
    /flex-1 overflow-y-auto scrollbar-hide p-6/,
    'orders list should keep vertical scrolling and hide the visible scrollbar',
  );
});

test('OrdersPage refresh action is an accessible icon-only inverted theme button', () => {
  const source = ordersPageSource();

  assert.match(source, /aria-label=\{refreshLabel\}/);
  assert.match(source, /title=\{refreshLabel\}/);
  assert.match(source, /h-12 w-12/);
  assert.match(source, /bg-white text-black/);
  assert.match(source, /bg-black text-white/);
  assert.doesNotMatch(source, /\{syncing \? 'Syncing\.\.\.' : 'Refresh'\}/);
});
