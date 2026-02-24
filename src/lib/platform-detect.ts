/**
 * Platform detection for POS Tauri.
 *
 * Desktop runtime is Tauri-only. Browser remains available for non-desktop
 * dev/safety usage.
 */

export type Platform = 'tauri' | 'browser';

let detected: Platform | null = null;

type TauriWindow = Window & {
  __TAURI_INTERNALS__?: unknown;
  __TAURI__?: unknown;
  __TAURI_IPC__?: unknown;
};

function hasTauriRuntime(win: TauriWindow): boolean {
  return Boolean(win.__TAURI_INTERNALS__ || win.__TAURI__ || win.__TAURI_IPC__);
}

export function detectPlatform(): Platform {
  if (detected) return detected;

  if (typeof window !== 'undefined' && hasTauriRuntime(window as TauriWindow)) {
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
