import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

// Source-level guard (like the other renderer tests) for Round 199: shared glass modals isolate the
// background POS app from assistive tech while open. Live QA found that with Settings open
// (ConnectionSettingsModal via LiquidGlassModal) the Windows accessibility tree still exposed the
// background sidebar / order tabs / order row / New Order before the modal, breaking modal containment.
const componentsPath = path.join(
  process.cwd(),
  'src',
  'renderer',
  'components',
  'ui',
  'pos-glass-components.tsx',
);
const source = readFileSync(componentsPath, 'utf8');

// (1) Both POSGlassModal and LiquidGlassModal viewport roots carry data-liquid-glass-modal-viewport.
test('both glass modal viewport roots are marked with data-liquid-glass-modal-viewport', () => {
  const marked = source.match(/className="liquid-glass-modal-viewport" data-liquid-glass-modal-viewport/g) || [];
  assert.equal(marked.length, 2, 'both POSGlassModal and LiquidGlassModal viewport roots must carry the marker');

  // The marker name is centralised in one constant that the skip-check reads.
  assert.match(source, /const MODAL_VIEWPORT_ATTR = 'data-liquid-glass-modal-viewport'/);

  // Both modal components opt into the shared isolation hook.
  assert.match(source, /export const POSGlassModal[\s\S]*?useBackgroundAccessibilityIsolation\(isOpen\)/);
  assert.match(source, /export const LiquidGlassModal[\s\S]*?useBackgroundAccessibilityIsolation\(mounted && !isServerRender\)/);
});

// (2) The shared isolation code sets aria-hidden + inert on non-modal body children.
test('background isolation hides non-modal body children via aria-hidden and inert', () => {
  // Scans the actual body children (not the modal subtree).
  assert.match(source, /Array\.from\(document\.body\.children\)/);
  // Applies aria-hidden=true and inert=true to each isolated child.
  assert.match(source, /node\.setAttribute\('aria-hidden', 'true'\)/);
  assert.match(source, /if \(canInert\) setInert\(node, true\)/);
  // inert is feature-detected so older webviews still get aria-hidden.
  assert.match(source, /const supportsInert = \(\): boolean =>[\s\S]*?'inert' in HTMLElement\.prototype/);
  // The hook acquires on activation and releases on cleanup.
  assert.match(
    source,
    /useBackgroundAccessibilityIsolation = \(active: boolean\): void => \{[\s\S]*?acquireBackgroundIsolation\(\)[\s\S]*?return \(\) => \{[\s\S]*?releaseBackgroundIsolation\(\)/,
  );
});

// (3) It skips modal viewport roots (so nested/sibling dialogs stay reachable).
test('background isolation skips modal viewport roots', () => {
  assert.match(source, /if \(node\.hasAttribute\(MODAL_VIEWPORT_ATTR\)\) return/);
  // The skip-check lives inside the apply scan, before anything is hidden.
  assert.match(
    source,
    /const applyBackgroundIsolation = \(\): void => \{[\s\S]*?if \(node\.hasAttribute\(MODAL_VIEWPORT_ATTR\)\) return[\s\S]*?setAttribute\('aria-hidden', 'true'\)/,
  );
});

// (4) Cleanup/restoration accounts for multiple active modals (ref count) and restores prior state.
test('background isolation ref-counts modals and restores previous aria-hidden/inert state', () => {
  // A ref count guards how many glass modals are active.
  assert.match(source, /let backgroundIsolationCount = 0/);
  assert.match(source, /backgroundIsolationCount \+= 1/);
  assert.match(source, /backgroundIsolationCount = Math\.max\(0, backgroundIsolationCount - 1\)/);
  // The app is only un-hidden once the LAST glass modal releases.
  assert.match(
    source,
    /releaseBackgroundIsolation = \(\): void => \{[\s\S]*?if \(backgroundIsolationCount === 0\) \{\s*restoreBackgroundIsolation\(\)/,
  );

  // Each touched element's ORIGINAL state is captured exactly once (never overwritten by a 2nd modal).
  assert.match(source, /const backgroundIsolationSaved = new Map<HTMLElement, SavedBackgroundA11yState>\(\)/);
  assert.match(source, /if \(backgroundIsolationSaved\.has\(node\)\) return/);
  assert.match(source, /backgroundIsolationSaved\.set\(node, \{\s*ariaHidden: node\.getAttribute\('aria-hidden'\)/);

  // Restore writes the saved values back (null -> removeAttribute) and clears the map.
  assert.match(source, /saved\.ariaHidden === null/);
  assert.match(source, /node\.removeAttribute\('aria-hidden'\)/);
  assert.match(source, /node\.setAttribute\('aria-hidden', saved\.ariaHidden\)/);
  assert.match(source, /if \(canInert\) setInert\(node, saved\.inert\)/);
  assert.match(source, /backgroundIsolationSaved\.clear\(\)/);
});

// Containment must not regress the existing modal semantics, and stay touch-first.
test('glass modals preserve dialog semantics, portal behaviour, and add no hover utilities', () => {
  assert.match(source, /role="dialog"/);
  assert.match(source, /aria-modal="true"/);
  assert.match(source, /ReactDOM\.createPortal\(modalContent, document\.body\)/);
  // Focus trap + topmost Escape behaviour still present.
  assert.match(source, /const isTopMostDialog = React\.useCallback/);
  assert.match(source, /const getFocusableElements/);
  // No hover utilities anywhere in the shared modal components (touchscreen-first).
  assert.doesNotMatch(source, /hover:/);
});

// Round 202: the shared isolation hook + viewport marker are EXPORTED so other app-level modals
// (e.g. TableActionModal) reuse the same ref-counted logic instead of duplicating it. This guards the
// export contract those consumers depend on.
test('the shared background-isolation hook and viewport marker are exported for reuse', () => {
  assert.match(source, /export const useBackgroundAccessibilityIsolation = \(active: boolean\): void =>/);
  assert.match(source, /export const MODAL_VIEWPORT_ATTR = 'data-liquid-glass-modal-viewport'/);
});
