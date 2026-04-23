/**
 * Client session utilities for filtering own real-time events
 * Prevents double-processing of optimistic updates
 */

import { clearSecureSession } from '../lib/secure-session-cache';

const SESSION_KEY = 'client_session_id';
// `pos-user` has been moved to the OS keyring (Wave 1 C6, see
// `renderer/lib/secure-session-cache.ts`). It is still listed here so
// any residual pre-migration entries on an upgraded terminal are
// cleared alongside the other end-of-day keys. The canonical clear
// path is `clearSecureSession()` which this file also invokes.
const BUSINESS_DAY_STORAGE_KEYS = [
  'pos-user',
  'pendingOrder',
];

/**
 * Get or create a unique client session ID
 * Stored in localStorage to persist across page reloads
 */
export function getClientSessionId(): string {
  if (typeof window === 'undefined') {
    return 'server-session';
  }

  let sessionId = localStorage.getItem(SESSION_KEY);
  
  if (!sessionId) {
    // Generate a unique session ID with POS prefix
    sessionId = `pos_session_${Date.now()}_${Math.random().toString(36).substring(2, 15)}`;
    localStorage.setItem(SESSION_KEY, sessionId);
  }
  
  return sessionId;
}

/**
 * Check if an event was triggered by the current client session
 * @param eventSessionId - Session ID from the event payload
 * @returns true if the event was triggered by this client
 */
export function isOwnEvent(eventSessionId?: string): boolean {
  if (!eventSessionId) {
    return false;
  }
  
  return eventSessionId === getClientSessionId();
}

/**
 * Add client session ID to update payload
 * @param payload - The update payload
 * @returns Payload with client_session_id added
 */
export function addSessionId<T extends Record<string, any>>(payload: T): T & { client_session_id: string } {
  return {
    ...payload,
    client_session_id: getClientSessionId()
  };
}

/**
 * Clear the current session ID (useful for testing or logout)
 */
export function clearSessionId(): void {
  if (typeof window !== 'undefined') {
    localStorage.removeItem(SESSION_KEY);
  }
}

/**
 * Clear only the business-day renderer state that must not leak into the next
 * cashier session. Preferences and terminal configuration stay intact.
 *
 * Wave 1 C6: additionally clears the keyring-backed session. Fire-and-
 * forget — callers of this helper are typically reloading the window
 * or otherwise resetting the renderer, so awaiting the IPC is wasted
 * latency.
 */
export function clearBusinessDayStorage(): void {
  if (typeof window === 'undefined') {
    return;
  }

  for (const key of BUSINESS_DAY_STORAGE_KEYS) {
    localStorage.removeItem(key);
  }

  void clearSecureSession();
  clearSessionId();
}

