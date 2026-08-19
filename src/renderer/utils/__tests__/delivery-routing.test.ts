import { describe, expect, it } from 'vitest';

import {
  buildGoogleMapsDirectionsUrl,
  createTerminalSettingGetter,
  resolveStoreMapOrigin,
  withStoreCityContext,
} from '../delivery-routing';

// Two betrayals, one day apart (2026-08-18/19), decided this policy:
// - Stale coordinates pointed ~660m off, so routes departed from whatever
//   street Google reverse-named off the rotten point → we flipped the origin
//   to address-first.
// - The very next day the TEXT betrayed too: Google resolved the written
//   «ΚΩΝΣΤΑΝΤΙΝΟΥΠΟΛΕΩΣ 62» onto the RENAMED «Γιάννη Χαλκίδη 62» in another
//   neighborhood, ~2.5km from the shop.
// Coordinates verified against the shop's own Google listing are immune to
// renames and homonym streets, so once corrected at the source they WIN; the
// written address stays as the fallback for a branch without coordinates.
describe('store origin maps value', () => {
  const settings = {
    'terminal.store_address': 'ΚΩΝΣΤΑΝΤΙΝΟΥΠΟΛΕΩΣ 62, ΘΕΣΣΑΛΟΝΙΚΗ',
    'terminal.store_name': 'ΤΟ ΜΙΚΡΟ ΠΑΡΙΣΙ',
    'terminal.store_latitude': '40.6140334',
    'terminal.store_longitude': '22.9602723',
  };

  it('prefers verified coordinates over the rename-prone address text', () => {
    const origin = resolveStoreMapOrigin(createTerminalSettingGetter(settings));
    const url = buildGoogleMapsDirectionsUrl(origin, {
      address: 'Πλαταιών 38, Θεσσαλονίκη',
      coordinates: null,
    });

    expect(url).toContain('google.com/maps/dir/');
    expect(url).toContain('origin=40.6140334%2C22.9602723');
    // The written address must not be the departure point while coordinates
    // exist — Google resolves renamed streets somewhere else entirely.
    expect(url).not.toContain(encodeURIComponent('ΚΩΝΣΤΑΝΤΙΝΟΥΠΟΛΕΩΣ'));
  });

  it('falls back to the written address for a store without coordinates', () => {
    const origin = resolveStoreMapOrigin(
      createTerminalSettingGetter({
        'terminal.store_address': 'ΚΩΝΣΤΑΝΤΙΝΟΥΠΟΛΕΩΣ 62, ΘΕΣΣΑΛΟΝΙΚΗ',
      }),
    );
    const url = buildGoogleMapsDirectionsUrl(origin, {
      address: 'Πλαταιών 38, Θεσσαλονίκη',
      coordinates: null,
    });

    expect(url).toContain(
      `origin=${encodeURIComponent('ΚΩΝΣΤΑΝΤΙΝΟΥΠΟΛΕΩΣ 62, ΘΕΣΣΑΛΟΝΙΚΗ').replace(/%20/g, '+')}`,
    );
  });

  it('degrades to a destination-only search when no origin exists at all', () => {
    const url = buildGoogleMapsDirectionsUrl(null, {
      address: 'Πλαταιών 38, Θεσσαλονίκη',
      coordinates: null,
    });

    expect(url).toContain('google.com/maps/search/');
  });
});

// A destination like «Πλαταιών 38» with no city rides only on Google's IP
// bias — the same street exists in other cities. The stop borrows the city
// tail from the store's written address.
describe('bare destination city context', () => {
  const settings = {
    'terminal.store_address': 'ΚΩΝΣΤΑΝΤΙΝΟΥΠΟΛΕΩΣ 62, ΘΕΣΣΑΛΟΝΙΚΗ',
    'terminal.store_latitude': '40.6140334',
    'terminal.store_longitude': '22.9602723',
  };

  it('appends the store city to a bare street destination', () => {
    const origin = resolveStoreMapOrigin(createTerminalSettingGetter(settings));
    const url = buildGoogleMapsDirectionsUrl(origin, {
      address: 'Πλαταιών 38',
      coordinates: null,
    });

    expect(url).toContain(
      `destination=${encodeURIComponent('Πλαταιών 38, ΘΕΣΣΑΛΟΝΙΚΗ').replace(/%20/g, '+')}`,
    );
  });

  it('leaves a destination that already carries context untouched', () => {
    expect(
      withStoreCityContext('Πλαταιών 38, Καλαμαριά', 'ΚΩΝΣΤΑΝΤΙΝΟΥΠΟΛΕΩΣ 62, ΘΕΣΣΑΛΟΝΙΚΗ'),
    ).toBe('Πλαταιών 38, Καλαμαριά');
  });

  it('leaves the destination untouched when the store address has no city tail', () => {
    expect(withStoreCityContext('Πλαταιών 38', 'ΚΩΝΣΤΑΝΤΙΝΟΥΠΟΛΕΩΣ 62')).toBe('Πλαταιών 38');
  });

  it('never rides city context on top of exact stop coordinates', () => {
    const origin = resolveStoreMapOrigin(createTerminalSettingGetter(settings));
    const url = buildGoogleMapsDirectionsUrl(origin, {
      address: 'Πλαταιών 38',
      coordinates: { lat: 40.61, lng: 22.95 },
    });

    expect(url).toContain('destination=40.61%2C22.95');
  });
});
