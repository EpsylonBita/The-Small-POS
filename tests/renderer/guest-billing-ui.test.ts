import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const source = readFileSync(
  path.join(process.cwd(), 'src', 'renderer', 'pages', 'verticals', 'hotel', 'GuestBillingView.tsx'),
  'utf8',
);

test('Round 394: GuestBillingView uses touch-first glass chrome without old blue/hover styling', () => {
  assert.match(source, /useId/);
  assert.match(source, /aria-modal="true"/);
  assert.match(source, /aria-labelledby=\{titleId\}/);
  assert.match(source, /rounded-3xl border shadow-2xl backdrop-blur-2xl ring-1/);
  assert.match(source, /overflow-y-auto scrollbar-hide rounded-3xl/);

  assert.match(
    source,
    /<h1 className=\{`truncate text-3xl font-bold tracking-tight \$\{isDark \? 'text-white' : 'text-gray-900'\}`\}>\s*\{t\('navigation\.menu\.guest_billing', \{ defaultValue: 'Guest Billing' \}\)\}\s*<\/h1>/,
  );

  assert.match(source, /focus:ring-2 focus:ring-yellow-400/);
  assert.match(source, /ring-2 ring-yellow-400/);
  assert.match(source, /bg-yellow-400 text-black border border-yellow-500/);
  assert.match(source, /bg-green-600 text-white/);
  assert.match(source, /text-amber-500/);

  assert.doesNotMatch(source, /hover:/);
  assert.doesNotMatch(source, /\btitle=/);
  assert.doesNotMatch(source, /rounded-lg/);
  assert.doesNotMatch(source, /(?:bg|text|border|ring|focus:ring)-blue-/);
  assert.doesNotMatch(source, /bg-gray-750/);
  // Mojibake: UTF-8 read as Latin-1/cp1252 (Â·, Ã©, â€”, ðŸ, Î/Ï for Greek) or a replacement
  // character. A real "—" or "·" is typography, not mojibake: since 04/10/2026 the amount label
  // shows the folio's recorded currency and "—" while none is recorded (never an assumed €).
  assert.doesNotMatch(source, /[ÂÃâðÎÏ�]/, 'source must not contain mojibake');
  assert.match(source, /\{t\('guestBilling\.fields\.amount', \{ defaultValue: 'Amount' \}\)\} \(\{folio\.currency \?\? '—'\}\)/);
  assert.doesNotMatch(source, /€|&euro;/, 'no hard-coded euro sign');
});

test('Round 394: GuestBillingView scroll panes hide native scrollbars and icon buttons are labelled', () => {
  const scrollPanes = source.match(/overflow-y-auto[^"`]*scrollbar-hide/g) || [];
  assert.ok(scrollPanes.length >= 3, `expected at least 3 hidden-scroll panes, found ${scrollPanes.length}`);

  assert.match(source, /aria-label=\{t\('common\.close', \{ defaultValue: 'Close' \}\)\}/);
  assert.match(source, /inline-flex h-11 w-11 items-center justify-center rounded-xl/);
  assert.match(source, /type="button"\s+onClick=\{onClose\}/);
});
