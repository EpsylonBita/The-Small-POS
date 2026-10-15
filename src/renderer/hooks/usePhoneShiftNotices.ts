/**
 * Live notice on the Main when a phone shift closes (founder rule 13/10/2026:
 * phones always hand over to the Main). Contract:
 * `docs/architecture/phone-shift-handover.md`.
 *
 * A phone shift lives only on the server and the phone, so the Main polls
 * `GET /api/pos/shifts/unit-readiness` and notices each shift that newly
 * appears in `closed_shifts`. PhoneShiftNoticeManager shows the notice.
 *
 * - Main only, with the Z's rule (ZReportModal): a phone (mobile_waiter), a
 *   kiosk or any child terminal never asks. The server refuses non-Mains with
 *   403 `UNIT_READINESS_MAIN_ONLY` anyway.
 * - Every 30 s while the unit has a phone (a child that is not a kiosk:
 *   review 14/10/2026), every 5 min without, plus once when the window
 *   regains focus. Until a read says whether there are phones it retries at
 *   the phone rate. A good read is remembered on this device for the offline
 *   cashier close.
 * - `unsupported` (an older server without the endpoint, or a till the server
 *   says is not a Main) stops polling until the next login: neither changes
 *   while the app runs, and the server deploys before this release.
 * - A failed read is silent and keeps what was already seen; it never means
 *   "no phone shifts".
 * - Each shift is noticed once. Its id is kept in localStorage (the last 200)
 *   so a reload does not repeat it; the first read after start takes the
 *   shifts that closed before this hook started as already seen.
 */
import { useEffect, useRef } from 'react';
import { getBridge } from '../../lib';
import { useFeatures } from './useFeatures';
import {
  readUnitShiftReadinessRemembered,
  unitHasPhones,
  type UnitClosedShift,
} from '../utils/unit-shift-readiness';

/** Opens the staff modal (StaffShiftModal, check-in mode) from GlobalCashierGate. */
export const PHONE_SHIFT_STAFF_OPEN_EVENT = 'pos:open-phone-shift-staff';

export const PHONE_SHIFT_POLL_WITH_PHONES_MS = 30_000;
export const PHONE_SHIFT_POLL_WITHOUT_PHONES_MS = 5 * 60_000;
export const PHONE_SHIFT_NOTIFIED_STORAGE_KEY = 'pos.phoneShiftNotices.notified.v1';
export const PHONE_SHIFT_NOTIFIED_CAP = 200;

function loadNotified(): string[] {
  try {
    const raw = localStorage.getItem(PHONE_SHIFT_NOTIFIED_STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((id): id is string => typeof id === 'string' && id.length > 0)
      .slice(-PHONE_SHIFT_NOTIFIED_CAP);
  } catch {
    return [];
  }
}

function saveNotified(ids: string[]): void {
  try {
    localStorage.setItem(PHONE_SHIFT_NOTIFIED_STORAGE_KEY, JSON.stringify(ids.slice(-PHONE_SHIFT_NOTIFIED_CAP)));
  } catch {
    // Storage unavailable: this session still remembers them in memory.
  }
}

/** The Z's Main rule: a Main, or a legacy terminal with no type and no parent. */
export function isPhoneShiftNoticeTerminal(features: {
  isMainTerminal: boolean;
  isMobileWaiter: boolean;
  parentTerminalId: string | null;
  loading: boolean;
}): boolean {
  if (features.loading || features.isMobileWaiter) return false;
  return features.isMainTerminal || !features.parentTerminalId;
}

/**
 * The closed shifts to notice now, and every id now seen. On the seeding read,
 * a shift that neither closed nor was received after `startedAt` (or whose
 * times are unknown) is seen without a notice, the Z's window rule
 * (re-review 15/10/2026); on later reads every unseen shift is new.
 */
export function selectPhoneShiftNotices(
  closedShifts: UnitClosedShift[],
  seen: ReadonlySet<string>,
  seeding: boolean,
  startedAt: number,
): { notify: UnitClosedShift[]; seenIds: string[] } {
  const notify: UnitClosedShift[] = [];
  const seenIds: string[] = [];
  for (const shift of closedShifts) {
    if (seen.has(shift.id) || seenIds.includes(shift.id)) continue;
    seenIds.push(shift.id);
    const after = (moment: string | null) => {
      const ms = moment ? Date.parse(moment) : Number.NaN;
      return Number.isFinite(ms) && ms >= startedAt;
    };
    if (seeding && !after(shift.check_out_time) && !after(shift.received_at)) continue;
    notify.push(shift);
  }
  return { notify, seenIds };
}

export function usePhoneShiftNotices(enabled: boolean, onClosed: (shift: UnitClosedShift) => void): void {
  const { isMainTerminal, isMobileWaiter, parentTerminalId, loading } = useFeatures();
  const active = enabled && isPhoneShiftNoticeTerminal({ isMainTerminal, isMobileWaiter, parentTerminalId, loading });
  const startedAt = useRef(Date.now());
  const notifyRef = useRef(onClosed);
  notifyRef.current = onClosed;
  // Kept across effect restarts (a terminal-config change) so nothing repeats.
  const notified = useRef<string[] | null>(null);
  const seeded = useRef(false);

  useEffect(() => {
    if (!active) return;
    const shifts = getBridge().shifts;
    if (!notified.current) notified.current = loadNotified();
    const ids = notified.current;
    const seen = new Set(ids);
    let cancelled = false;
    let stopped = false;
    let inFlight = false;
    let interval = PHONE_SHIFT_POLL_WITH_PHONES_MS;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const schedule = () => {
      clearTimeout(timer);
      if (!cancelled && !stopped) timer = setTimeout(() => { void poll(); }, interval);
    };

    const poll = async () => {
      if (cancelled || stopped || inFlight) return;
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
        schedule();
        return;
      }
      inFlight = true;
      clearTimeout(timer);
      try {
        const { result } = await readUnitShiftReadinessRemembered(shifts, null);
        if (cancelled) return;
        if (result.kind === 'unsupported') {
          stopped = true;
          return;
        }
        if (result.kind !== 'ready') return;
        const { readiness } = result;
        interval = unitHasPhones(readiness)
          ? PHONE_SHIFT_POLL_WITH_PHONES_MS
          : PHONE_SHIFT_POLL_WITHOUT_PHONES_MS;
        const { notify, seenIds } = selectPhoneShiftNotices(
          readiness.closedShifts, seen, !seeded.current, startedAt.current,
        );
        seeded.current = true;
        if (seenIds.length > 0) {
          for (const id of seenIds) seen.add(id);
          ids.push(...seenIds);
          if (ids.length > PHONE_SHIFT_NOTIFIED_CAP) ids.splice(0, ids.length - PHONE_SHIFT_NOTIFIED_CAP);
          saveNotified(ids);
        }
        for (const shift of notify) {
          try {
            notifyRef.current(shift);
          } catch (error) {
            console.warn('[usePhoneShiftNotices] notice failed:', error);
          }
        }
      } finally {
        inFlight = false;
        schedule();
      }
    };

    const onFocus = () => { void poll(); };
    window.addEventListener('focus', onFocus);
    void poll();
    return () => {
      cancelled = true;
      clearTimeout(timer);
      window.removeEventListener('focus', onFocus);
    };
  }, [active, isMainTerminal, parentTerminalId]);
}

export default usePhoneShiftNotices;
