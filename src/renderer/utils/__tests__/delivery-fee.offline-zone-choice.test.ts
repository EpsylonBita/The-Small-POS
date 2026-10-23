import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Offline week Ω6β (coordinator decision 22/10/2026). Symptom: offline, a
// saved address whose Google point is older than 28 days (FIX-03) could not be
// located; its zone was "not checked" and the order went out with delivery
// fee 0. The cashier now chooses the zone from the store's cached zones and
// the order carries a "zone chosen manually" marker. Synthetic data only.

const mocks = vi.hoisted(() => ({
  offline: false,
  search: vi.fn(),
  resolve: vi.fn(),
}));

vi.mock('../../services/server-reachability', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/server-reachability')>()),
  isTillKnownOffline: () => mocks.offline,
}));

vi.mock('../../services/address-workflow', async () => {
  const houseNumber = await import('../../services/address-house-number');
  return {
    ...houseNumber,
    createAddressSessionToken: () => 'addr_session_test',
    searchAddressSuggestions: mocks.search,
    resolveAddressSuggestion: mocks.resolve,
  };
});

import {
  canCheckoutWithDeliveryFeeStatus,
  createManualDeliveryZoneResult,
  createUncheckedDeliveryZoneResult,
  deliveryZoneSelectionMetadata,
  getDeliveryFeeStatus,
  isDeliveryZoneUnchecked,
  readManualDeliveryZoneSelection,
  resolveDeliveryFee,
} from '../delivery-fee';
import {
  clearSavedAddressGeolocationMemo,
  extractSavedAddressCoordinates,
  isUnlocatedZoneAddress,
  resolveSavedAddressCoordinates,
} from '../saved-address-geolocation';
import {
  isSavedGooglePointExpired,
  readDeliveryZoneSelection,
  readManualDeliveryZoneOptions,
} from '../../../../../shared/utils/offline-delivery-zone';

const DAY = 86_400_000;
const zoneB = { id: 'zone-b', name: 'Zone B', deliveryFee: 2.5, minimumOrderAmount: 10 };

function expiredGoogleAddress() {
  return {
    id: 'addr-1',
    street_address: 'Odos Dokimis 12',
    city: 'Kalamaria',
    postal_code: '55133',
    latitude: 40.5836,
    longitude: 22.9502,
    coordinate_source: 'google',
    google_place_id: 'place-test-1',
    geocoded_at: new Date(Date.now() - 40 * DAY).toISOString(),
  };
}

beforeEach(() => {
  mocks.offline = false;
  mocks.search.mockReset();
  mocks.resolve.mockReset();
  clearSavedAddressGeolocationMemo();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('negative control: the old offline path', () => {
  it('lets the order out with fee 0 when the zone of an unlocatable address is "not checked"', () => {
    // What the menu answered offline before Ω6β for an address it could not
    // locate: not checked, checkout allowed, fee 0. The cashier never chose.
    const oldAnswer = createUncheckedDeliveryZoneResult();
    const status = getDeliveryFeeStatus('delivery', oldAnswer);
    expect(status).toBe('not_checked');
    expect(canCheckoutWithDeliveryFeeStatus(status)).toBe(true);
    expect(resolveDeliveryFee(oldAnswer)).toBe(0);
  });

  it('a zone choice is still required: the new status blocks checkout until the cashier chooses', () => {
    expect(canCheckoutWithDeliveryFeeStatus('requires_zone_choice')).toBe(false);
  });
});

describe('the 28-day Google point rule', () => {
  it('never uses the expired point, so the address is one that must be located again', () => {
    const address = expiredGoogleAddress();
    expect(isSavedGooglePointExpired(address)).toBe(true);
    expect(extractSavedAddressCoordinates(address)).toBeNull();
    expect(isUnlocatedZoneAddress(address)).toBe(true);
  });

  it('keeps a fresh Google point (≤28 days) and manual/provider points', () => {
    const fresh = { ...expiredGoogleAddress(), geocoded_at: new Date(Date.now() - 5 * DAY).toISOString() };
    expect(isSavedGooglePointExpired(fresh)).toBe(false);
    expect(extractSavedAddressCoordinates(fresh)).toEqual({ lat: 40.5836, lng: 22.9502 });
    expect(isSavedGooglePointExpired({ ...fresh, coordinate_source: 'manual', geocoded_at: null })).toBe(false);
    expect(isSavedGooglePointExpired({ ...fresh, coordinate_source: 'provider', geocoded_at: null })).toBe(false);
    expect(isSavedGooglePointExpired({ ...fresh, geocoded_at: new Date(Date.now() + DAY).toISOString() })).toBe(true);
  });
});

describe('locating a saved address offline', () => {
  it('never searches offline: the offline cache could hand back the expired point', async () => {
    mocks.offline = true;
    const resolved = await resolveSavedAddressCoordinates(expiredGoogleAddress(), 'branch-1');
    expect(resolved).toBeNull();
    expect(mocks.search).not.toHaveBeenCalled();
  });

  it('never accepts an offline-cache answer, even when the browser still reports a network', async () => {
    mocks.search.mockResolvedValue([{
      place_id: 'local-address-1',
      name: 'Odos Dokimis 12',
      displayLabel: 'Odos Dokimis 12',
      formatted_address: 'Odos Dokimis 12, Kalamaria, 55133',
      city: 'Kalamaria',
      postal_code: '55133',
      source: 'offline_cache',
    }]);
    // The cached copy of the saved address, with its expired point.
    mocks.resolve.mockResolvedValue({
      streetAddress: 'Odos Dokimis 12',
      city: 'Kalamaria',
      postalCode: '55133',
      coordinates: { lat: 40.5836, lng: 22.9502 },
      resolvedStreetNumber: '12',
      validationSource: 'offline_cache',
    });
    const resolved = await resolveSavedAddressCoordinates(expiredGoogleAddress(), 'branch-1');
    expect(mocks.resolve).toHaveBeenCalled();
    expect(resolved).toBeNull();
  });

  it('online is unchanged: an accepted online point is used', async () => {
    mocks.search.mockResolvedValue([{
      place_id: 'place-in-area',
      name: 'Odos Dokimis 12',
      displayLabel: 'Odos Dokimis 12',
      main_text: 'Odos Dokimis 12',
      secondary_text: 'Kalamaria 551 33',
      formatted_address: 'Odos Dokimis 12, Kalamaria 551 33',
      source: 'online',
    }]);
    mocks.resolve.mockResolvedValue({
      streetAddress: 'Odos Dokimis 12',
      city: 'Kalamaria',
      postalCode: '551 33',
      coordinates: { lat: 40.5841, lng: 22.9511 },
      resolvedStreetNumber: '12',
      validationSource: 'online',
    });
    const resolved = await resolveSavedAddressCoordinates(expiredGoogleAddress(), 'branch-1');
    expect(resolved).toMatchObject({ source: 'geocoded', coordinates: { lat: 40.5841, lng: 22.9511 } });
  });
});

describe('the zone the cashier chose', () => {
  it('reads the cached zones: active zones with a fee, in the cached order', () => {
    const cached = {
      success: true,
      data: {
        success: true,
        zones: [
          { id: 'zone-a', name: 'Zone A', delivery_fee: 1, minimum_order_amount: 5, is_active: true },
          { id: 'zone-b', name: 'Zone B', fee: 2.5, min_order_amount: 10, is_active: true },
          { id: 'zone-off', name: 'Closed', delivery_fee: 3, is_active: false },
          { id: 'zone-x', name: 'No fee field', is_active: true },
        ],
      },
      meta: { source: 'cache' },
    };
    expect(readManualDeliveryZoneOptions(cached)).toEqual([
      { id: 'zone-a', name: 'Zone A', deliveryFee: 1, minimumOrderAmount: 5 },
      { id: 'zone-b', name: 'Zone B', deliveryFee: 2.5, minimumOrderAmount: 10 },
    ]);
  });

  it('applies the chosen zone fee and minimum, and never reads as "not checked"', () => {
    const answer = createManualDeliveryZoneResult(zoneB);
    expect(isDeliveryZoneUnchecked(answer)).toBe(false);
    expect(getDeliveryFeeStatus('delivery', answer)).toBe('resolved');
    expect(resolveDeliveryFee(answer)).toBe(2.5);
    expect(answer.zone).toMatchObject({ id: 'zone-b', name: 'Zone B', minimumOrderAmount: 10 });
    expect(readManualDeliveryZoneSelection(answer)).toEqual({
      source: 'manual',
      reason: 'offline_address_not_located',
      zone_id: 'zone-b',
      zone_name: 'Zone B',
      delivery_fee: 2.5,
    });
  });

  it('puts the marker in the order metadata of a delivery, merged with existing metadata', () => {
    const answer = createManualDeliveryZoneResult(zoneB);
    const metadata = deliveryZoneSelectionMetadata(null, 'delivery', answer);
    expect(readDeliveryZoneSelection(metadata)).toMatchObject({ source: 'manual', zone_id: 'zone-b', delivery_fee: 2.5 });
    expect(deliveryZoneSelectionMetadata({ trigger_code: 'X/1' }, 'delivery', answer)).toEqual({
      trigger_code: 'X/1',
      delivery_zone_selection: readManualDeliveryZoneSelection(answer),
    });
  });

  it('leaves every other order exactly as before', () => {
    const answer = createManualDeliveryZoneResult(zoneB);
    expect(deliveryZoneSelectionMetadata(null, 'pickup', answer)).toBeNull();
    const checked = { success: true, isValid: true, zone: { id: 'zone-1', name: 'Zone 1', deliveryFee: 1.5 } };
    expect(deliveryZoneSelectionMetadata(null, 'delivery', checked)).toBeNull();
    expect(deliveryZoneSelectionMetadata(null, 'delivery', createUncheckedDeliveryZoneResult())).toBeNull();
    const ghost = { trigger_code: 'X/1' };
    expect(deliveryZoneSelectionMetadata(ghost, 'delivery', checked)).toBe(ghost);
  });
});
