/**
 * Touch press feedback (UI audit wave 5, 30/10/2026).
 *
 * The tills are touch screens. In WebView2 a touch sets :active only when the finger
 * lifts (traced over CDP: pointerdown at 13 ms, :active at 643 ms together with the
 * emulated mouse events), so a held press showed nothing. This marks the touched
 * control with `data-pressed` from pointerdown until release, and
 * styles/glassmorphism.css styles `[data-pressed]` like `:active`.
 *
 * Visual only: passive capture listeners that never call preventDefault, so the
 * click fires exactly as before. A mouse press is left to :active.
 */
export const PRESSABLE_SELECTOR =
  "button, [role='button'], [role='tab'], [role='switch'], [role='radio'], [role='checkbox'], [role='menuitem'], [role='option'], a[href], summary";

/** A quick tap keeps the pressed look this long so it can be seen. Nothing waits for it. */
export const MIN_PRESSED_MS = 100;

const isDisabled = (element: Element): boolean =>
  (element as HTMLButtonElement).disabled === true || element.getAttribute('aria-disabled') === 'true';

export function installTouchPressFeedback(
  doc: Document = document,
  now: () => number = () => performance.now(),
): () => void {
  let pressed: Element | null = null;
  let pressedAt = 0;
  let lingering: Element | null = null;
  let lingerTimer: ReturnType<typeof setTimeout> | undefined;

  const endLinger = () => {
    if (lingerTimer !== undefined) clearTimeout(lingerTimer);
    lingerTimer = undefined;
    lingering?.removeAttribute('data-pressed');
    lingering = null;
  };

  const release = () => {
    if (!pressed) return;
    const element = pressed;
    pressed = null;
    const left = MIN_PRESSED_MS - (now() - pressedAt);
    if (left <= 0) {
      element.removeAttribute('data-pressed');
      return;
    }
    lingering = element;
    lingerTimer = setTimeout(endLinger, left);
  };

  const onPointerDown = (event: Event) => {
    if ((event as PointerEvent).pointerType === 'mouse') return;
    endLinger();
    pressed?.removeAttribute('data-pressed');
    pressed = null;
    const target = event.target instanceof Element ? event.target.closest(PRESSABLE_SELECTOR) : null;
    if (!target || isDisabled(target)) return;
    target.setAttribute('data-pressed', '');
    pressed = target;
    pressedAt = now();
  };

  const options = { capture: true, passive: true } as const;
  doc.addEventListener('pointerdown', onPointerDown, options);
  doc.addEventListener('pointerup', release, options);
  doc.addEventListener('pointercancel', release, options);

  return () => {
    doc.removeEventListener('pointerdown', onPointerDown, options);
    doc.removeEventListener('pointerup', release, options);
    doc.removeEventListener('pointercancel', release, options);
    endLinger();
    pressed?.removeAttribute('data-pressed');
    pressed = null;
  };
}
