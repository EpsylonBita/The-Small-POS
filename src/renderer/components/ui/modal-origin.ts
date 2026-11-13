/**
 * Where the last press landed, and which glass windows are open (founder, 11/11/2026).
 *
 * Two things come from it:
 * - a window grows out of the control that opened it (`applyModalOrigin` sets the shell's
 *   transform origin to the press point; the keyframes in glassmorphism.css scale from there);
 * - one window can replace another without the blurred backdrop dropping for a few frames
 *   (`takeOverBackdrop`): the closing window's backdrop goes at once and the new window's
 *   backdrop is there at once, so the page behind never shows sharp in between.
 */

/** A press older than this did not open the window that is mounting now. */
export const MODAL_ORIGIN_PRESS_WINDOW_MS = 1500;

type Press = { x: number; y: number; at: number };

export interface OpenGlassModal {
  /** The window's `isOpen` prop right now: false while it plays its exit. */
  isOpen: () => boolean;
  backdrop: () => HTMLElement | null;
}

let lastPress: Press | null = null;
let installed = false;
const openModals = new Set<OpenGlassModal>();

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

function notePress(x: number, y: number): void {
  lastPress = { x, y, at: now() };
}

/** The point of a press recent enough to have opened the window that is mounting. */
export function recentPress(): { x: number; y: number } | null {
  if (!lastPress || now() - lastPress.at > MODAL_ORIGIN_PRESS_WINDOW_MS) return null;
  return { x: lastPress.x, y: lastPress.y };
}

/**
 * Point the shell's enter and exit animation at the last press. Safe to call more than once per
 * shell. With no recent press the shell keeps the stylesheet's centre origin.
 */
export function applyModalOrigin(shell: HTMLElement): void {
  if (shell.dataset.modalOrigin) return;
  shell.dataset.modalOrigin = 'set';
  const press = recentPress();
  if (!press) return;
  // Measure the layout box, not the first frame of the enter animation: stop it, read, and let
  // it start again from its first frame with the origin in place.
  const inlineAnimation = shell.style.animation;
  shell.style.animation = 'none';
  const rect = shell.getBoundingClientRect();
  shell.style.animation = inlineAnimation;
  if (rect.width <= 0 || rect.height <= 0) return;
  // From the centre and the layout size, so a shell that a motion library already scaled about
  // its centre is measured as its real box too.
  const width = shell.offsetWidth || rect.width;
  const height = shell.offsetHeight || rect.height;
  const left = rect.left + rect.width / 2 - width / 2;
  const top = rect.top + rect.height / 2 - height / 2;
  shell.style.setProperty('--modal-origin-x', `${Math.round(press.x - left)}px`);
  shell.style.setProperty('--modal-origin-y', `${Math.round(press.y - top)}px`);
}

/** Track presses, and point hand-built shells portaled to the body at them too. */
export function installModalOriginTracking(): void {
  if (installed || typeof document === 'undefined') return;
  installed = true;
  document.addEventListener(
    'pointerdown',
    event => notePress(event.clientX, event.clientY),
    { capture: true, passive: true },
  );
  // A window opened from the keyboard grows out of the focused control.
  document.addEventListener(
    'keydown',
    event => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      const target = document.activeElement;
      if (!(target instanceof HTMLElement) || target === document.body) return;
      const rect = target.getBoundingClientRect();
      notePress(rect.left + rect.width / 2, rect.top + rect.height / 2);
    },
    { capture: true },
  );
  if (typeof MutationObserver === 'undefined' || !document.body) return;
  // Direct children of the body only: that is where modal portals land, and it keeps this off
  // the hot path of ordinary rendering.
  new MutationObserver(records => {
    for (const record of records) {
      record.addedNodes.forEach(node => {
        if (!(node instanceof HTMLElement)) return;
        const shell = node.matches('.liquid-glass-modal-shell')
          ? node
          : node.querySelector<HTMLElement>('.liquid-glass-modal-shell');
        if (shell) applyModalOrigin(shell);
      });
    }
  }).observe(document.body, { childList: true });
}

/** A mounted glass window; returns its release. */
export function registerOpenGlassModal(entry: OpenGlassModal): () => void {
  openModals.add(entry);
  return () => {
    openModals.delete(entry);
  };
}

/**
 * Called when a window mounts. True when it replaces a window that is closing: that window's
 * backdrop is dropped at once, and the caller shows its own backdrop without the fade-in, so the
 * dim and blur stay constant. A window opened ON TOP of an open one is not a replacement: its
 * backdrop fades in over the window below as before.
 */
export function takeOverBackdrop(self: OpenGlassModal): boolean {
  let replaced = false;
  for (const other of openModals) {
    if (other === self || other.isOpen()) continue;
    replaced = true;
    const backdrop = other.backdrop();
    if (backdrop) {
      backdrop.style.animation = 'none';
      backdrop.style.opacity = '0';
    }
  }
  return replaced;
}

/** Test-only: forget presses and open windows. */
export function resetModalOriginForTests(): void {
  lastPress = null;
  openModals.clear();
}

/** Test-only: record a press as if the pointer had landed there. */
export function notePressForTests(x: number, y: number): void {
  notePress(x, y);
}
