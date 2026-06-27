import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import i18next from 'i18next';

import { formatTableDisplayNumber } from '../../src/renderer/utils/table-display.ts';

const modalSource = readFileSync(
  path.join(process.cwd(), 'src', 'renderer', 'components', 'tables', 'TableActionModal.tsx'),
  'utf8',
);
const dashboardSource = readFileSync(
  path.join(process.cwd(), 'src', 'renderer', 'components', 'OrderDashboard.tsx'),
  'utf8',
);
const localesDir = path.join(process.cwd(), 'src', 'locales');

const loadLocale = (lng: string): Record<string, any> =>
  JSON.parse(readFileSync(path.join(localesDir, `${lng}.json`), 'utf8'));

const createT = async (lng: string) => {
  const instance = i18next.createInstance();
  await instance.init({
    lng,
    fallbackLng: 'en',
    resources: {
      en: { translation: loadLocale('en') },
      el: { translation: loadLocale('el') },
      de: { translation: loadLocale('de') },
      fr: { translation: loadLocale('fr') },
      it: { translation: loadLocale('it') },
    },
    interpolation: { escapeValue: false },
  });
  return instance.getFixedT(lng);
};

const untranslatedTableActionKeys = [
  'decreaseCovers',
  'increaseCovers',
  'unpaidBalance',
  'newOrderCleaningDisabled',
  'newOrderMaintenanceDisabled',
  'newOrderUnavailableDisabled',
  'markCleaned',
  'markAvailable',
  'markBackInService',
  'markAvailableDescription',
  'markBackInServiceDescription',
  'editReservation',
  'editReservationDescription',
  'noShowReservation',
  'noShowReservationDescription',
  'cancelReservation',
  'cancelReservationDescription',
  'newReservationUnavailableDescription',
  'cleaningHint',
  'maintenanceHint',
  'reservedHint',
  'unavailableHint',
  'reservationNotFound',
  'reservationLoadFailed',
  'noShowSuccess',
  'noShowFailed',
  'cancelReason',
  'cancelSuccess',
  'cancelFailed',
  'setAvailableSuccess',
  'setAvailableFailed',
];

test('TableActionModal mounts through an app-level portal, not inside the table grid', () => {
  // The overlay must mount at document.body so the backdrop/blur covers the full POS
  // viewport (sidebar + outer shell) instead of a transformed/overflow grid ancestor.
  assert.match(modalSource, /import \{ createPortal \} from 'react-dom';/);
  assert.match(modalSource, /const modalContent = \(/);
  assert.match(modalSource, /return createPortal\(modalContent, document\.body\);/);

  // The full-viewport fixed backdrop with blur is preserved on the app-modal layer.
  assert.match(modalSource, /className="fixed inset-0 z-\[1200\]/);
  assert.match(modalSource, /bg-black\/50 backdrop-blur-sm/);

  // A no-document guard falls back to an inline render instead of throwing.
  assert.match(modalSource, /typeof document === 'undefined' \|\| !document\.body/);
});

test('TableActionModal overlay stacks above the sidebar and FAB, not on z-50', () => {
  // A portal alone is not enough: with z-50 the backdrop ties the sidebar (z-50) and
  // loses to the FAB (z-[900]), leaving the shell visible. The wrapper must use a POS
  // app-modal z-index above both layers (and below the titlebar).
  const overlay = modalSource.match(/className="fixed inset-0 (z-\[\d+\]|z-50)/);
  assert.ok(overlay, 'overlay wrapper className not found');
  assert.notEqual(overlay[1], 'z-50', 'overlay must not stay on the z-50 sidebar layer');

  const zMatch = overlay[1].match(/z-\[(\d+)\]/);
  assert.ok(zMatch, `overlay z-index must be an explicit app-modal layer, got "${overlay[1]}"`);
  const z = Number(zMatch[1]);
  assert.ok(z > 900, `overlay z-index ${z} must be above the FAB layer (z-900)`);
  assert.ok(z > 50, `overlay z-index ${z} must be above the sidebar layer (z-50)`);
});

test('TableActionModal header uses the shared table display helper, not the raw table number', () => {
  // The modal header showed "#B01" while the grid card showed "#TB01"; both must use
  // the same display convention so the identifier matches the clicked card.
  assert.match(modalSource, /import \{ formatTableDisplayNumber \} from ['"]\.\.\/\.\.\/utils\/table-display['"];/);
  assert.match(modalSource, /formatTableDisplayNumber\(table\.tableNumber\)/);
  assert.doesNotMatch(modalSource, /#\{table\.tableNumber\}/);

  // The embedded dashboard table card uses the same shared helper (no local duplicate).
  assert.match(dashboardSource, /import \{ formatTableDisplayNumber \} from ['"]\.\.\/utils\/table-display['"];/);
  assert.match(dashboardSource, /formatTableDisplayNumber\(table\.tableNumber\)/);
  assert.doesNotMatch(dashboardSource, /const formatTableCardNumber =/);
});

test('formatTableDisplayNumber matches the dashboard card convention', () => {
  assert.equal(formatTableDisplayNumber('B01'), '#TB01');
  assert.equal(formatTableDisplayNumber('T05'), '#T05');
  assert.equal(formatTableDisplayNumber('t9'), '#t9');
  assert.equal(formatTableDisplayNumber('#T05'), '#T05');
  assert.equal(formatTableDisplayNumber('05'), '#T05');
  assert.equal(formatTableDisplayNumber(''), '#T');
  assert.equal(formatTableDisplayNumber(null), '#T');
});

test('TableActionModal renders capacity guests through i18next plurals', async () => {
  assert.match(
    modalSource,
    /t\('tableActionModal\.guests',\s*\{\s*count:\s*table\.capacity/,
    'TableActionModal must pass count when rendering the capacity guest noun',
  );

  for (const lng of ['en', 'el', 'de', 'fr', 'it']) {
    const modal = loadLocale(lng).tableActionModal;
    assert.equal(typeof modal.guests_one, 'string', `${lng}.tableActionModal.guests_one missing`);
    assert.equal(typeof modal.guests_other, 'string', `${lng}.tableActionModal.guests_other missing`);
    assert.equal(modal.guests, undefined, `${lng}.tableActionModal.guests should not remain as a flat fallback`);
  }

  const t = await createT('el');
  assert.equal(t('tableActionModal.guests', { count: 1 }), 'επισκέπτης');
  assert.equal(t('tableActionModal.guests', { count: 2 }), 'επισκέπτες');
});

test('de/fr/it TableActionModal action copy no longer leaks English source strings', () => {
  const en = loadLocale('en').tableActionModal;

  for (const lng of ['de', 'fr', 'it']) {
    const modal = loadLocale(lng).tableActionModal;
    for (const key of untranslatedTableActionKeys) {
      assert.notEqual(
        modal[key],
        en[key],
        `${lng}.tableActionModal.${key} still equals the English source string`,
      );
    }
  }
});

test('TableActionModal exposes dialog semantics so it joins the topmost-modal behavior', () => {
  // The modal was a plain group/heading; it must declare role="dialog" + aria-modal and
  // a useful label so accessibility and future topmost-dialog logic do not drift.
  assert.match(modalSource, /ref=\{dialogRef\}/);
  assert.match(modalSource, /role="dialog"/);
  assert.match(modalSource, /aria-modal="true"/);
  assert.match(modalSource, /aria-labelledby="table-action-modal-title"/);
  assert.match(modalSource, /<h2 id="table-action-modal-title"/);
});

test('TableActionModal closes on Escape only while open and only when it is the topmost dialog', () => {
  const escEffect = modalSource.match(
    /useEffect\(\(\) => \{\s*if \(!isOpen\) \{[\s\S]*?\}, \[isOpen, onClose\]\);/,
  );
  assert.ok(escEffect, 'an isOpen-gated Escape effect must exist');
  // Only handles Escape.
  assert.match(escEffect[0], /if \(event\.key !== 'Escape'\) \{\s*return;\s*\}/);
  // Topmost-dialog gate, mirroring LiquidGlassModal, so a child dialog above this one
  // (e.g. the reservation form) closes first instead of this modal.
  assert.match(escEffect[0], /document\.querySelectorAll\('\[role="dialog"\]'\)/);
  assert.match(escEffect[0], /dialogs\[dialogs\.length - 1\] !== dialogRef\.current/);
  // Dismisses via the parent-owned onClose, and registers/cleans up the listener.
  assert.match(escEffect[0], /onClose\(\)/);
  assert.match(escEffect[0], /document\.addEventListener\('keydown', handleEscape\)/);
  assert.match(escEffect[0], /document\.removeEventListener\('keydown', handleEscape\)/);
});

test('TableActionModal action callbacks defer close to the parent so Escape cannot race them', () => {
  // The action handlers intentionally do not call onClose (the parent manages the modal
  // lifecycle), so the new Escape->onClose path cannot double-fire alongside an action.
  const guards = modalSource.match(/Don't call onClose\(\) here/g) || [];
  assert.ok(guards.length >= 3, `action handlers must defer onClose to the parent (found ${guards.length})`);
});

// Round 202 (live QA): with TableActionModal open, the Windows accessibility tree still exposed the
// background POS app (sidebar, order tabs, table grid, Expenses/New Order) before the dialog. The fix
// makes TableActionModal join the SAME shared, ref-counted background isolation verified in round 199
// for the glass modals — reusing the exported hook + marker, not duplicating the ref-count logic.
test('TableActionModal reuses the shared background-isolation hook + viewport marker', () => {
  // Imports the shared hook AND the marker constant from pos-glass-components (no copy of the logic).
  assert.match(
    modalSource,
    /import \{\s*useBackgroundAccessibilityIsolation,\s*MODAL_VIEWPORT_ATTR,?\s*\} from '\.\.\/ui\/pos-glass-components';/,
  );

  // Acquires isolation while open (released on close via the hook's own cleanup + ref count).
  assert.match(modalSource, /useBackgroundAccessibilityIsolation\(isOpen\);/);

  // The app-level portal root is marked as a viewport root (via the shared constant) so the
  // isolation skip-check leaves THIS modal visible while hiding the rest of the app.
  assert.match(modalSource, /<div \{\.\.\.\{ \[MODAL_VIEWPORT_ATTR\]: '' \}\} className="fixed inset-0 z-\[1200\]/);

  // The shared isolation code is genuinely exported from the glass components (the contract this
  // modal depends on), not redefined locally here.
  const glassSource = readFileSync(
    path.join(process.cwd(), 'src', 'renderer', 'components', 'ui', 'pos-glass-components.tsx'),
    'utf8',
  );
  assert.match(glassSource, /export const useBackgroundAccessibilityIsolation = \(active: boolean\): void =>/);
  assert.match(glassSource, /export const MODAL_VIEWPORT_ATTR = 'data-liquid-glass-modal-viewport'/);
  assert.doesNotMatch(modalSource, /let backgroundIsolationCount/);

  // Dialog semantics + the app-level portal + z-[1200] are all preserved (no visual/behaviour change),
  // and no native title tooltip / hover utility was introduced by the isolation wiring.
  assert.match(modalSource, /role="dialog"/);
  assert.match(modalSource, /aria-modal="true"/);
  assert.match(modalSource, /return createPortal\(modalContent, document\.body\);/);
  assert.doesNotMatch(modalSource, /\btitle=\{/);
  assert.doesNotMatch(modalSource, /hover:/);
});

// Round 225 (live QA, glass consistency): TableActionModal kept a hand-rolled translucent shell that felt
// flatter than the new TableSelector / Settings / Order Type glass modals. It now adopts the SHARED
// liquid-glass tokens (shell/header/title/close/content) -- premium blurred glass, 28px radius, the shared
// open animation, hidden scrollbar -- while keeping the app-level portal, z-[1200], role=dialog, Escape,
// and background isolation (all asserted above). Semantic colours + parent-owned callbacks are unchanged.
test('TableActionModal adopts the shared liquid-glass tokens (premium glass, not a hand-rolled shell)', () => {
  // The dialog shell uses the shared glass surface class (same as the other glass modals) + a stable marker.
  assert.match(modalSource, /role="dialog"[\s\S]*?className="liquid-glass-modal-shell/);
  assert.match(modalSource, /data-table-action-modal/);

  // Shared header / title / close / content tokens (the close keeps active scale; content hides scrollbar).
  assert.match(modalSource, /className="liquid-glass-modal-header"/);
  assert.match(modalSource, /<h2 id="table-action-modal-title" className="liquid-glass-modal-title">/);
  assert.match(modalSource, /className="liquid-glass-modal-close active:scale-95"/);
  assert.match(modalSource, /className="liquid-glass-modal-content scrollbar-hide overflow-x-hidden"/);

  // Glass text/border tokens for the details card (not ad-hoc isDark white/black/gray text everywhere).
  assert.match(modalSource, /liquid-glass-modal-text\b/);
  assert.match(modalSource, /liquid-glass-modal-text-muted/);
  assert.match(modalSource, /liquid-glass-modal-border/);

  // The old hand-rolled opaque-ish shell (gray-900/60 + ring) is gone.
  assert.doesNotMatch(modalSource, /bg-gray-900\/60 border-white\/10 ring/);
});

test('TableActionModal uses lucide icons (no manual SVG arrows), a labelled close, and touch-sized steppers', () => {
  // Arrows are lucide ChevronRight, not the hand-drawn chevron path.
  assert.match(modalSource, /\bChevronRight\b/);
  assert.doesNotMatch(modalSource, /d="M9 5l7 7-7 7"/);

  // The close button now exposes a localized accessible label (it was icon-only before).
  assert.match(modalSource, /aria-label=\{t\('common\.actions\.close'/);

  // Cover steppers are a consistent, large touch target (icon centred).
  const stepperHits = modalSource.match(/inline-flex h-11 w-11 items-center justify-center/g) || [];
  assert.ok(stepperHits.length >= 2, `cover steppers must be h-11 w-11 touch targets (found ${stepperHits.length})`);

  // Touch-first only: no hover utility and no native title tooltip in the redesigned shell.
  assert.doesNotMatch(modalSource, /hover:/);
  assert.doesNotMatch(modalSource, /\btitle=\{/);
});

// Round 225 cleanup (design rule): negative letter-spacing is forbidden. TableActionModal now uses the
// shared `liquid-glass-modal-title` token, which (and any duplicate same selector) must zero its tracking.
test('liquid-glass-modal-title uses non-negative letter-spacing (no negative tracking anywhere in the glass CSS)', () => {
  const glassCss = readFileSync(
    path.join(process.cwd(), 'src', 'renderer', 'styles', 'glassmorphism.css'),
    'utf8',
  );
  // No negative letter-spacing anywhere in the shared glass stylesheet.
  assert.doesNotMatch(glassCss, /letter-spacing:\s*-/);
  // Every `.liquid-glass-modal-title` block that sets tracking sets it to 0.
  const titleBlocks = glassCss.match(/\.liquid-glass-modal-title\s*\{[^}]*\}/g) || [];
  assert.ok(titleBlocks.length >= 1, 'liquid-glass-modal-title selector must exist');
  for (const block of titleBlocks) {
    if (block.includes('letter-spacing')) {
      assert.match(block, /letter-spacing:\s*0\b/, 'liquid-glass-modal-title letter-spacing must be 0');
    }
  }
});

test('TableActionModal preserves the semantic status + action colours', () => {
  // Status tints: available green, reserved amber/yellow, occupied red, maintenance orange, unavailable neutral.
  assert.match(modalSource, /available:\s*\{[\s\S]*?text-green-500[\s\S]*?bg-green-500\/10/);
  assert.match(modalSource, /reserved:\s*\{[\s\S]*?text-yellow-500[\s\S]*?bg-yellow-500\/10/);
  assert.match(modalSource, /occupied:\s*\{[\s\S]*?text-red-500/);
  assert.match(modalSource, /maintenance:\s*\{[\s\S]*?text-orange-500/);
  assert.match(modalSource, /unavailable:\s*\{[\s\S]*?text-slate-500/);

  // Action semantics: New Order yellow, reservation amber, destructive cancel red, set-available emerald/green.
  assert.match(modalSource, /bg-yellow-400/);
  assert.match(modalSource, /text-amber-500/);
  assert.match(modalSource, /text-red-500/);
  assert.match(modalSource, /text-emerald-500/);
});
