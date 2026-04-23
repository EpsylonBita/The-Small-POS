/**
 * Wave 0 regression test for Critical C7 (legacy PIN re-read on every
 * boot).
 *
 * On HEAD, `LoginPage.tsx` (around line 76) reads `staff.simple_pin`
 * from `localStorage` on every cold boot and auto-migrates it into the
 * Rust-side keyring via `bridge.auth.setupPin`. The migration runs
 * unconditionally — there is no "migration complete" flag guarding the
 * read. If the migration was interrupted mid-flight (error during
 * `settings.updateLocal`, or the user closed the app between setupPin
 * and localStorage.removeItem), the legacy PIN remains in localStorage
 * and is re-read at every subsequent boot. This test locks the bug in
 * structurally so Wave 1 C7's fix cannot silently regress.
 *
 * Wave 1 C7's fix:
 *   1. Read a persistent `legacy_pin_migrated` marker (from settings or
 *      a non-secret localStorage key) at the top of the migration path.
 *   2. Skip the `localStorage.getItem('staff.simple_pin')` read entirely
 *      if the marker is set.
 *   3. On successful migration, call `localStorage.removeItem(...)` and
 *      then set the marker — order matters to avoid re-migration after
 *      a partial failure.
 *
 * After the fix, the guards below pass because:
 *   (a) the unconditional read is replaced by a marker-gated read, and
 *   (b) the removal call is reordered to precede the marker-set.
 *
 * As in C6, a true behavioural test requires a renderer harness that
 * boots LoginPage with stubbed IPC — planned for Wave 5. This Wave 0
 * test is a source-level assertion.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

// Tests are bundled by esbuild into `node_modules/.cache/parity-tests/`
// and run with `cwd` = project root. Resolve source paths from cwd so
// the test works both from `node --test` (bundled) and from direct ts
// execution (unbundled).
const projectRoot = process.cwd();
const loginPagePath = path.resolve(projectRoot, 'src', 'renderer', 'pages', 'LoginPage.tsx');

function readLoginPage(): string {
  assert.ok(
    fs.existsSync(loginPagePath),
    `LoginPage.tsx not found at ${loginPagePath} — update this test path if the file moved.`,
  );
  return fs.readFileSync(loginPagePath, 'utf8');
}

test(
  'C7: legacy PIN read is guarded by a "migrated" marker',
  () => {
    const src = readLoginPage();

    // The raw, unconditional read of the legacy key must go away.
    // (Fix-forward wording: accept if the read is absent entirely, or if
    // it appears only inside a block that references a migration marker.)
    const hasRawLegacyRead = /localStorage\s*\.\s*getItem\s*\(\s*['"]staff\.simple_pin['"]\s*\)/.test(
      src,
    );

    if (!hasRawLegacyRead) {
      // Fix has landed — read eliminated. Test passes.
      return;
    }

    // If the read is still present, require an adjacent guard referencing
    // a migration-complete marker. The marker key name is left to the
    // Wave 1 implementation; we look for any string literal containing
    // `migrated` or `migration_complete` in the ±800-char window around
    // the read (before OR after — the guard can appear either way).
    const windowPattern = /([\s\S]{0,800})localStorage\s*\.\s*getItem\s*\(\s*['"]staff\.simple_pin['"]\s*\)([\s\S]{0,400})/;
    const ctxMatch = windowPattern.exec(src);
    const hasMarkerGuard = ctxMatch
      ? /migrated|migration_complete/i.test(ctxMatch[1] + ctxMatch[2])
      : false;

    assert.ok(
      hasMarkerGuard,
      'LoginPage.tsx still reads "staff.simple_pin" from localStorage without an adjacent ' +
        'migration-complete marker guard. Wave 1 C7 must either eliminate the read or gate ' +
        'it behind a persistent `legacy_pin_migrated` flag.',
    );
  },
);

test(
  'C7: migration removes the legacy PIN key before setting the marker',
  () => {
    const src = readLoginPage();

    const hasRemoveCall = /localStorage\s*\.\s*removeItem\s*\(\s*['"]staff\.simple_pin['"]\s*\)/.test(
      src,
    );
    const hasMarkerSet = /(migrated|migration_complete)/i.test(src);

    if (!hasRemoveCall && !hasMarkerSet) {
      // Wave 1 may eliminate the migration path entirely (the legacy
      // PIN shim is removed). In that case neither the remove nor the
      // marker is needed and the test passes.
      return;
    }

    assert.ok(
      hasRemoveCall,
      'LoginPage.tsx references a migration marker but does not call ' +
        '`localStorage.removeItem("staff.simple_pin")`. The legacy key will persist.',
    );

    // Structural ordering: removeItem must appear lexically before the
    // marker-set in the source. A source-level ordering check is a
    // reasonable proxy for runtime ordering because the code executes
    // top-to-bottom within the migration path.
    const removeIdx = src.search(
      /localStorage\s*\.\s*removeItem\s*\(\s*['"]staff\.simple_pin['"]\s*\)/,
    );
    const markerSetIdx = src.search(
      /localStorage\s*\.\s*setItem\s*\(\s*['"][^'"]*(migrated|migration_complete)[^'"]*['"]/i,
    );

    if (markerSetIdx === -1) {
      // Marker is stored somewhere else (e.g. Tauri settings) — we
      // cannot order-check from this file alone. Skip the order
      // assertion.
      return;
    }

    assert.ok(
      removeIdx >= 0 && removeIdx < markerSetIdx,
      'LoginPage.tsx sets the migration marker BEFORE calling removeItem on the legacy PIN ' +
        'key. If the removal fails, the next boot will see the marker and skip the read, ' +
        'leaving the PIN in localStorage forever. Swap the order: removeItem FIRST, then ' +
        'set the marker.',
    );
  },
);
