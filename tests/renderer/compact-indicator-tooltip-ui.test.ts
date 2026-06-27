import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

// Round 174 (touch-first): the compact sync/terminal header indicators used native DOM `title`
// tooltips and hover-only styles. The POS is touchscreen-first, so both must use accessible labels
// (aria-label / role="img") with `active:` press feedback instead of `hover:`.

const componentsDir = path.join(process.cwd(), 'src', 'renderer', 'components');
const read = (name: string) => readFileSync(path.join(componentsDir, name), 'utf8');

test('OrderSyncRouteIndicator condensed dot uses role/aria-label, no native title or hover', () => {
  const source = read('OrderSyncRouteIndicator.tsx');

  // No native browser tooltip and no hover utilities anywhere in the file.
  assert.doesNotMatch(source, /\btitle=/);
  assert.doesNotMatch(source, /hover:/);
  assert.doesNotMatch(source, /group-hover:/);

  // The condensed status dot is a labeled graphic (role="img" + aria-label), not a hover tooltip.
  assert.match(source, /role="img" aria-label=\{t\('sync\.routing\.viaParent'\)\}/);
  // The visual routing dot itself is preserved.
  assert.match(source, /w-2 h-2 rounded-full/);
});

test('TerminalTypeIndicator badge + close button use aria-label, no native title, no hover', () => {
  const source = read('TerminalTypeIndicator.tsx');

  // No native browser tooltip and no hover utilities anywhere in the file.
  assert.doesNotMatch(source, /\btitle=/);
  assert.doesNotMatch(source, /hover:/);
  assert.doesNotMatch(source, /group-hover:/);

  // Badge button: accessible name via aria-label, click-to-open detail panel preserved, and the
  // former hover:bg became active:bg (touch press feedback).
  assert.match(source, /aria-label=\{getTypeLabel\(\)\}/);
  assert.match(source, /onClick=\{\(\) => setShowDetailPanel\(!showDetailPanel\)\}/);
  assert.match(source, /active:bg-white\/10/);

  // Close button: accessible label, close behavior preserved, active: press feedback (no hover).
  assert.match(source, /aria-label=\{t\('common\.actions\.close', 'Close'\)\}/);
  assert.match(source, /onClick=\{\(\) => setShowDetailPanel\(false\)\}/);
  assert.match(source, /text-gray-400 active:text-white transition-colors p-1 rounded-lg active:bg-white\/10/);
});
