import { describe, expect, it } from 'vitest';

import {
  buildGoogleMapsDirectionsUrl,
  createTerminalSettingGetter,
  resolveStoreMapOrigin,
} from '../delivery-routing';

// The founder's live report (2026-08-18): the branch's TEXT address was
// correct («ΚΩΝΣΤΑΝΤΙΝΟΥΠΟΛΕΩΣ 62») while its stored coordinates pointed
// ~2km away, so a coordinates-first origin made every route depart from
// whatever street Google reverse-named off the stale point («Πέτρου
// Σπανδωνίδη 12»). The origin is address-first; coordinates are only the
// fallback for a store that never typed one.
describe('store origin maps value', () => {
  const settings = {
    'terminal.store_address': 'ΚΩΝΣΤΑΝΤΙΝΟΥΠΟΛΕΩΣ 62, ΘΕΣΣΑΛΟΝΙΚΗ',
    'terminal.store_name': 'ΤΟ ΜΙΚΡΟ ΠΑΡΙΣΙ',
    'terminal.store_latitude': '40.61998784',
    'terminal.store_longitude': '22.96112674',
  };

  it('prefers the human-maintained address over stored coordinates', () => {
    const origin = resolveStoreMapOrigin(createTerminalSettingGetter(settings));
    const url = buildGoogleMapsDirectionsUrl(origin, {
      address: 'Πλαταιών 38, Θεσσαλονίκη',
      coordinates: null,
    });

    expect(url).toContain('google.com/maps/dir/');
    expect(url).toContain(
      `origin=${encodeURIComponent('ΚΩΝΣΤΑΝΤΙΝΟΥΠΟΛΕΩΣ 62, ΘΕΣΣΑΛΟΝΙΚΗ').replace(/%20/g, '+')}`,
    );
    // The rotten coordinates must never be the departure point while an
    // address exists.
    expect(url).not.toContain('40.61998784');
  });

  it('falls back to coordinates for a store that never typed an address', () => {
    const origin = resolveStoreMapOrigin(
      createTerminalSettingGetter({
        'terminal.store_latitude': '40.5',
        'terminal.store_longitude': '22.9',
      }),
    );
    const url = buildGoogleMapsDirectionsUrl(origin, {
      address: 'Πλαταιών 38, Θεσσαλονίκη',
      coordinates: null,
    });

    expect(url).toContain('origin=40.5%2C22.9');
  });

  it('degrades to a destination-only search when no origin exists at all', () => {
    const url = buildGoogleMapsDirectionsUrl(null, {
      address: 'Πλαταιών 38, Θεσσαλονίκη',
      coordinates: null,
    });

    expect(url).toContain('google.com/maps/search/');
  });
});
