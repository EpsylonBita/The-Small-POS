import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

// The live Tables grid reached from the sidebar opens TablesPage's local
// StatusChangeModal, not TableActionModal. This guards that the actual component on
// that path renders as an app-level modal that dims the full shell.
const pageSource = readFileSync(
  path.join(process.cwd(), 'src', 'renderer', 'pages', 'TablesPage.tsx'),
  'utf8',
);

test('TablesPage StatusChangeModal mounts through an app-level portal', () => {
  // It must portal to document.body so the backdrop covers the full POS shell
  // (sidebar + outer shell) instead of being clipped by the page/grid container.
  assert.match(pageSource, /import \{ createPortal \} from 'react-dom';/);
  assert.match(pageSource, /const modalContent = \(/);
  assert.match(pageSource, /return createPortal\(modalContent, document\.body\);/);

  // The full-viewport fixed backdrop with blur is preserved.
  assert.match(pageSource, /className="fixed inset-0 z-\[1200\]/);
  assert.match(pageSource, /bg-black\/50 backdrop-blur-sm/);

  // A no-document guard falls back to an inline render instead of throwing.
  assert.match(pageSource, /typeof document === 'undefined' \|\| !document\.body/);
});

test('TablesPage StatusChangeModal overlay stacks above the sidebar and FAB, not on z-50', () => {
  // A portal alone is insufficient: with z-50 the backdrop ties the sidebar (z-50) and
  // loses to the FAB (z-[900]). The wrapper must use a POS app-modal z-index above both.
  const overlay = pageSource.match(/className="fixed inset-0 (z-\[\d+\]|z-50)/);
  assert.ok(overlay, 'StatusChangeModal overlay wrapper className not found');
  assert.notEqual(overlay[1], 'z-50', 'overlay must not stay on the z-50 sidebar layer');

  const zMatch = overlay[1].match(/z-\[(\d+)\]/);
  assert.ok(zMatch, `overlay z-index must be an explicit app-modal layer, got "${overlay[1]}"`);
  const z = Number(zMatch[1]);
  assert.ok(z > 900, `overlay z-index ${z} must be above the FAB layer (z-900)`);
  assert.ok(z > 50, `overlay z-index ${z} must be above the sidebar layer (z-50)`);
});

const localesDir = path.join(process.cwd(), 'src', 'locales');
const loadOrderCreationDisabled = (lng: string): string | undefined =>
  JSON.parse(readFileSync(path.join(localesDir, `${lng}.json`), 'utf8')).settings?.terminal
    ?.messages?.orderCreationDisabled;

const newOrderSource = readFileSync(
  path.join(process.cwd(), 'src', 'renderer', 'pages', 'NewOrderPage.tsx'),
  'utf8',
);

test('TablesPage gates the StatusChangeModal New Order action with the orderCreation feature', () => {
  // The terminal gate must derive from the established useFeatures hook.
  assert.match(pageSource, /import \{ useFeatures \} from '\.\.\/hooks\/useFeatures';/);
  assert.match(pageSource, /isFeatureEnabled\('orderCreation'\)/);
  // The modal receives the gate and disables only true new-order attempts.
  assert.match(pageSource, /canCreateOrders=\{canCreateOrders\}/);
  assert.match(pageSource, /const isNewOrderActionDisabled = !table\.currentOrderId && !featuresLoading && !canCreateOrders;/);
  assert.match(pageSource, /disabled=\{isNewOrderActionDisabled\}/);
  assert.match(pageSource, /aria-disabled=\{isNewOrderActionDisabled\}/);
});

test('TablesPage New Order short-circuits before navigating when order creation is disabled', () => {
  const start = pageSource.indexOf('const handleNewOrder = useCallback');
  assert.ok(start > -1, 'handleNewOrder not found');
  const slice = pageSource.slice(start, start + 1000);

  const guardIdx = slice.indexOf('if (!featuresLoading && !canCreateOrders)');
  const navIdx = slice.indexOf('navigate(`/new-order');
  assert.ok(guardIdx > -1, 'handleNewOrder must guard on canCreateOrders');
  assert.ok(navIdx > -1, 'navigate to /new-order not found in handleNewOrder');
  assert.ok(guardIdx < navIdx, 'the gate guard must precede navigation');

  // The disabled message uses the localized key, not a hardcoded English-only string.
  assert.match(pageSource, /settings\.terminal\.messages\.orderCreationDisabled/);
  assert.match(slice, /toast\.error\(orderCreationDisabledMessage\)/);
});

test('TablesPage View Order opens the existing table check, not a blank new order', () => {
  // An occupied table (currentOrderId present) must open the existing
  // TableCheckManagerModal flow (current items + total), never /new-order.
  assert.match(
    pageSource,
    /import \{ TableCheckManagerModal \} from '\.\.\/components\/tables\/TableCheckManagerModal';/,
  );

  const start = pageSource.indexOf('const handleNewOrder = useCallback');
  const slice = pageSource.slice(start, start + 1200);
  const viewIdx = slice.indexOf('if (table.currentOrderId)');
  const openCheckIdx = slice.indexOf('setShowCheckManager(true)');
  const navIdx = slice.indexOf('navigate(`/new-order');
  assert.ok(viewIdx > -1, 'handleNewOrder must branch on an existing currentOrderId');
  assert.ok(openCheckIdx > -1, 'the existing-order branch must open the check manager');
  // The view-order branch (and its early return) precedes the new-order navigation.
  assert.ok(viewIdx < openCheckIdx && openCheckIdx < navIdx, 'view-order must precede new-order navigation');

  // The check manager is rendered for occupied tables; available tables still navigate.
  assert.match(pageSource, /<TableCheckManagerModal/);
  assert.match(pageSource, /isOpen=\{showCheckManager\}/);
  assert.match(pageSource, /table=\{checkManagerTable\}/);

  // Label/handler stay aligned: the quick action flips to viewOrder when an order exists.
  assert.match(
    pageSource,
    /table\.currentOrderId \? t\('tables\.actions\.viewOrder'[\s\S]*?: t\('tables\.actions\.newOrder'/,
  );
});

test('terminal order-creation-disabled message is localized in every POS locale', () => {
  const en = loadOrderCreationDisabled('en');
  for (const lng of ['en', 'el', 'de', 'fr', 'it']) {
    const value = loadOrderCreationDisabled(lng);
    assert.equal(typeof value, 'string', `${lng}.settings.terminal.messages.orderCreationDisabled missing`);
    assert.ok((value as string).length > 0, `${lng} order-creation-disabled value is empty`);
  }
  // Greek must be a real translation, not an echo of the English fallback.
  const el = loadOrderCreationDisabled('el');
  assert.notEqual(el, en, 'el order-creation-disabled must be translated');
  assert.doesNotMatch(el as string, /Order creation is disabled/);
});

test('NewOrderPage references the valid localized terminal key, not the missing one that leaked English', () => {
  // Root cause of the English leak: t('terminal.messages.featureDisabled', ...) pointed at a
  // non-existent path (top-level terminal.messages only has mobileWaiterInfo), so the default
  // English string surfaced. It must use the real localized key instead.
  assert.match(newOrderSource, /settings\.terminal\.messages\.orderCreationDisabled/);
  assert.doesNotMatch(newOrderSource, /t\('terminal\.messages\.featureDisabled'/);
});
