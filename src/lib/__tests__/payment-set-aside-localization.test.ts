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
  extractPaymentIntegrityPayload,
  formatOperatorFacingError,
  formatSetAsidePaymentMessage,
  getLocalizedPaymentBlockerFix,
  getLocalizedPaymentBlockerReason,
  paymentBlockerKey,
} from '../payment-integrity';

// Fix review 30/09/2026: a payment set aside as a possible duplicate is shown
// to the operator from its code, in the store's language, never as the
// native English sentence (the lesson of the 17/09/2026 Greek till).

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

const reviewBlocker = (paymentId: string): UnsettledPaymentBlocker => ({
  orderId: 'order-dup-1',
  orderNumber: 'A-0042',
  totalAmount: 13,
  settledAmount: 13,
  paymentStatus: 'paid',
  paymentMethod: 'cash',
  reasonCode: 'payments_need_review',
  reasonText: 'A EUR 13.00 cash payment taken at 2026-09-30T10:05:00Z was set aside as a possible duplicate: the order was already paid. It is not counted.',
  suggestedFix: 'Give the money back to the customer, then confirm it here.',
  severity: 'blocking',
  differenceCents: 0,
  reasonAmounts: { paymentAmount: 1300 },
  reviewPayment: {
    paymentId,
    method: 'cash',
    amount: 13,
    amountCents: 1300,
    currency: 'EUR',
    takenAt: '2026-09-30T10:05:00Z',
    reason: 'already_paid',
  },
});

describe('payments set aside for review, in every locale', () => {
  it.each(Object.keys(LOCALES) as Lng[])('%s names the payment and the decision', async (lng) => {
    const t = await translatorFor(lng);
    const reason = getLocalizedPaymentBlockerReason(reviewBlocker('pay-1'), t as never, money);
    const fix = getLocalizedPaymentBlockerFix(reviewBlocker('pay-1'), t as never, money);

    expect(reason).toContain('13.00 €');
    expect(reason).toContain('A-0042');
    for (const sentence of [reason, fix]) {
      expect(sentence).not.toMatch(/\{\{\w+\}\}/);
      expect(sentence).not.toContain('was set aside as a possible duplicate');
    }
    if (lng !== 'en') {
      expect(reason).not.toContain('after it was already paid');
      expect(fix).not.toContain('Give the money back');
    }
    expect(t('paymentIntegrity.statuses.duplicate_review')).not.toBe(
      'paymentIntegrity.statuses.duplicate_review',
    );
  });

  it.each(Object.keys(LOCALES) as Lng[])(
    '%s tells the cashier an approved card was set aside, never in native English',
    async (lng) => {
      const t = await translatorFor(lng);
      const nativeEnglish =
        'This order was already paid. The 13.00 just taken is recorded for a manager to give back and is not counted. Do not charge it again.';
      const covered = formatSetAsidePaymentMessage(
        {
          success: false,
          errorCode: 'PAYMENT_SET_ASIDE_FOR_REVIEW',
          amount: 13,
          amountDue: 0,
          reason: 'order_already_covered',
          error: nativeEnglish,
        },
        t as never,
        money,
      );
      const exceeds = formatSetAsidePaymentMessage(
        {
          success: false,
          errorCode: 'PAYMENT_SET_ASIDE_FOR_REVIEW',
          amount: 13,
          amountDue: 8,
          reason: 'exceeds_amount_due',
        },
        t as never,
        money,
      );
      expect(covered).toContain('13.00 €');
      expect(exceeds).toContain('8.00 €');
      for (const message of [covered, exceeds]) {
        expect(message).not.toMatch(/\{\{\w+\}\}/);
        if (lng !== 'en') {
          expect(message).not.toContain('just taken is recorded');
        }
      }
      // Any operator-facing error path words it from the code too.
      const viaErrorPath = formatOperatorFacingError(
        { errorCode: 'PAYMENT_SET_ASIDE_FOR_REVIEW', amount: 13, error: nativeEnglish },
        'fallback',
        t as never,
      );
      expect(viaErrorPath).not.toBe(nativeEnglish);
      expect(viaErrorPath).not.toBe('fallback');
      expect(viaErrorPath).not.toMatch(/\{\{\w+\}\}/);
    },
  );

  it('uses informal Albanian with real ë and ç', async () => {
    const t = await translatorFor('sq');
    const fix = t('paymentIntegrity.fixCodes.payments_need_review');
    expect(fix).toContain('ë');
    expect(fix).toMatch(/^Ktheja paratë/);
    expect(t('payment.setAside.message', { amount: money(13) })).toContain('Mos i arkëto');
  });

  it('keeps each set-aside payment as its own blocker', () => {
    const payload = extractPaymentIntegrityPayload({
      success: false,
      errorCode: 'UNSETTLED_PAYMENT_BLOCKER',
      blockers: [reviewBlocker('pay-1'), reviewBlocker('pay-2')],
    });
    expect(payload?.blockers).toHaveLength(2);
    const [first, second] = payload!.blockers!;
    expect(first.reviewPayment?.paymentId).toBe('pay-1');
    expect(first.reviewPayment?.takenAt).toBe('2026-09-30T10:05:00Z');
    expect(first.differenceCents).toBe(0);
    expect(paymentBlockerKey(first)).not.toBe(paymentBlockerKey(second));
  });

  it('is silent for any other payment answer', async () => {
    const t = await translatorFor('en');
    expect(formatSetAsidePaymentMessage({ success: false, error: 'boom' }, t as never)).toBeNull();
    expect(formatSetAsidePaymentMessage({ success: true, paymentId: 'p' }, t as never)).toBeNull();
  });
});
