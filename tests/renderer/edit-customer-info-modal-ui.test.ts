import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const projectRoot = process.cwd();
const modalPath = path.join(projectRoot, 'src', 'renderer', 'components', 'modals', 'EditCustomerInfoModal.tsx');
const source = readFileSync(modalPath, 'utf8');

// Round 309 (live QA, Greek/light, 1282x802): the modal stuffed the intro, every field AND the Save/Cancel
// buttons into one `overflow-y-auto max-h-[70vh]` wrapper, so the notes field was clipped at the bottom and
// the actions only appeared after scrolling. The modal is now a bounded flex column -- a quiet header, a
// single inner scroll body (LiquidGlassModal's flex-1 / min-h-0 / overflow-y-auto content), and a fixed
// footer (the footer prop, rendered flex-shrink-0 below the body) -- so Cancel/Save are visible on first
// open. UI/layout-only: onSave, validation, payload shape, address workflow, and gating are untouched.

test('Round 309: EditCustomerInfoModal keeps grey fields + green address pin (palette preserved)', () => {
  assert.match(source, /const editCustomerInputClass =/);
  assert.match(source, /bg-gray-100 dark:bg-zinc-800\/80/);
  assert.match(source, /border-gray-300 dark:border-zinc-600/);
  assert.match(source, /focus:ring-gray-400\/60 dark:focus:ring-white\/30/);
  // Green address pin preserved.
  assert.match(source, /w-5 h-5 text-green-400/);
  assert.match(source, /className=\{editCustomerInputClass\}/);
  // No form field was removed (name / phone / address / postal / floor / ringer / notes still bound).
  for (const field of ['name', 'phone', 'address', 'postal_code', 'delivery_floor', 'name_on_ringer', 'notes']) {
    assert.match(source, new RegExp(`handleInputChange\\('${field}'`), `the ${field} field must remain`);
  }
});

test('Round 309: Save/Cancel live in a fixed, visible footer (not inside the scroll body)', () => {
  // The modal uses LiquidGlassModal's footer prop, which renders flex-shrink-0 below the scroll body, so
  // the actions are reachable on first open without scrolling.
  const footerStart = source.indexOf('footer={(');
  assert.notEqual(footerStart, -1, 'the modal must use the LiquidGlassModal footer prop');
  // The footer prop closes before the modal body (the intro paragraph is the first body node).
  const footerEnd = source.indexOf("t('modals.editCustomer.updateMessage'", footerStart);
  assert.ok(footerEnd > footerStart, 'the footer prop must close before the modal body');
  const footer = source.slice(footerStart, footerEnd);

  // Subtle glass divider/background bar.
  assert.match(footer, /border-t/);
  assert.match(footer, /backdrop-blur/);

  // Cancel = red (error glass), Save = green (success glass); both flex-1 (same height/visual weight).
  assert.match(footer, /onClick=\{handleClose\}/);
  assert.match(footer, /liquid-glass-modal-button liquid-glass-modal-error flex-1 rounded-xl/);
  assert.match(footer, /onClick=\{handleSave\}/);
  assert.match(footer, /disabled=\{isSaving\}/);
  assert.match(footer, /className=\{editCustomerSaveButtonClass\}/);
});

test('Round 309: Save button is green + same-size as Cancel with a clear disabled state (no stale yellow/hover)', () => {
  assert.match(source, /const editCustomerSaveButtonClass =/);
  // Green success button, flex-1 (matches the red flex-1 cancel) + rounded + explicit disabled treatment.
  assert.match(
    source,
    /editCustomerSaveButtonClass =\s*'liquid-glass-modal-button liquid-glass-modal-success flex-1 rounded-xl disabled:opacity-50 disabled:saturate-0 disabled:cursor-not-allowed'/,
  );
  // The stale yellow + hover save styling (and its black/border variants) are gone.
  assert.doesNotMatch(source, /bg-yellow-400 hover:bg-yellow-300/);
  assert.doesNotMatch(source, /border border-yellow-400/);
  assert.doesNotMatch(source, /disabled:!text-gray-500/);
});

test('Round 309: a single bounded scroll body -- the old inner max-h wrapper that swallowed the footer is gone', () => {
  // The custom inner scroll wrapper (which clipped the notes field and pushed the actions below the fold)
  // is removed; the body is LiquidGlassModal's own flex-1 / min-h-0 / overflow-y-auto / scrollbar-hide content.
  assert.doesNotMatch(source, /overflow-y-auto max-h-\[70vh\]/);
  // The actions are no longer an in-body row above an extra closing wrapper div.
  assert.doesNotMatch(source, /<div className="flex gap-3">\s*<button[\s\S]*?onClick=\{handleClose\}/);
  // The modal is rendered through LiquidGlassModal (bounded flex-column shell with the footer prop).
  assert.match(source, /<LiquidGlassModal/);
  assert.match(source, /size="xl"/);
});

test('Round 309: touch-first + on-palette (no hover, no native title tooltip, no blue/cyan/sky/purple/violet)', () => {
  // No pointer-only hover affordances anywhere.
  assert.doesNotMatch(source, /hover:/);
  // The only `title=` is the LiquidGlassModal heading prop -- never a native DOM tooltip on a control.
  const titles = source.match(/\btitle=/g) ?? [];
  assert.equal(titles.length, 1, 'the only title= must be the modal heading prop');
  assert.match(source, /title=\{t\('modals\.editCustomer\.title'\)\}/);
  // On-palette only: the pre-existing blue address spinner + "validating" text were moved to amber.
  assert.doesNotMatch(source, /\b(?:bg|text|border|from|to|ring)-(?:blue|cyan|sky|purple|violet|indigo)-/);
  assert.match(source, /border-amber-500\/30 border-t-amber-500/);
  assert.match(source, /text-amber-500 text-sm/);
});
