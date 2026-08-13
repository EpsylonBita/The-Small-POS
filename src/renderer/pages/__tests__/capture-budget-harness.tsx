/**
 * The measuring instrument for the R15 budget tests (invoice-scan-capture
 * Task 18.1 / 18.3, desktop half).
 *
 * Spec: `.claude/specs/invoice-scan-capture/requirements.md` R15.1, R15.2,
 * R15.4, R15.6; `design.md` Testing Strategy → "R15 budget assertions".
 *
 * R15 is the only requirement in the feature stated as a *number*: two clicks
 * to start, four screens end to end. A test that merely asserted the buttons
 * exist would pass on a flow that grew a source picker, a confirmation step, or
 * a "ready?" interstitial — so nothing here is eyeballed. Two things are
 * counted mechanically:
 *
 * 1. **Interactions.** Every click the walkthrough performs goes through
 *    {@link Walkthrough.press}, which records a label and then calls
 *    `fireEvent.click`. There is no second way to click in these suites, so the
 *    count cannot drift away from what the user actually did.
 * 2. **Screens.** {@link activeScreen} reads the *rendered DOM* and answers
 *    which view the user is looking at, resolved topmost-first because the
 *    desktop capture surfaces are stacked overlays over a suppliers page that
 *    never unmounts. The walkthrough samples it after every step, and the
 *    budget is asserted against the number of **distinct** keys — so an
 *    interstitial is a new key and blows the budget, while stepping back onto a
 *    screen already visited correctly costs nothing.
 *
 * ## What "exactly one visually primary action" is taken to mean
 *
 * R15.2 asks for one visually primary action per screen. Read as "at most one
 * primary-styled button may exist" it is *unsatisfiable* alongside R4.3 / R5.1,
 * which require "Add another page" and "Done" to be **equally obvious choices**
 * — the design deliberately renders them with identical chrome, and
 * `CapturePagesPanel.test.tsx` pins that equality.
 *
 * The reading used here, and the one the informative Simplicity Walkthrough
 * implies, is: **exactly one primary action carries the flow forward off the
 * screen.** An equal-weight sibling that keeps the user on the same screen
 * (Add another page) is an option, not a step. So each screen asserts:
 *
 * - the exact set of enabled, primary-styled capture controls on arrival
 *   (pinned, so promoting any new button to primary fails loudly rather than
 *   quietly widening the flow), and
 * - that exactly one of them advances — proved by the walkthrough advancing on
 *   it, and by the sibling demonstrably *not* changing the active screen.
 *
 * ## Scope of the "capture surface"
 *
 * On the suppliers page the capture flow owns exactly the `capture-*` header
 * controls; the pre-existing "Import items" button belongs to the manual import
 * feature and is not part of this flow, so it is outside the measured surface.
 * Inside the pages / queue overlays the whole dialog is capture surface. Inside
 * the import drawer the flow owns Preview and Save.
 */

import { fireEvent } from '@testing-library/react';

/** The views the desktop capture happy path can put in front of a user. */
export type ScreenKey =
  | 'suppliers'
  | 'scan-settings'
  | 'pages'
  | 'queue'
  | 'review'
  | 'none';

/**
 * Class tokens the desktop uses for a primary (call-to-action) button in the
 * light theme, taken from the components themselves:
 *
 * - `border-yellow-400` — the capture surface's primary treatment
 *   (`SuppliersPage` header, `CapturePagesPanel`, `CaptureQueuePanel`).
 * - `bg-amber-50` — the import drawer's Preview.
 * - `bg-emerald-600` — the import drawer's Save.
 *
 * Matching is on whole class tokens, never substrings, so `bg-amber-500/15`
 * (a dark-theme tint) can never be mistaken for one of these.
 */
const PRIMARY_TOKENS = ['border-yellow-400', 'bg-amber-50', 'bg-emerald-600'] as const;

function dialogs(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>('[role="dialog"]'));
}

/** The overlay whose own heading reads `title`, or null. */
function dialogTitled(title: string): HTMLElement | null {
  return (
    dialogs().find((dialog) => {
      const heading = dialog.querySelector('h2');
      return heading?.textContent?.trim() === title;
    }) ?? null
  );
}

/** The pages overlay, identified by the control only it renders. */
function pagesDialog(): HTMLElement | null {
  const add = document.querySelector<HTMLElement>('[data-testid="capture-add-page"]');
  return add?.closest<HTMLElement>('[role="dialog"]') ?? null;
}

/**
 * The DOM subtree that *is* a given screen. `suppliers` has no root of its own —
 * it is the page under every overlay — so it answers `document.body` and the
 * caller filters out anything sitting inside a dialog.
 */
export function screenRoot(key: ScreenKey): HTMLElement | null {
  switch (key) {
    case 'review':
      return dialogTitled('Import supplier items');
    case 'pages':
      return pagesDialog();
    case 'queue':
      return dialogTitled('Scanned invoices');
    case 'scan-settings':
      return dialogTitled('Scan settings');
    case 'suppliers':
      return document.querySelector<HTMLElement>('[data-testid="capture-scan-invoice"]')
        ? document.body
        : null;
    default:
      return null;
  }
}

/**
 * Which screen the user is looking at right now.
 *
 * Resolved in stacking order — the overlays sit on top of the suppliers page,
 * which stays mounted underneath — so the answer is the topmost open view.
 */
export function activeScreen(): ScreenKey {
  const order: ScreenKey[] = ['review', 'pages', 'scan-settings', 'queue', 'suppliers'];
  for (const key of order) {
    if (screenRoot(key)) return key;
  }
  return 'none';
}

/** A stable, human-readable name for one control. */
function label(element: HTMLElement): string {
  return (
    element.dataset.testid ??
    element.getAttribute('aria-label') ??
    element.textContent?.trim() ??
    '(unnamed)'
  );
}

function isPrimary(element: HTMLElement): boolean {
  const tokens = element.className.split(/\s+/);
  return PRIMARY_TOKENS.some((token) => tokens.includes(token));
}

/**
 * Enabled, primary-styled controls of the capture flow on `key`, by label.
 *
 * Sorted so assertions can pin an exact set without depending on DOM order.
 */
export function primaryActionsOn(key: ScreenKey): string[] {
  const root = screenRoot(key);
  if (!root) return [];

  return Array.from(root.querySelectorAll<HTMLButtonElement>('button'))
    .filter((button) => !button.disabled)
    .filter((button) => isPrimary(button))
    .filter((button) => {
      if (key !== 'suppliers') return true;
      // The suppliers page carries other features' buttons; the capture flow
      // owns exactly the `capture-*` header controls, and nothing inside an
      // overlay belongs to the page underneath it.
      if (button.closest('[role="dialog"]')) return false;
      return Boolean(button.dataset.testid?.startsWith('capture-'));
    })
    .map(label)
    .sort();
}

/** Every enabled control of a screen, primary or not — used for skippability. */
export function enabledControlsOn(key: ScreenKey): string[] {
  const root = screenRoot(key);
  if (!root) return [];
  return Array.from(root.querySelectorAll<HTMLButtonElement>('button'))
    .filter((button) => !button.disabled)
    .map(label)
    .sort();
}

/**
 * A counted walk through the UI.
 *
 * Every click goes through `press`; the screen is sampled after each one and
 * whenever the caller `observe()`s (after an awaited state settle, say). The
 * assertions then read `interactions` and `distinctScreens`.
 */
export class Walkthrough {
  /** Labels of every click performed, in order. */
  readonly interactions: string[] = [];
  /** The screen sequence as visited, including returns to earlier screens. */
  readonly visited: ScreenKey[] = [];

  constructor() {
    this.observe();
  }

  /** Sample the active screen, recording it only when it actually changed. */
  observe(): ScreenKey {
    const current = activeScreen();
    if (this.visited[this.visited.length - 1] !== current) {
      this.visited.push(current);
    }
    return current;
  }

  /** Click one control and count it. The only click path these suites have. */
  press(element: HTMLElement | null, name?: string): void {
    if (!element) {
      throw new Error(`Walkthrough.press: control "${name ?? '?'}" is not on screen`);
    }
    if (element instanceof HTMLButtonElement && element.disabled) {
      throw new Error(`Walkthrough.press: control "${label(element)}" is disabled`);
    }
    this.interactions.push(name ?? label(element));
    fireEvent.click(element);
    this.observe();
  }

  get interactionCount(): number {
    return this.interactions.length;
  }

  /** Distinct views the walk put in front of the user — the R15.2 budget. */
  get distinctScreens(): ScreenKey[] {
    return Array.from(new Set(this.visited.filter((key) => key !== 'none')));
  }

  get screenCount(): number {
    return this.distinctScreens.length;
  }
}
