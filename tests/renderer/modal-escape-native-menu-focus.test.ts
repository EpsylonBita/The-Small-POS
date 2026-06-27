import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

// Regression: with a POS modal open, opening the native Tauri app-menu (Edit)
// dropdown and pressing Escape closed the React modal behind the still-open native
// menu. While a native menu is open the webview loses focus (document.hasFocus() is
// false), so the modal Escape handlers must ignore that key event. The fix is a
// shared webviewHasFocus() gate on both modal Escape handlers in this file.
const glassSource = readFileSync(
  path.join(process.cwd(), 'src', 'renderer', 'components', 'ui', 'pos-glass-components.tsx'),
  'utf8',
);

test('a webviewHasFocus() guard exists and treats a missing hasFocus (SSR/tests) as focused', () => {
  assert.match(glassSource, /const webviewHasFocus = \(\): boolean =>/);
  // Absent document / hasFocus -> focused, so normal Escape is never suppressed.
  assert.match(
    glassSource,
    /typeof document === 'undefined' \|\| typeof document\.hasFocus !== 'function'/,
  );
  assert.match(glassSource, /return document\.hasFocus\(\)/);
});

test('LiquidGlassModal Escape is ignored when the webview lacks focus (native menu open)', () => {
  // The native-menu case: Escape must dismiss only the native menu, never the modal
  // behind it. The guard is additive to the existing topmost-dialog/closeOnEscape gates.
  assert.match(
    glassSource,
    /if \(e\.key !== 'Escape' \|\| !closeOnEscape \|\| !isTopMostDialog\(\) \|\| !webviewHasFocus\(\)\) return/,
  );
});

test('POSGlassModal Escape also requires the webview to hold focus', () => {
  assert.match(glassSource, /if \(e\.key === 'Escape' && isOpen && webviewHasFocus\(\)\) \{/);
});

test('normal Escape behavior is preserved: the focus guard is additive, not a replacement', () => {
  // The topmost-dialog gate and the close action remain, so when the webview is
  // focused (no native menu) Escape still closes the topmost modal as before.
  assert.match(glassSource, /const isTopMostDialog = React\.useCallback\(/);
  assert.match(glassSource, /e\.preventDefault\(\)\s*handleClose\(\)/);
});
