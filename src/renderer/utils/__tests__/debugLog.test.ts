import { describe, it, expect, vi, afterEach } from 'vitest';
import { debugLog, isDebugLogEnabled } from '../debugLog';

describe('debugLog', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('is OFF by default: nothing reaches the console', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(isDebugLogEnabled()).toBe(false);
    debugLog('hot-path payload', { big: 'object' });
    expect(logSpy).not.toHaveBeenCalled();
  });

  it('forwards to console.log when VITE_POS_DEBUG_LOGS=true in dev', () => {
    vi.stubEnv('VITE_POS_DEBUG_LOGS', 'true');
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(isDebugLogEnabled()).toBe(true);
    debugLog('a', 1, { b: 2 });
    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(logSpy).toHaveBeenCalledWith('a', 1, { b: 2 });
  });

  it('stays off for any value other than the string "true"', () => {
    vi.stubEnv('VITE_POS_DEBUG_LOGS', '1');
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    debugLog('nope');
    expect(logSpy).not.toHaveBeenCalled();
  });

  it('never touches console.warn / console.error — failures keep their channel', () => {
    vi.stubEnv('VITE_POS_DEBUG_LOGS', 'true');
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    debugLog('routed to log only');
    expect(warnSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
  });
});
