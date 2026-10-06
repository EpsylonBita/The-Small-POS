import { describe, expect, it } from 'vitest';

import { CAPTURE_REASON_KEYS } from '../../utils/capture-review';
import en from '../../../locales/en.json';
import el from '../../../locales/el.json';
import de from '../../../locales/de.json';
import fr from '../../../locales/fr.json';
import it_ from '../../../locales/it.json';
import sq from '../../../locales/sq.json';
import { extractCaptureReason } from '../SuppliersPage';

// Desktop 1.4.124 (fix 10 addition): the office now refuses a re-scanned,
// already-stocked supplier paper with 409 CAPTURE_ALREADY_COMMITTED (and a
// commit already running with COMMIT_IN_PROGRESS). The desktop extractor did
// not list either code, so the scan was stored as `commit_rejected` and its
// sentence was the generic one instead of "already saved".

/** The bridge's error text for an office refusal: message, status, raw body. */
const bridgeText = (code: string, sentence: string) =>
  `${sentence} (HTTP 409): {"success":false,"error":"${sentence}","code":"${code}"}`;

describe('the stored reason of a refused scanned-invoice commit', () => {
  it.each([
    ['CAPTURE_ALREADY_COMMITTED', 'This supplier paper was already saved'],
    ['COMMIT_IN_PROGRESS', 'This capture is already being committed'],
  ])('keeps the typed code %s', (code, sentence) => {
    expect(extractCaptureReason(bridgeText(code, sentence))).toBe(code);
    expect(extractCaptureReason(code)).toBe(code);
  });

  it('still names an unknown refusal commit_rejected', () => {
    expect(extractCaptureReason('Something unexpected (HTTP 500)')).toBe('commit_rejected');
  });

  it('every code it can store has a sentence in all six locales', () => {
    for (const code of ['CAPTURE_ALREADY_COMMITTED', 'COMMIT_IN_PROGRESS']) {
      expect(CAPTURE_REASON_KEYS).toContain(code);
      for (const locale of [en, el, de, fr, it_, sq] as Array<Record<string, any>>) {
        const sentence = locale.suppliers.capture.reason[code];
        expect(typeof sentence === 'string' && sentence.trim().length > 0).toBe(true);
      }
    }
  });
});
