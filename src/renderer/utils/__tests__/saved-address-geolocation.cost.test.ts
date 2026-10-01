import { describe, it, expect, vi } from 'vitest';
vi.mock('../../services/address-workflow', () => ({ createAddressSessionToken: vi.fn(), extractStreetNumber: vi.fn(), houseNumbersMatch: vi.fn(), resolveAddressSuggestion: vi.fn(), searchAddressSuggestions: vi.fn() }));
import { extractSavedAddressCoordinates } from '../saved-address-geolocation';
describe('saved delivery coordinate reuse', () => {
  it('does not convert null/empty/zero placeholders into an address point', () => {
    for (const coordinates of [{ lat: null, lng: null }, { lat: '', lng: '' }, { lat: 0, lng: 0 }, { lat: 100, lng: 20 }]) {
      expect(extractSavedAddressCoordinates({ coordinates } as any)).toBeNull();
    }
    expect(extractSavedAddressCoordinates({ latitude: null, longitude: null })).toBeNull();
  });
  it('reuses fresh Google data, expires it, and preserves manual/provider points', () => {
    const address = { google_place_id: 'google-id', latitude: 40, longitude: 22, geocoded_at: new Date().toISOString() };
    expect(extractSavedAddressCoordinates(address)).toEqual({ lat: 40, lng: 22 });
    expect(extractSavedAddressCoordinates({ ...address, geocoded_at: '2020-01-01' })).toBeNull();
    expect(extractSavedAddressCoordinates({ ...address, geocoded_at: null })).toBeNull();
    expect(extractSavedAddressCoordinates({ coordinate_source: 'manual', latitude: 0, longitude: 22 })).toEqual({ lat: 0, lng: 22 });
  });
});
