import i18next from 'i18next';
import { describe, expect, it } from 'vitest';

import en from '../../../locales/en.json';
import el from '../../../locales/el.json';
import de from '../../../locales/de.json';
import fr from '../../../locales/fr.json';
import it_ from '../../../locales/it.json';
import sq from '../../../locales/sq.json';
import type { UnsettledPaymentBlocker } from '../../../lib/ipc-contracts';
import {
  getLocalizedPaymentBlockerFix,
  getLocalizedPaymentBlockerReason,
} from '../../../lib/payment-integrity';

// Item D (founder decision 30/09/2026): the server refuses cash/card on money
// the delivery platform holds (409 PLATFORM_HELD_ORDER). The payment is set
// aside for review, and the Z says plainly, in the store's language, that the
// platform already holds this order's money: never the duplicate sentence.

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

const setAside = (reasonVariant?: string): UnsettledPaymentBlocker => ({
  orderId: 'order-platform-held',
  orderNumber: 'A-0101',
  totalAmount: 13,
  settledAmount: 0,
  paymentStatus: 'paid',
  paymentMethod: 'card',
  reasonCode: 'payments_need_review',
  reasonText:
    "A EUR 13.00 card payment taken at 2026-09-30T10:05:00Z was set aside: the delivery platform already holds this order's money. It is not counted.",
  suggestedFix: 'Give the money back to the customer, then confirm it here.',
  severity: 'blocking',
  differenceCents: 0,
  reasonAmounts: { paymentAmount: 1300 },
  ...(reasonVariant ? { reasonVariant } : {}),
  reviewPayment: {
    paymentId: 'pay-platform-card',
    method: 'card',
    amount: 13,
    amountCents: 1300,
    currency: 'EUR',
    takenAt: '2026-09-30T10:05:00Z',
    reason: reasonVariant ?? 'already_paid',
  },
});

// A word every locale's sentence uses for the delivery platform.
const PLATFORM_WORD: Record<Lng, RegExp> = {
  en: /platform/i,
  el: /πλατφόρμα/i,
  de: /plattform/i,
  fr: /plateforme/i,
  it: /piattaforma/i,
  sq: /platform/i,
};

describe('a payment refused on platform-held money, in every locale', () => {
  it.each(Object.keys(LOCALES) as Lng[])('%s: the Z says the platform holds the money', async (lng) => {
    const t = await translatorFor(lng);
    const heldReason = getLocalizedPaymentBlockerReason(setAside('platform_held'), t, money);
    const duplicateReason = getLocalizedPaymentBlockerReason(setAside(), t, money);
    expect(heldReason).toContain('A-0101');
    expect(heldReason).toContain('13.00 €');
    expect(heldReason).toMatch(PLATFORM_WORD[lng]);
    expect(heldReason).not.toMatch(/\{\{\w+\}\}/);
    expect(heldReason).not.toEqual(duplicateReason);

    const heldFix = getLocalizedPaymentBlockerFix(setAside('platform_held'), t, money);
    expect(heldFix).toMatch(PLATFORM_WORD[lng]);
    expect(heldFix).not.toEqual(getLocalizedPaymentBlockerFix(setAside(), t, money));
  });
});
