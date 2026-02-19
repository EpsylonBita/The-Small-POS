/**
 * Platform Detection for The Small POS
 *
 * Detects the runtime environment: Tauri, Electron, or plain browser.
 * Tauri injects `window.__TAURI_INTERNALS__` at startup.
 * Electron injects `window.electron` / `window.electronAPI` via preload.
 */

export type Platform = 'tauri' | 'electron' | 'browser';

/** Cached result so detection only runs once. */
let _detected: Platform | null = null;

/**
 * Detect which platform the renderer is running inside.
 *
 * Priority:
 *   1. Tauri  - `window.__TAURI_INTERNALS__` present
 *   2. Electron - `window.electron` or `window.electronAPI` present
 *   3. Browser - fallback
 */
export function detectPlatform(): Platform {
  if (_detected) return _detected;

  if (
    typeof window !== 'undefined' &&
    (window as any).__TAURI_INTERNALS__ !== undefined
  ) {
    _detected = 'tauri';
  } else if (
    typeof window !== 'undefined' &&
    ((window as any).electron !== undefined ||
      (window as any).electronAPI !== undefined ||
      (window as any).isElectron === true)
  ) {
    _detected = 'electron';
  } else {
    _detected = 'browser';
  }

  return _detected;
}

export function isTauri(): boolean {
  return detectPlatform() === 'tauri';
}

export function isElectron(): boolean {
  return detectPlatform() === 'electron';
}

export function isBrowser(): boolean {
  return detectPlatform() === 'browser';
}

/** Alias for detectPlatform() to match the requested API. */
export function getPlatform(): Platform {
  return detectPlatform();
}

/**
 * Reset cached detection (useful for testing).
 */
export function resetPlatformCache(): void {
  _detected = null;
}
