/**
 * The script the native side runs in the POS webview before and after a support screenshot
 * (`src-tauri/src/support/screenshot_guard.js`). It must refuse a screen that shows a secret, and it must
 * NOT refuse an ordinary till screen.
 *
 * Symptom this pins (found in review, 12/11/2026, before any release): the first version treated any eight
 * characters of the support-key alphabet, or two groups of four, as a support key, so «TAKEAWAY»,
 * «PAYMENTS» or «1200 1500» refused the capture; and every run of digit groups went to the card-number
 * check, so an order number such as BOX-<13 digits>-… was refused one time in ten.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const script = readFileSync(
  resolve(__dirname, '../../../../../src-tauri/src/support/screenshot_guard.js'),
  'utf8',
);

type GuardWindow = Window & { __supportCaptureGuard?: { observer: MutationObserver } };

function verdict(text: string): string {
  document.body.textContent = text;
  // The native side evaluates the file as one expression; do the same here.
  return new Function(`return ${script}`)() as string;
}

afterEach(() => {
  const guarded = window as GuardWindow;
  guarded.__supportCaptureGuard?.observer.disconnect();
  delete guarded.__supportCaptureGuard;
  document.body.textContent = '';
});

describe('support screenshot guard', () => {
  it.each([
    '4111 1111 1111 1111',
    '4111-1111-1111-1111',
    'Card 4111111111111111 approved',
    'PIN: 1234',
    'password=private',
    'Bearer private-token',
  ])('refuses a screen whose text shows a secret: %s', (text) => {
    expect(verdict(text)).toBe('SCREEN_CONTAINS_SECRETS');
  });

  it.each([
    'TAKEAWAY',
    'PAYMENTS TAKEAWAY',
    'CASH CARD',
    '1200 1500',
    'Table 4 · 2026-11-12 21:46 · €12.50',
    '#0002 Delivery €1.00 · 6948128474 · 12132',
    // Thirteen digits that pass the card check by chance, inside an order number.
    'BOX-4222222222222-9D4B8BE8',
    'ref_4111111111111111',
    '**** **** **** 1111',
  ])('does not take an ordinary till screen for a secret: %s', (text) => {
    expect(verdict(text)).not.toBe('SCREEN_CONTAINS_SECRETS');
  });
});
