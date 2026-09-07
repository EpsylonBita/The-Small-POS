import { describe, expect, it } from 'vitest';
import { requireSettingsSuccess } from '../settings-operation';

describe('settings command outcomes', () => {
  it('rejects resolved native and wrapped failures', () => {
    expect(() => requireSettingsSuccess({ success: false, error: 'Terminal unauthorized' })).toThrow('Terminal unauthorized');
    expect(() => requireSettingsSuccess({ success: true, data: { success: false, errorCode: 'auth_failed' } })).toThrow('auth_failed');
  });
  it('preserves successful and void command responses', () => {
    const config = { success: true, config: { sync_health: 'polling' } };
    expect(requireSettingsSuccess(config)).toBe(config);
    expect(requireSettingsSuccess(undefined)).toBeUndefined();
  });
});
