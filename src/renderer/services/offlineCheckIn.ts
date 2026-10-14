/**
 * The desktop's staff check-in without a connection (founder decision
 * 13/10/2026; Android parity with PR #356, `StaffShiftModal` offline
 * check-in).
 *
 * The native `staff-auth:verify-check-in-pin` asks the server first and its
 * answer stands. Only when the server cannot be reached does the till check
 * the PIN against the hash it holds in the OS credential store; the answer
 * then says `source: 'offline'`. The native shift open enforces the rules
 * itself (`offline_check_in.rs`); this module only words them and keeps the
 * modal from offering what the till will refuse.
 */
import type { TFunction } from 'i18next';

/** The roles a till checks in without the server; every other role needs it. */
export const OFFLINE_CHECK_IN_ROLES: readonly string[] = ['cashier', 'manager', 'driver'];

export const isOfflineCheckInRole = (role: string | null | undefined): boolean =>
  OFFLINE_CHECK_IN_ROLES.includes(String(role ?? '').trim().toLowerCase());

/** A check-in answer whose PIN this till checked itself. */
export const checkedOnTill = (answer: unknown): boolean =>
  !!answer && typeof answer === 'object' && (answer as { source?: unknown }).source === 'offline';

export const offlineRoleNotAllowedMessage = (t: TFunction): string =>
  t(
    'modals.staffShift.offlineCheckIn.roleNotAllowed',
    'Without a connection, only a cashier, manager or driver can check in on this till.',
  );

export const offlineGiftCardsMessage = (t: TFunction): string =>
  t(
    'modals.staffShift.offlineCheckIn.giftCardsNeedServer',
    'With gift cards, opening the drawer needs the server. Check in once the connection is back.',
  );

/** The native shift-open refusals of an offline check-in, worded; null otherwise. */
export function describeOfflineOpeningRefusal(error: string, t: TFunction): string | null {
  switch (error) {
    case 'OFFLINE_CHECK_IN_ROLE_NOT_ALLOWED':
      return offlineRoleNotAllowedMessage(t);
    case 'OFFLINE_CHECK_IN_GIFT_CARDS_NEED_SERVER':
      return offlineGiftCardsMessage(t);
    case 'OFFLINE_CHECK_IN_WAITER_TERMINAL':
      return t(
        'modals.staffShift.offlineCheckIn.waiterPhone',
        'A waiter phone checks staff in through the server. Try again once the connection is back.',
      );
    default:
      return null;
  }
}

interface CachedModulesBridge {
  modules: { getCached(): Promise<unknown> };
}

/**
 * Whether the store sells gift cards, from the module list this till cached
 * (Android: `ModuleSyncService.isModuleEnabled('gift_cards')`). It answers
 * without the server; unknown is "no", as there.
 */
export async function cachedGiftCardsStore(bridge: CachedModulesBridge): Promise<boolean> {
  try {
    const cached = (await bridge.modules.getCached()) as {
      success?: boolean;
      modules?: { modules?: unknown };
    } | null;
    const modules = cached?.success === true ? cached.modules?.modules : null;
    return Array.isArray(modules) && modules.some(
      (module) => !!module && typeof module === 'object' &&
        (module as { module_id?: unknown }).module_id === 'gift_cards',
    );
  } catch {
    return false;
  }
}
