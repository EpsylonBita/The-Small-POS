/**
 * Gated debug logger for hot-path call sites (per-render / per-event logs).
 *
 * WebView2 retains the last ~1000 console messages together with their
 * argument object graphs even when DevTools is closed. Production builds
 * strip bare console.log/debug/info at build time (see vite.config.ts), but
 * that does not apply in dev — where per-render and per-event logs were
 * measured churning the retained buffer with large payloads. Hot paths call
 * this instead of console.log; it is OFF by default everywhere.
 *
 * Opt back in for a diagnosis session with VITE_POS_DEBUG_LOGS=true
 * (e.g. in pos-tauri/.env.local) — dev builds only.
 *
 * console.warn / console.error are unaffected by any of this and remain the
 * channel for genuine failures, in dev and in production.
 */
/**
 * import.meta.env first (the real Vite renderer), process.env as fallback
 * (vitest's vi.stubEnv only reaches process.env). Mirrors the getEnvVar
 * pattern in src/config/environment.ts — this project doesn't ship
 * `vite/client` type references, hence the `as any` cast.
 */
function readEnv(key: string): unknown {
  try {
    const metaEnv = (import.meta as any).env;
    if (metaEnv && metaEnv[key] !== undefined) return metaEnv[key];
  } catch {
    /* not in a Vite context */
  }
  if (typeof process !== 'undefined' && process.env && process.env[key] !== undefined) {
    return process.env[key];
  }
  return undefined;
}

export function isDebugLogEnabled(): boolean {
  const dev = readEnv('DEV');
  if (dev !== true && dev !== 'true') return false;
  return readEnv('VITE_POS_DEBUG_LOGS') === 'true';
}

export function debugLog(...args: unknown[]): void {
  if (isDebugLogEnabled()) {
    console.log(...args);
  }
}
