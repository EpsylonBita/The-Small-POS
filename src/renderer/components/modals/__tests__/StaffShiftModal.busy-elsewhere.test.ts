/**
 * The "checked in on another terminal" refusal must say WHEN.
 *
 * Field failure (Tomikro Parisi Creperie, 2026-08-25): a cashier was reported
 * busy on the Test Terminal for twenty days. The backend had been sending
 * `busyCheckedInAt` all along — `check_in_busy_elsewhere_failure` in
 * src-tauri/src/auth.rs puts it on the payload — but this modal's message
 * builder dropped it, so a shift stuck open since August read exactly like one
 * opened five minutes ago and nobody could tell from the text.
 *
 * A business day here runs check-in -> Z for as long as it takes, so the date is
 * SHOWN, never used to hide the shift. These assertions are the guard on that:
 * the dated branch must exist, must be reachable before the undated fallback,
 * and its key must be translated everywhere.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const MODAL_SOURCE = readFileSync(resolve(__dirname, '..', 'StaffShiftModal.tsx'), 'utf8');
const LOCALES = ['en', 'el', 'de', 'fr', 'it'] as const;

describe('StaffShiftModal busy-elsewhere refusal', () => {
  it('reads busyCheckedInAt off the failure payload', () => {
    expect(MODAL_SOURCE).toContain('busyCheckedInAt');
    // Declared on the argument type too, or TypeScript would never surface it.
    expect(MODAL_SOURCE).toMatch(/busyCheckedInAt\?: unknown;/);
  });

  it('prefers the dated message and falls back to the undated one', () => {
    const branchStart = MODAL_SOURCE.indexOf("case 'staff_busy_elsewhere':");
    expect(branchStart).toBeGreaterThan(-1);

    const datedIndex = MODAL_SOURCE.indexOf(
      'modals.staffShift.busyElsewhereSince',
      branchStart,
    );
    const undatedIndex = MODAL_SOURCE.indexOf("t('modals.staffShift.busyElsewhere'", branchStart);

    expect(datedIndex).toBeGreaterThan(branchStart);
    // The dated return has to come first, or it is dead code.
    expect(datedIndex).toBeLessThan(undatedIndex);

    // An unparseable timestamp must not render "Invalid Date" at a cashier.
    const branch = MODAL_SOURCE.slice(branchStart, undatedIndex);
    expect(branch).toContain('Number.isNaN');
  });

  it('translates the dated message in every locale', () => {
    for (const locale of LOCALES) {
      const bundle = JSON.parse(
        readFileSync(
          resolve(__dirname, '..', '..', '..', '..', 'locales', `${locale}.json`),
          'utf8',
        ),
      ) as { modals?: { staffShift?: Record<string, string> } };
      const value = bundle.modals?.staffShift?.busyElsewhereSince;

      expect(value, `${locale} is missing modals.staffShift.busyElsewhereSince`).toBeTruthy();
      // All three interpolations must survive translation, or the operator gets
      // a sentence with holes in it.
      for (const token of ['{{terminal}}', '{{role}}', '{{since}}']) {
        expect(value, `${locale} lost ${token}`).toContain(token);
      }
    }
  });
});
