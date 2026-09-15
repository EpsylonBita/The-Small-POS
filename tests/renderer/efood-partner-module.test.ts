import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { isViewAccessDenied, resolveViewModuleId } from '../../src/renderer/utils/module-view-access';

const projectRoot = process.cwd();
const read = (...segments: string[]) => readFileSync(path.join(projectRoot, ...segments), 'utf8');

// The efood Partner (Live Orders) page hosted inside the POS: efood keeps the
// shop closed unless one of its own devices is connected, so the POS keeps
// their web app alive itself instead of a separate browser on the till.

test('the efood Partner view is gated by the plugin_integrations module like the plugins page', () => {
  assert.equal(resolveViewModuleId('efood_partner'), 'plugin_integrations');
  assert.equal(isViewAccessDenied([{ module: { id: 'plugin_integrations' } }], 'efood_partner'), false);
  assert.equal(isViewAccessDenied([{ module: { id: 'orders' } }], 'efood_partner'), true);
});

test('the main layout registers the efood Partner view and keeps the page alive from startup', () => {
  const layout = read('src', 'renderer', 'components', 'RefactoredMainLayout.tsx');
  assert.match(layout, /efood_partner:\s*EfoodPartnerView,/);
  // Loaded (parked) as soon as the register starts, so efood sees its equipment
  // connected before anyone opens the module.
  assert.match(layout, /efoodPartnerBridge\.ensure\(/);
});

test('the sidebar shows an efood entry only when the efood Partner page is available on this register', () => {
  const sidebar = read('src', 'renderer', 'components', 'NavigationSidebar.tsx');
  assert.match(sidebar, /const \{ available: efoodPartnerAvailable \} = useEfoodPartner\(\)/);
  const start = sidebar.indexOf('{/* efood Partner (Live Orders) hosted in the POS */}');
  assert.notEqual(start, -1, 'efood Partner sidebar block should exist');
  const block = sidebar.slice(start, sidebar.indexOf('</button>', start));
  assert.match(block, /efoodPartnerAvailable && \(/);
  assert.match(block, /handleNavClick\(EFOOD_PARTNER_VIEW, false\)/);
  assert.match(block, /aria-current=\{currentView === EFOOD_PARTNER_VIEW \? 'page' : undefined\}/);
  assert.match(block, /data-testid="nav-efood-partner"/);
});

test('the efood label is the brand name in every locale', () => {
  for (const locale of ['en', 'el', 'de', 'fr', 'it']) {
    const messages = JSON.parse(read('src', 'locales', `${locale}.json`)) as { navigation?: Record<string, unknown> };
    assert.equal(messages.navigation?.efood_partner, 'efood', `${locale}: navigation.efood_partner`);
  }
});
