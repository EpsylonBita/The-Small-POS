import { describe, expect, it, vi } from 'vitest';
import type { TFunction } from 'i18next';

import { localeBundles } from '../../../locales/bundles';
import {
  cachedGiftCardsStore,
  checkedOnTill,
  describeOfflineOpeningRefusal,
  giftCardOrdinaryOpeningMessage,
} from '../offlineCheckIn';

const t = ((key: string) => `<${key}>`) as unknown as TFunction;

describe('offline check-in rules (renderer)', () => {
  it('tells a PIN this till checked from one the server checked', () => {
    expect(checkedOnTill({ success: true, source: 'offline' })).toBe(true);
    expect(checkedOnTill({ success: true, source: 'server' })).toBe(false);
    expect(checkedOnTill(null)).toBe(false);
  });

  it('words each native offline opening refusal and nothing else', () => {
    // The native shift open no longer refuses a role offline, nor a gift-card
    // store's cashier (Ω7, founder 21/10/2026: an ordinary drawer, reviewed).
    expect(describeOfflineOpeningRefusal('OFFLINE_CHECK_IN_ROLE_NOT_ALLOWED', t)).toBeNull();
    expect(describeOfflineOpeningRefusal('OFFLINE_CHECK_IN_GIFT_CARDS_NEED_SERVER', t)).toBeNull();
    expect(describeOfflineOpeningRefusal('OFFLINE_CHECK_IN_WAITER_TERMINAL', t)).toBe('<modals.staffShift.offlineCheckIn.waiterPhone>');
    expect(describeOfflineOpeningRefusal('Staff member already has an active shift (x)', t)).toBeNull();
    expect(giftCardOrdinaryOpeningMessage(t)).toBe('<modals.staffShift.offlineCheckIn.giftCardOrdinaryOpening>');
  });

  it('reads a gift-card store from the cached module list, unknown as "no"', async () => {
    const bridge = (answer: unknown) => ({ modules: { getCached: vi.fn(async () => answer) } });
    await expect(cachedGiftCardsStore(bridge({ success: true, modules: { modules: [{ module_id: 'gift_cards' }] } }))).resolves.toBe(true);
    await expect(cachedGiftCardsStore(bridge({ success: true, modules: { modules: [{ module_id: 'tables' }] } }))).resolves.toBe(false);
    await expect(cachedGiftCardsStore(bridge({ success: false, modules: null }))).resolves.toBe(false);
    await expect(cachedGiftCardsStore({ modules: { getCached: vi.fn(async () => { throw new Error('ipc'); }) } })).resolves.toBe(false);
  });

  it('has every offline check-in sentence in all six languages', () => {
    const keys = [
      'offlineCheckIn.checkedInTitle', 'offlineCheckIn.checkedInMessage',
      'offlineCheckIn.giftCardOrdinaryOpening', 'offlineCheckIn.noPinOnTill', 'offlineCheckIn.locked',
      'offlineCheckIn.waiterPhone', 'pinLocked', 'staffNotFound', 'rateLimited', 'checkInUnavailable',
      'syncConflict.offlineTitle', 'syncConflict.reason.waiter_terminal', 'syncConflict.reason.staff_not_found',
      'syncConflict.reason.active_shift_elsewhere', 'syncConflict.reason.unresolved_shift',
      'syncConflict.reason.unknown', 'syncConflict.shiftTitle', 'syncConflict.shiftBody', 'syncConflict.review',
    ];
    const english = localeBundles.en as any;
    for (const [language, bundle] of Object.entries(localeBundles)) {
      for (const key of keys) {
        const value = key.split('.').reduce((node: any, part) => node?.[part], (bundle as any).modals.staffShift);
        expect(typeof value === 'string' && value.trim().length > 0, `${language}: ${key}`).toBe(true);
        if (language !== 'en') {
          const englishValue = key.split('.').reduce((node: any, part) => node?.[part], english.modals.staffShift);
          expect(value, `${language}: ${key} is translated`).not.toBe(englishValue);
        }
      }
      // The role refusal is gone with the role list, the gift-card one with Ω7.
      expect((bundle as any).modals.staffShift.offlineCheckIn?.roleNotAllowed, language).toBeUndefined();
      expect((bundle as any).modals.staffShift.offlineCheckIn?.giftCardsNeedServer, language).toBeUndefined();
    }
  });
});
