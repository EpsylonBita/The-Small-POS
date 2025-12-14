/**
 * Geolocation Handlers Module
 *
 * Handles IP-based geolocation via main process (bypasses renderer CSP).
 */

import { ipcMain } from 'electron';

/**
 * Register geolocation IPC handlers
 */
export function registerGeolocationHandlers(): void {
  // IP-based geolocation via main process (bypasses renderer CSP)
  ipcMain.removeHandler('geo:ip');
  ipcMain.handle('geo:ip', async () => {
    try {
      const fetchAny: any = (globalThis as any).fetch;
      if (!fetchAny) {
        return { ok: false, error: 'fetch_unavailable' };
      }

      // Try ipapi.co first
      try {
        const res = await fetchAny('https://ipapi.co/json/', {
          headers: { Accept: 'application/json', 'User-Agent': 'TheSmallPOS/1.0' },
        });
        if (res && res.ok) {
          const data = await res.json();
          if (data && typeof data.latitude === 'number' && typeof data.longitude === 'number') {
            return { ok: true, latitude: data.latitude, longitude: data.longitude, source: 'ipapi' };
          }
        }
      } catch {
        // Continue to fallback
      }

      // Fallback to ipwho.is
      try {
        const res2 = await fetchAny('https://ipwho.is/');
        if (res2 && res2.ok) {
          const data2 = await res2.json();
          if (data2 && data2.success && data2.latitude && data2.longitude) {
            return {
              ok: true,
              latitude: Number(data2.latitude),
              longitude: Number(data2.longitude),
              source: 'ipwho',
            };
          }
        }
      } catch {
        // Continue to return not ok
      }
    } catch {
      // Return not ok
    }
    return { ok: false };
  });
}
