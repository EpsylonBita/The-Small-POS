/**
 * Fix review 06/10/2026: the shift screen showed the server's raw satellite
 * handover codes (REMOTE_HANDOVER_GIFT_CLOSE_REQUIRED, ..._STAFF_CUSTODY_UNRESOLVED,
 * ..._MOVEMENTS_UNAVAILABLE, ..._ROLE_UNSUPPORTED, ..._RETRY) and the main
 * cashier's close showed the English-only SATELLITE_HANDOVER_PENDING. Every
 * refusal now reads as plain till text in the store language, and a refusal
 * for good says that a manager can release it.
 */
import i18next, { type TFunction } from 'i18next';
import { describe, expect, it } from 'vitest';
import de from '../../../locales/de.json';
import el from '../../../locales/el.json';
import en from '../../../locales/en.json';
import fr from '../../../locales/fr.json';
import it_ from '../../../locales/it.json';
import sq from '../../../locales/sq.json';
import {
  isSatelliteHandoverRefusal,
  satelliteHandoverCode,
  satelliteHandoverMessage,
} from '../satelliteHandoverText';

const LOCALES = { en, el, de, fr, it: it_, sq } as const;
type Lng = keyof typeof LOCALES;

async function translator(lng: Lng): Promise<TFunction> {
  const instance = i18next.createInstance();
  await instance.init({
    lng,
    fallbackLng: false,
    resources: Object.fromEntries(Object.entries(LOCALES).map(([code, translation]) => [code, { translation }])),
    interpolation: { escapeValue: false },
  });
  return instance.t.bind(instance) as TFunction;
}

const reasonText = (lng: Lng, reason: string): string =>
  (LOCALES[lng] as any).modals.staffShift.satelliteHandover.reasons[reason];
const releaseHint = (lng: Lng): string =>
  (LOCALES[lng] as any).modals.staffShift.satelliteHandover.releaseHint;
const RAW_CODE = /\b(?:REMOTE|SATELLITE)_[A-Z_]{3,}/;

const SERVER_REFUSALS: Array<[string, string]> = [
  ['REMOTE_HANDOVER_GIFT_CLOSE_REQUIRED', 'giftClose'],
  ['REMOTE_HANDOVER_STAFF_CUSTODY_UNRESOLVED', 'staffCustody'],
  ['REMOTE_HANDOVER_MOVEMENTS_UNAVAILABLE', 'movements'],
  ['REMOTE_HANDOVER_ROLE_UNSUPPORTED', 'role'],
  ['REMOTE_HANDOVER_RETRY', 'retry'],
  ['REMOTE_HANDOVER_PROOF_UNAVAILABLE', 'closedElsewhere'],
  ['REMOTE_HANDOVER_CURRENCY_MISMATCH', 'currency'],
  ['REMOTE_HANDOVER_RECEIVER_MISMATCH', 'receiver'],
  ['REMOTE_HANDOVER_CONFLICT', 'conflict'],
  ['REMOTE_CHECKOUT_MAIN_ONLY', 'mainOnly'],
];

describe('satellite handover refusals in till language', () => {
  it.each(Object.keys(LOCALES) as Lng[])('%s: every server code reads as its plain sentence, never the code', async (lng) => {
    const t = await translator(lng);
    for (const [code, reason] of SERVER_REFUSALS) {
      const message = satelliteHandoverMessage(`${code}: remote checkout refused`, t);
      expect(message?.reason, code).toBe(reason);
      expect(message?.refused, code).toBe(false);
      expect(message?.text, code).toBe(reasonText(lng, reason));
      expect(message?.text, code).not.toMatch(RAW_CODE);
    }
  });

  it.each(Object.keys(LOCALES) as Lng[])('%s: the main cashier close held by a handover in flight is plain text', async (lng) => {
    const t = await translator(lng);
    const message = satelliteHandoverMessage(
      new Error('SATELLITE_HANDOVER_PENDING: reconnect to finish receiving satellite cash before closing this cashier shift'),
      t,
    );
    expect(message).toMatchObject({ reason: 'pending', refused: false, code: 'SATELLITE_HANDOVER_PENDING' });
    expect(message?.text).toBe(reasonText(lng, 'pending'));
    if (lng !== 'en') expect(message?.text).not.toContain('reconnect to finish');
  });

  it.each(Object.keys(LOCALES) as Lng[])('%s: a refusal for good names the reason and the manager release', async (lng) => {
    const t = await translator(lng);
    const message = satelliteHandoverMessage(
      'SATELLITE_HANDOVER_REFUSED: REMOTE_HANDOVER_PROOF_UNAVAILABLE: the server refused this satellite cash handover for good; a manager can release it without crediting this drawer',
      t,
    );
    expect(message).toMatchObject({ reason: 'closedElsewhere', refused: true, code: 'REMOTE_HANDOVER_PROOF_UNAVAILABLE' });
    expect(message?.text).toBe(`${reasonText(lng, 'closedElsewhere')} ${releaseHint(lng)}`);
    expect(message?.text).not.toMatch(RAW_CODE);
  });

  it.each(Object.keys(LOCALES) as Lng[])('%s: a refusal for good never invites a retry it cannot have', async (lng) => {
    const t = await translator(lng);
    for (const [code, reason, refusedKey] of [
      ['REMOTE_HANDOVER_STAFF_CUSTODY_UNRESOLVED', 'staffCustody', 'staffCustodyRefused'],
      ['REMOTE_HANDOVER_MOVEMENTS_UNAVAILABLE', 'movements', 'movementsRefused'],
    ] as const) {
      const message = satelliteHandoverMessage(`SATELLITE_HANDOVER_REFUSED: ${code}: refused for good`, t);
      expect(message).toMatchObject({ reason, refused: true, code });
      expect(message?.text).toBe(`${reasonText(lng, refusedKey)} ${releaseHint(lng)}`);
      expect(message?.text).not.toContain(reasonText(lng, reason));
    }
  });

  it('reads native codes with detail, error objects and unknown handover codes', async () => {
    const t = await translator('en');
    expect(satelliteHandoverCode('SATELLITE_HANDOVER_PROOF_MISMATCH_currency')).toBe('SATELLITE_HANDOVER_PROOF_MISMATCH');
    expect(satelliteHandoverMessage('SATELLITE_HANDOVER_REFUSED: SATELLITE_HANDOVER_PROOF_MISMATCH_currency', t))
      .toMatchObject({ reason: 'conflict', refused: true });
    expect(satelliteHandoverMessage({ error: 'REMOTE_HANDOVER_RETRY' }, t)?.reason).toBe('retry');
    expect(satelliteHandoverMessage({ refusalCode: 'REMOTE_HANDOVER_SOMETHING_NEW' }, t)).toMatchObject({
      reason: 'unknown',
      text: reasonText('en', 'unknown'),
    });
  });

  it('leaves every other error to its own handling', async () => {
    const t = await translator('en');
    for (const other of ['SHIFT_CURRENCY_SETTLEMENT_REQUIRED', 'Network error', '', null, undefined, { code: 42 }]) {
      expect(isSatelliteHandoverRefusal(other)).toBe(false);
      expect(satelliteHandoverMessage(other, t)).toBeNull();
    }
  });
});
