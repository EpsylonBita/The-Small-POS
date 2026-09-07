import { describe, expect, it } from 'vitest';
import { resolveTerminalConfigHealth } from '../terminal-config-health';

describe('terminal configuration health', () => {
  it.each(['polling', ' POLLING ', 'healthy', 'online', 'ok', 'synced', 'connected', 'good', 'live'])(
    'treats successful configuration state %s as healthy', (value) => {
      expect(resolveTerminalConfigHealth(value)).toEqual({ state: 'healthy', isHealthy: true, tone: 'success' });
    },
  );

  it('keeps stale configuration separate from offline or unavailable configuration', () => {
    expect(resolveTerminalConfigHealth('stale')).toEqual({ state: 'stale', isHealthy: false, tone: 'warning' });
    expect(resolveTerminalConfigHealth('offline')).toEqual({ state: 'offline', isHealthy: false, tone: 'danger' });
    expect(resolveTerminalConfigHealth('unavailable')).toEqual({ state: 'unavailable', isHealthy: false, tone: 'danger' });
  });

  it.each(['disconnected', 'not_connected', 'not connected', 'failed', 'error', 'degraded'])(
    'never matches healthy substrings inside failure state %s', (value) => {
      expect(resolveTerminalConfigHealth(value)).toMatchObject({ isHealthy: false, tone: 'danger' });
    },
  );

  it.each([null, undefined, '', 'unknown', 'new_backend_state', {}])(
    'leaves missing/unrecognized state %j neutral instead of claiming success or failure', (value) => {
      expect(resolveTerminalConfigHealth(value)).toEqual({ state: 'unknown', isHealthy: false, tone: 'neutral' });
    },
  );
});
