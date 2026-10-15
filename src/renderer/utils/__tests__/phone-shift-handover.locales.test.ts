/**
 * Phones hand over to the Main (founder rule 13/10/2026): every string of the
 * phone-shift screens (Z, staff modal, live notice, Recovery Center) lives in
 * the `phone-shift-handover` overlay, in all six languages. The base locale
 * parity script does not read overlays, so this pins them: the same keys and
 * placeholders in every language, and every key the code uses resolves in
 * every runtime bundle (never a raw key on screen).
 */
import { describe, expect, it } from 'vitest';
import { localeBundles } from '../../../locales/bundles';
import en from '../../../locales/overlays/en.phone-shift-handover.json';
import el from '../../../locales/overlays/el.phone-shift-handover.json';
import de from '../../../locales/overlays/de.phone-shift-handover.json';
import fr from '../../../locales/overlays/fr.phone-shift-handover.json';
import it_ from '../../../locales/overlays/it.phone-shift-handover.json';
import sq from '../../../locales/overlays/sq.phone-shift-handover.json';
import { UNIT_SHIFT_HANDOVER_STATES } from '../unit-shift-readiness';

const overlays = { en, el, de, fr, it: it_, sq } as const;

function flatten(value: unknown, prefix = '', out: Record<string, string> = {}): Record<string, string> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const [key, nested] of Object.entries(value)) {
      flatten(nested, prefix ? `${prefix}.${key}` : key, out);
    }
  } else {
    out[prefix] = String(value);
  }
  return out;
}

const placeholders = (text: string) => (text.match(/{{\s*\w+\s*}}/g) ?? []).map((p) => p.replace(/\s/g, '')).sort();

const USED_KEYS = [
  'phoneShifts.title',
  'phoneShifts.unavailable',
  'phoneShifts.retry',
  'phoneShifts.checkedInAt',
  'phoneShifts.phoneDeactivated',
  'phoneShifts.phoneRemoved',
  ...UNIT_SHIFT_HANDOVER_STATES.map((state) => `phoneShifts.handover.${state}`),
  'modals.zReport.phoneShifts.checking',
  'modals.zReport.phoneShifts.openDescription',
  'modals.zReport.phoneShifts.noneOpen',
  'modals.zReport.phoneShifts.closeAction',
  'modals.zReport.phoneShifts.pendingReturnsTitle',
  'modals.zReport.phoneShifts.pendingReturnsDescription',
  'modals.zReport.phoneShifts.returnLine',
  'modals.zReport.phoneShifts.refusedOpen',
  'modals.zReport.phoneShifts.refusedOpenUnnamed',
  'modals.zReport.phoneShifts.refusedUnavailable',
  'modals.zReport.phoneShifts.countedCash',
  'modals.staffShift.phoneShifts.openBlocker',
  'modals.staffShift.phoneShifts.shiftEntry',
  'modals.staffShift.phoneShifts.receiveBlocker',
  'modals.staffShift.phoneShifts.tillEntry',
  'modals.staffShift.phoneShifts.managerSettles',
  'modals.staffShift.phoneShifts.openHelper',
  'modals.staffShift.phoneShifts.closeHere',
  'notices.phoneShift.closed',
  'notices.phoneShift.closedByMain',
  'notices.phoneShift.summary',
  'notices.phoneShift.cashToReceive',
  'notices.phoneShift.receivedAmount',
  'notices.phoneShift.received',
  'notices.phoneShift.openStaff',
  'recovery.messages.phoneShiftRemoteCheckoutRequired',
  // Review 14/10/2026.
  'sync.blockerReasons.zReportUnitShiftsOpen',
  'sync.blockerReasons.zReportUnitShiftsOpenUnnamed',
  'recovery.issues.zReportHeldForPhoneShifts.title',
  'recovery.issues.zReportHeldForPhoneShifts.summary',
  'recovery.issues.zReportHeldForPhoneShifts.summaryUnnamed',
  'recovery.issues.zReportHeldForPhoneShifts.guidance',
  'modals.staffShift.phoneShifts.lastChecked',
  'modals.staffShift.phoneShifts.lastCheckedBlocker',
  'modals.staffShift.phoneShifts.lastSeenStale',
  'modals.staffShift.phoneShifts.lastSeenUnknown',
  // Founder decision 15/10/2026: the Main always receives.
  'modals.staffShift.phoneShifts.needsCashier',
  ...['action', 'explain', 'reason', 'reasonHint', 'closed', 'closedNotCounted', 'alreadyClosed']
    .map((key) => `modals.staffShift.phoneShifts.closeWithoutHandover.${key}`),
  ...['reasonRequired', 'pinRequired', 'wrongPin', 'notStaff', 'approvalRequired', 'mainOnly', 'offline', 'failed']
    .map((key) => `modals.staffShift.phoneShifts.closeWithoutHandover.errors.${key}`),
];

describe('phone-shift handover locales', () => {
  const english = flatten(en);

  it.each(Object.entries(overlays))('%s has the same keys and placeholders as English', (_, overlay) => {
    const translated = flatten(overlay);
    expect(Object.keys(translated).sort()).toEqual(Object.keys(english).sort());
    for (const [key, text] of Object.entries(translated)) {
      expect(text.trim(), key).not.toBe('');
      expect(placeholders(text), key).toEqual(placeholders(english[key]));
    }
  });

  it.each(Object.entries(localeBundles))('every key the code uses resolves in the %s bundle', (_, bundle) => {
    const resolved = flatten(bundle);
    for (const key of USED_KEYS) {
      expect(typeof resolved[key], key).toBe('string');
    }
  });

  it('every key the code uses is in the overlay', () => {
    for (const key of USED_KEYS) {
      expect(english[key], key).toBeTypeOf('string');
    }
  });
});
