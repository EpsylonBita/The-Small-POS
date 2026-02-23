/**
 * Platform detection for POS Tauri.
 *
 * Desktop runtime is Tauri-only. Browser remains available for non-desktop
 * dev/safety usage.
 */

export type Platform = 'tauri' | 'browser';

let detected: Platform | null = null;

export function detectPlatform(): Platform {
  if (detected) return detected;

  if (
    typeof window !== 'undefined' &&
    (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ !== undefined
  ) {
    detected = 'tauri';
  } else {
    detected = 'browser';
  }

  return detected;
}

export function isTauri(): boolean {
  return detectPlatform() === 'tauri';
}

export function isBrowser(): boolean {
  return detectPlatform() === 'browser';
}

export function getPlatform(): Platform {
  return detectPlatform();
}

export function resetPlatformCache(): void {
  detected = null;
}
