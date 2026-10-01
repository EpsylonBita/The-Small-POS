import i18next from 'i18next';
import { describe, expect, it } from 'vitest';

import en from '../../locales/en.json';
import el from '../../locales/el.json';
import de from '../../locales/de.json';
import fr from '../../locales/fr.json';
import it_ from '../../locales/it.json';
import sq from '../../locales/sq.json';
import type { UnsettledPaymentBlocker } from '../ipc-contracts';
import {
  formatOperatorFacingError,
  formatPaymentNotSavedMessage,
  getLocalizedPaymentBlockerFix,
  getLocalizedPaymentBlockerReason,
  paymentBlockerKey,
} from '../payment-integrity';

// Fix review 30/09/2026 (Android 1.0.13 parity): a card charged but not saved
// is told in the store's language from its code, never as the native English
// sentence and never as the generic "Failed to collect payment".

const LOCALES = { en, el, de, fr, it: it_, sq } as const;
type Lng = keyof typeof LOCALES;

const translatorFor = async (lng: Lng) => {
  const instance = i18next.createInstance();
  await instance.init({
    lng,
    fallbackLng: false,
    resources: { [lng]: { translation: LOCALES[lng] } },
    interpolation: { escapeValue: false },
  });
  return instance.t;
};

const money = (amount: number) => `${amount.toFixed(2)} €`;

const NATIVE_ENGLISH =
  'The card was charged 13.00, but the payment could not be saved on this till yet. Do not charge again: save the payment again.';

const notSavedBlocker = (canSaveAgain: boolean): UnsettledPaymentBlocker => ({
  orderId: 'order-unsaved-1',
  orderNumber: 'A-0077',
  totalAmount: 13,
  settledAmount: 0,
  paymentStatus: 'pending',
  paymentMethod: 'card',
  reasonCode: 'payments_not_saved',
  reasonText: 'A EUR 13.00 card payment charged at 2026-09-30T10:05:00Z is not saved on this till yet.',
  suggestedFix: 'Save the payment again.',
  severity: 'blocking',
  differenceCents: 0,
  reasonAmounts: { paymentAmount: 1300 },
  ...(canSaveAgain ? {} : { reasonVariant: 'cannot_save' }),
  unsavedPayment: {
    idempotencyKey: 'terminal-card:txn-1',
    method: 'card',
    amount: 13,
    amountCents: 1300,
    currency: 'EUR',
    capturedAt: '2026-09-30T10:05:00Z',
    kind: 'single',
    attempts: 4,
    canSaveAgain,
  },
});

describe('charged payments not saved, in every locale', () => {
  it.each(Object.keys(LOCALES) as Lng[])('%s: the cashier message comes from the code', async (lng) => {
    const t = await translatorFor(lng);
    const notSaved = formatPaymentNotSavedMessage(
      { errorCode: 'PAYMENT_NOT_SAVED', amountCents: 1300, error: NATIVE_ENGLISH },
      t,
      money,
    );
    expect(notSaved).toContain('13.00 €');
    expect(notSaved).not.toMatch(/\{\{\w+\}\}/);
    const pending = formatPaymentNotSavedMessage(
      { errorCode: 'PAYMENT_NOT_SAVED_PENDING', amountCents: 1300 },
      t,
      money,
    );
    expect(pending).toContain('13.00 €');
    expect(pending).not.toEqual(notSaved);
    if (lng !== 'en') {
      expect(notSaved).not.toContain('could not be saved on this till');
      expect(
        formatOperatorFacingError(
          { errorCode: 'PAYMENT_NOT_SAVED', amountCents: 1300, error: NATIVE_ENGLISH },
          'Failed to collect payment',
          t,
        ),
      ).not.toContain('Failed to collect payment');
    }
    expect(formatPaymentNotSavedMessage({ success: false, error: 'boom' }, t, money)).toBeNull();
  });

  it.each(Object.keys(LOCALES) as Lng[])('%s: the Z sentences name the order and the money', async (lng) => {
    const t = await translatorFor(lng);
    const reason = getLocalizedPaymentBlockerReason(notSavedBlocker(true), t, money);
    expect(reason).toContain('A-0077');
    expect(reason).toContain('13.00 €');
    expect(reason).not.toMatch(/\{\{\w+\}\}/);
    const fix = getLocalizedPaymentBlockerFix(notSavedBlocker(true), t, money);
    const cannotSave = getLocalizedPaymentBlockerFix(notSavedBlocker(false), t, money);
    expect(fix.length).toBeGreaterThan(20);
    expect(cannotSave).not.toEqual(fix);
  });

  it('keys each record on its own, next to a set-aside payment of the same order', () => {
    const first = notSavedBlocker(true);
    const second = {
      ...notSavedBlocker(true),
      unsavedPayment: { ...notSavedBlocker(true).unsavedPayment!, idempotencyKey: 'terminal-card:txn-2' },
    };
    expect(paymentBlockerKey(first)).not.toEqual(paymentBlockerKey(second));
    expect(paymentBlockerKey(first)).toBe('order-unsaved-1:payments_not_saved:terminal-card:txn-1');
  });
});
