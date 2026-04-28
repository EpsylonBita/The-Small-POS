/**
 * Secure session cache (Wave 1 C6).
 *
 * Before Wave 1, the authenticated session object — including `sessionId`,
 * `staffId`, `branchId`, `organizationId` — lived in plain `localStorage`
 * under the key `pos-user`. Any script running in the renderer context
 * could read live credentials. This module moves the authoritative store
 * to the OS keyring (via `bridge.secureSession`) while preserving a
 * synchronous read interface for consumers that cannot easily be made
 * async (e.g. `ActivityTracker.loadFallbackContext`, `shift-context`
 * fallback chains).
 *
 * Shape:
 *   - Boot: App.tsx calls `hydrateSecureSession()` as its very first step
 *     during startup. The cache is populated from the keyring.
 *   - Reads: `getSecureSessionSync()` returns the cached user or `null`.
 *     Never touches storage — always synchronous.
 *   - Writes: `setSecureSession(user)` updates the cache IMMEDIATELY and
 *     fires the keyring write in the background. The returned promise
 *     resolves when the write is durable, but sync consumers see the
 *     update on the next read regardless.
 *   - Clears: `clearSecureSession()` clears the cache immediately and
 *     fires the keyring delete in the background.
 *
 * The pre-hydration state (before `hydrateSecureSession` resolves) is
 * indistinguishable from "no session stored" — consumers that check
 * `getSecureSessionSync()` will get `null` and fall through their
 * existing no-session code paths. This matches the pre-Wave-1 behaviour
 * where localStorage was empty at the same moment.
 */

import { getBridge } from '../../lib/ipc-adapter';

/**
 * Minimal shape we rely on from the persisted session. The full object is
 * larger and renderer-shaped; we keep this type shallow so a schema change
 * on the renderer side does not force a coordinated edit here.
 */
export interface SecureSessionUser {
  staffId?: string;
  databaseStaffId?: string;
  sessionId?: string;
  staffName?: string;
  role?: { name?: string };
  branchId?: string;
  terminalId?: string;
  organizationId?: string;
  [key: string]: unknown;
}

let cached: SecureSessionUser | null = null;
let hydrated = false;
let hydratePromise: Promise<void> | null = null;

/**
 * Wave 8 H29: narrow an unknown blob to `SecureSessionUser` or reject it.
 *
 * The keyring is opaque storage and the renderer's session shape evolves
 * independently from this module, so we only check the fields that are
 * **critical for identity**: `staffId`, `branchId`, `terminalId`, and
 * `organizationId` must each be non-empty strings when present. A blob
 * that parses as JSON but fails one of those checks used to be accepted
 * by a bare `as SecureSessionUser` cast and then cause downstream crashes
 * (e.g. a `staffId: 42` number would fail `.startsWith(...)` deep in
 * a permission check). The bounds here are deliberately loose: unknown
 * extra fields pass through untouched, `undefined` for a critical field
 * is accepted because shift-context fallback chains legitimately produce
 * a partial session during auth hand-off.
 */
function validateSecureSessionUser(raw: unknown): SecureSessionUser | null {
  if (raw === null || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  const criticalStringFields = [
    'staffId',
    'branchId',
    'terminalId',
    'organizationId',
  ] as const;
  for (const key of criticalStringFields) {
    const value = obj[key];
    if (value === undefined || value === null) continue;
    if (typeof value !== 'string' || value.trim() === '') {
      console.warn(
        `[secure-session] rejecting blob: ${key} must be a non-empty string when present, got ${typeof value}`,
      );
      return null;
    }
  }
  if (obj.role !== undefined && obj.role !== null) {
    if (typeof obj.role !== 'object') {
      console.warn('[secure-session] rejecting blob: role must be an object when present');
      return null;
    }
  }
  return obj as SecureSessionUser;
}

/**
 * Load the persisted session from the OS keyring into memory. Idempotent:
 * subsequent calls return the same resolved promise. Must be awaited
 * early in app startup; consumers calling `getSecureSessionSync()` before
 * hydration see `null`.
 */
export async function hydrateSecureSession(): Promise<void> {
  if (hydrated) return;
  if (hydratePromise) return hydratePromise;

  hydratePromise = (async () => {
    try {
      const raw = await getBridge().secureSession.get();
      if (raw && typeof raw === 'string') {
        let parsed: unknown = null;
        let parseOk = false;
        try {
          parsed = JSON.parse(raw);
          parseOk = true;
        } catch (parseErr) {
          console.warn(
            '[secure-session] failed to parse persisted session; treating as empty',
            parseErr,
          );
        }

        // Wave 8 H29: even when JSON.parse succeeded, run the validator
        // before accepting the blob. A wrong-shape session (e.g. a
        // staffId that isn't a string) used to flow unchecked through
        // `as SecureSessionUser` and cause downstream crashes far from
        // the source.
        const validated = parseOk ? validateSecureSessionUser(parsed) : null;
        cached = validated;
        if (parseOk && validated === null) {
          console.warn(
            '[secure-session] persisted blob failed schema validation; treating as empty and clearing',
          );
        }
        if (!parseOk || validated === null) {
          // Best-effort: clear the corrupted/invalid blob so the next
          // write is clean and the user is forced back through login
          // rather than living with a silently-null session.
          try {
            await getBridge().secureSession.clear();
          } catch (clearErr) {
            console.warn('[secure-session] failed to clear corrupted blob', clearErr);
          }
        }
      } else {
        cached = null;
      }
    } catch (err) {
      // A keyring read failure is not fatal — the user can log in again.
      // Log once and treat as "no session".
      console.warn('[secure-session] hydrate failed, no session restored', err);
      cached = null;
    } finally {
      hydrated = true;
    }
  })();

  return hydratePromise;
}

/**
 * Synchronous read. Returns the cached user, or `null` if none (or
 * pre-hydration). Consumers calling this before `hydrateSecureSession`
 * resolves will get `null`; this is intentional and matches the
 * pre-Wave-1 behaviour where localStorage was empty at startup.
 */
export function getSecureSessionSync(): SecureSessionUser | null {
  return cached;
}

/**
 * Update the cache synchronously AND schedule a keyring write. The
 * returned promise resolves when the write is durable; callers that
 * need durability should await. Callers that just want the in-memory
 * view updated can fire-and-forget.
 */
export async function setSecureSession(user: SecureSessionUser): Promise<void> {
  cached = user;
  hydrated = true; // avoid a redundant re-hydrate after a fresh login
  try {
    await getBridge().secureSession.set(JSON.stringify(user));
  } catch (err) {
    // If the write fails, the cache is still updated so the current
    // process continues to work. Next boot will miss the session and
    // the user re-logs in — acceptable degraded behaviour.
    console.warn('[secure-session] keyring write failed; in-memory only', err);
  }
}

/**
 * Clear the cache immediately and schedule a keyring delete.
 */
export async function clearSecureSession(): Promise<void> {
  cached = null;
  hydrated = true;
  try {
    await getBridge().secureSession.clear();
  } catch (err) {
    console.warn('[secure-session] keyring clear failed', err);
  }
}

/**
 * Visible-for-testing. Reset the module to its un-hydrated state.
 */
export function __resetForTesting(): void {
  cached = null;
  hydrated = false;
  hydratePromise = null;
}
