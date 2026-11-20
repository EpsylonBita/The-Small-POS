import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import {
  formatCashierCloseRefusal,
  formatZReportLoadFailure,
  getLocalizedPaymentBlockerFix,
  getLocalizedPaymentBlockerReason,
  getLocalizedPaymentMethod,
  getLocalizedPaymentStatus,
} from '../../src/lib/payment-integrity';
import type { UnsettledPaymentBlocker } from '../../src/lib/ipc-contracts';

// Founder incident, 17/09/2026. A Greek till on 1.4.114 refused to close its
// shift and told the operator, in English:
//
//   «The platform settles this order, but EUR 6.50 is recorded as cash/card
//    in the till.»
//   «Void the cash/card row: prepaid and platform-rider COD money never
//    enters the drawer.»
//
// The finding was right — a prepaid platform-delivery order carrying a manual
// card row — but every sentence the 16/09 reconciliation work added was
// written in the desktop classifier and shipped as-is. The reason codes had no
// locale entry at all, so the fallback (the classifier's own English) was what
// a Greek operator read.
//
// These pins keep the operator-facing sentence in the operator's language, and
// keep the money inside it.

const projectRoot = process.cwd();
const overlaysDir = path.join(projectRoot, 'src', 'locales', 'overlays');
const rustPath = path.join(projectRoot, 'src-tauri', 'src', 'payment_integrity.rs');
const LOCALES = ['el', 'en', 'de', 'fr', 'it', 'sq'] as const;

const overlay = (lng: string) =>
  JSON.parse(readFileSync(path.join(overlaysDir, `${lng}.sync-hotfix.json`), 'utf8')) as {
    paymentIntegrity: {
      reasonCodes: Record<string, string>;
      fixCodes: Record<string, string>;
    };
  };

/** Every reason code the desktop classifier can actually emit. */
const emittedReasonCodes = (): string[] => {
  const source = readFileSync(rustPath, 'utf8');
  const classifier = source.slice(
    source.indexOf('fn classify_settlement_shape'),
    source.indexOf('fn collect_unsettled_payment_blockers'),
  );
  const codes = new Set<string>();
  for (const match of classifier.matchAll(/build_blocker(?:_with_severity)?\(\s*&?row,\s*"([a-z_]+)"/g)) {
    codes.add(match[1]);
  }
  return [...codes];
};

/** A minimal i18next-like `t` reading the overlay before the base locale. */
const translatorFor = (lng: string) => {
  const tables = [overlay(lng), JSON.parse(readFileSync(path.join(overlaysDir, '..', `${lng}.json`), 'utf8'))];
  return ((keys: string | string[], options: Record<string, unknown> = {}) => {
    const candidates = Array.isArray(keys) ? keys : [keys];
    for (const key of candidates) {
      const parts = key.split('.');
      const template = tables.map(table => parts.reduce((value, part) => value?.[part], table))
        .find(value => typeof value === 'string');
      if (typeof template === 'string') {
        return template.replace(/\{\{(\w+)\}\}/g, (whole, name: string) =>
          name in options ? String(options[name]) : whole,
        );
      }
    }
    return String(options.defaultValue ?? candidates[0]);
  }) as never;
};

const liveBlocker = (overrides: Partial<UnsettledPaymentBlocker> = {}): UnsettledPaymentBlocker => ({
  orderId: 'e7da8932-14d5-4d88-a355-2e8b5be279c5',
  orderNumber: 'EFOOD-1789587601473-97727248',
  totalAmount: 6.5,
  settledAmount: 6.5,
  paymentStatus: 'paid',
  paymentMethod: 'card',
  reasonCode: 'platform_settlement_mismatch',
  reasonText: 'The platform settles this order, but EUR 6.50 is recorded as cash/card in the till.',
  suggestedFix: 'Void the cash/card row: prepaid and platform-rider COD money never enters the drawer.',
  severity: 'blocking',
  differenceCents: 0,
  reasonAmounts: { drawerAmount: 650 },
  reasonVariant: 'platform_holds',
  ...overrides,
});

test('every reason code the classifier emits has a sentence in every locale', () => {
  const codes = emittedReasonCodes();
  assert.ok(codes.includes('platform_settlement_mismatch'), 'the live code must be covered');
  assert.ok(codes.length >= 4, `expected the settlement-shape codes, got ${codes.join(', ')}`);

  for (const lng of LOCALES) {
    const { reasonCodes, fixCodes } = overlay(lng).paymentIntegrity;
    for (const code of codes) {
      assert.ok(reasonCodes[code], `${lng} is missing paymentIntegrity.reasonCodes.${code}`);
      assert.ok(fixCodes[code], `${lng} is missing paymentIntegrity.fixCodes.${code}`);
    }
  }
});

test('the blocker that stopped the shift reads in Greek, with the money in it', () => {
  const blocker = liveBlocker();
  const t = translatorFor('el');
  const money = (amount: number) => `${amount.toFixed(2)} €`;

  const reason = getLocalizedPaymentBlockerReason(blocker, t, money);
  const fix = getLocalizedPaymentBlockerFix(blocker, t, money);

  assert.equal(reason, `Η πλατφόρμα πληρώνει την παραγγελία ${blocker.orderNumber}, αλλά στο ταμείο έχει καταγραφεί πληρωμή 6.50 € με μετρητά ή κάρτα.`);
  assert.equal(reason.includes('The platform settles'), false, reason);
  assert.equal(/\{\{\w+\}\}/.test(reason), false, `no placeholder may leak: ${reason}`);

  assert.ok(fix.startsWith('Διορθώστε την πληρωμή με μετρητά ή κάρτα'), fix);
  assert.equal(fix.includes('Void the cash/card row'), false, fix);
  assert.equal(/\{\{\w+\}\}/.test(fix), false, `no placeholder may leak: ${fix}`);
});

test('a missing platform payment explains who pays and sends staff to the manager and support', () => {
  const blocker = liveBlocker({
    orderNumber: 'A-009',
    reasonCode: 'platform_settlement_missing',
    reasonVariant: undefined,
    reasonAmounts: undefined,
    settledAmount: 0,
  });
  const money = (amount: number) => `${amount.toFixed(2)} €`;
  const greek = translatorFor('el');
  const english = translatorFor('en');
  assert.equal(getLocalizedPaymentBlockerReason(blocker, greek, money),
    'Η πλατφόρμα πληρώνει την παραγγελία A-009. Η πληρωμή των 6.50 € δεν έχει ακόμη καταγραφεί.');
  assert.equal(getLocalizedPaymentBlockerFix(blocker, greek),
    'Ενημερώστε τον υπεύθυνο. Αν το πρόβλημα παραμένει, καλέστε την υποστήριξη.');
  assert.equal(getLocalizedPaymentBlockerReason(blocker, english, money),
    'The platform pays for order A-009. The payment of 6.50 € has not been recorded yet.');
  assert.equal(getLocalizedPaymentBlockerFix(blocker, english),
    'Tell the manager. If the problem persists, contact support.');
});

test('Z load failures use localized blocker or approval feedback and leave unknown text out', () => {
  const t = translatorFor('en');
  const refusal = {
    errorCode: 'UNSETTLED_PAYMENT_BLOCKER',
    error: 'A native error',
    blockers: [liveBlocker({ reasonCode: 'platform_settlement_missing', reasonVariant: undefined })],
  };
  const fallback = 'The report did not load. Press “Refresh report”.';
  const summary = formatZReportLoadFailure(refusal, t);
  assert.match(summary, /The platform pays for order .*Tell the manager/);
  assert.doesNotMatch(summary, /A native error|settles this order|Void the cash/);
  assert.equal(formatZReportLoadFailure({ ...refusal, blockers: [] }, t), fallback);
  assert.equal(formatZReportLoadFailure({ ...refusal, blockers: [liveBlocker({ reasonCode: 'future_code' })] }, t), fallback);
  assert.equal(formatZReportLoadFailure(new Error('SQLITE_BUSY'), t), fallback);
  assert.equal(formatZReportLoadFailure(new Error('AUTH_SESSION_EXPIRED'), t),
    'The till sign-in has expired. Enter the till PIN again.');
  assert.equal(formatZReportLoadFailure({ success: false, error: { code: 'AUTH_SESSION_REQUIRED' } }, t),
    'Sign in to the till again.');
});

test('cashier close feedback localizes blocker summaries, approval and unknown refusals', () => {
  const t = translatorFor('el');
  const money = (amount: number) => `${amount.toFixed(2)} €`;
  const blocker = liveBlocker({ orderNumber: 'A-40' });
  const refusal = {
    errorCode: 'UNSETTLED_PAYMENT_BLOCKER',
    error: 'Native refusal error.',
    message: 'Native refusal message.',
    blockers: [blocker],
  };
  const banner = formatCashierCloseRefusal(refusal, t, money);
  assert.match(banner, /Η πλατφόρμα πληρώνει την παραγγελία A-40.*6\.50 €.*Διορθώστε/);
  assert.doesNotMatch(banner, /Native refusal|platform settles|Void the cash/);
  assert.equal(formatCashierCloseRefusal(new Error(JSON.stringify(refusal)), t, money), banner);
  const fallback = 'Η βάρδια δεν έκλεισε. Ενημερώστε τον υπεύθυνο.';
  assert.equal(formatCashierCloseRefusal({ ...refusal, blockers: [] }, t, money), fallback);
  assert.equal(formatCashierCloseRefusal({ ...refusal, blockers: [liveBlocker({ reasonCode: 'future_code' })] }, t, money), fallback);
  assert.equal(formatCashierCloseRefusal(new Error('SQLITE_BUSY'), t, money), fallback);
  assert.equal(formatCashierCloseRefusal({ errorCode: 'AUTH_SESSION_EXPIRED', error: 'Native auth failure.' }, t, money),
    'Η σύνδεση του ταμείου έληξε. Πληκτρολογήστε ξανά το PIN του ταμείου.');
  assert.equal(formatCashierCloseRefusal({ code: 'REAUTH_REQUIRED', message: 'Native approval failure.' }, t, money),
    'Ζητήστε έγκριση από τον υπεύθυνο για να κλείσετε τη βάρδια.');
});

test('known and unknown payment methods and statuses have staff labels in all six languages', () => {
  const labels = {
    el: ['Χρέωση δωματίου', 'Επιστράφηκε', 'Άγνωστος τρόπος πληρωμής', 'Άγνωστη κατάσταση πληρωμής'],
    en: ['Room charge', 'Refunded', 'Unknown payment method', 'Unknown payment status'],
    de: ['Zimmerrechnung', 'Erstattet', 'Unbekannte Zahlungsart', 'Unbekannter Zahlungsstatus'],
    fr: ['Frais de chambre', 'Remboursé', 'Mode de paiement inconnu', 'État du paiement inconnu'],
    it: ['Addebito in camera', 'Rimborsato', 'Metodo di pagamento sconosciuto', 'Stato del pagamento sconosciuto'],
    sq: ['Në llogarinë e dhomës', 'Rimbursuar', 'Mënyrë pagese e panjohur', 'Gjendje e panjohur e pagesës'],
  };
  for (const lng of LOCALES) {
    const t = translatorFor(lng);
    assert.deepEqual([
      getLocalizedPaymentMethod('room_charge', t),
      getLocalizedPaymentStatus('refunded', t),
      getLocalizedPaymentMethod('future_method', t),
      getLocalizedPaymentStatus('future_status', t),
    ], labels[lng], lng);
    for (const method of ['gift_card', 'digital']) {
      assert.notEqual(getLocalizedPaymentMethod(method, t), labels[lng][2], lng);
    }
    for (const status of ['processing', 'unpaid', 'waiting_parent']) {
      assert.notEqual(getLocalizedPaymentStatus(status, t), labels[lng][3], lng);
    }
    assert.equal(getLocalizedPaymentMethod('TWINT', t), 'TWINT');
  }
});

test('localized blocker sentences ignore stray amount fields and fall back when an amount is missing', () => {
  const t = translatorFor('el');
  const money = (amount: number) => `${amount.toFixed(2)} €`;
  const unexpected = { defaultValue: 6600, orderNumber: 7777, drawerAmount: 650 };
  const blocker = liveBlocker({ orderNumber: 'A-40', reasonAmounts: unexpected });
  const reason = getLocalizedPaymentBlockerReason(blocker, t, money, '');
  assert.match(reason, /A-40.*6\.50 €/);
  assert.doesNotMatch(reason, /66\.00|77\.77/);
  assert.equal(getLocalizedPaymentBlockerReason({ ...blocker, reasonAmounts: undefined }, t, money, ''), '');
  assert.equal(getLocalizedPaymentBlockerReason({ ...blocker, reasonCode: 'unknown_code' }, t, money, ''), '');
});

test('safe blocker summaries replace an internal order ID while keeping an external number', () => {
  const t = translatorFor('el');
  const money = (amount: number) => `${amount.toFixed(2)} €`;
  const orderId = 'internal-new-order-id';
  const blocker = liveBlocker({
    orderId, orderNumber: orderId, reasonCode: 'payments_not_saved', reasonVariant: 'new_order',
    reasonAmounts: { paymentAmount: 650 },
  });
  const format = (blockers: UnsettledPaymentBlocker[]) => formatCashierCloseRefusal({ blockers }, t, money);
  assert.match(format([blocker]), /νέα παραγγελία/);
  assert.doesNotMatch(format([blocker]), /internal-new-order-id/);
  assert.match(format([blocker, liveBlocker()]), /^2 παραγγελίες χρειάζονται έλεγχο πληρωμής\./);
  assert.doesNotMatch(format([blocker, liveBlocker()]), /internal-new-order-id/);
  assert.match(format([liveBlocker({ orderNumber: 'SHOP-0040' })]), /^SHOP-0040:/);
  assert.match(format([liveBlocker({ orderNumber: 'SHOP-0040' }), blocker]),
    /^2 παραγγελίες χρειάζονται έλεγχο πληρωμής\. Πρώτη για έλεγχο είναι η παραγγελία SHOP-0040\./);
  assert.equal(getLocalizedPaymentBlockerReason(liveBlocker({ orderId, orderNumber: orderId }), t, money, ''), '');
});

test('the two opposite sides of platform_settlement_mismatch do not share one sentence', () => {
  const t = translatorFor('el');
  const money = (amount: number) => `${amount.toFixed(2)} €`;

  const platformHolds = getLocalizedPaymentBlockerReason(liveBlocker(), t, money);
  const storeCollects = getLocalizedPaymentBlockerReason(
    liveBlocker({
      reasonVariant: 'store_collects_platform_order',
      reasonAmounts: { platformSettledAmount: 650 },
    }),
    t,
    money,
  );

  assert.notEqual(platformHolds, storeCollects);
  assert.ok(storeCollects.includes('διανομέας'), storeCollects);
  assert.equal(/\{\{\w+\}\}/.test(storeCollects), false, storeCollects);
});

test('the store-collection fixes name the platform entry and where the real payment came from', () => {
  const t = translatorFor('el');
  const forStore = getLocalizedPaymentBlockerFix(liveBlocker({ reasonVariant: 'store_collects' }), t);
  const forDriver = getLocalizedPaymentBlockerFix(liveBlocker({ reasonVariant: 'store_collects_platform_order' }), t);
  for (const fix of [forStore, forDriver]) {
    assert.ok(fix.startsWith('Διορθώστε την πληρωμή από την πλατφόρμα'), fix);
    assert.ok(fix.includes('. Καταγράψτε'), fix);
  }
  assert.ok(forStore.includes('εισέπραξε πραγματικά το κατάστημα'), forStore);
  assert.ok(forDriver.includes('έφερε πραγματικά πίσω ο διανομέας'), forDriver);
});

test('the blocker helpers honor an explicit fallback while preserving the default for other callers', () => {
  const t = translatorFor('el');
  const blocker = liveBlocker({
    reasonCode: 'a_future_reason_code',
    reasonVariant: undefined,
    reasonAmounts: undefined,
    reasonText: 'Something new the classifier found.',
    suggestedFix: 'Do the new thing.',
  });

  assert.equal(getLocalizedPaymentBlockerReason(blocker, t), 'Something new the classifier found.');
  assert.equal(getLocalizedPaymentBlockerFix(blocker, t), 'Do the new thing.');
  assert.equal(getLocalizedPaymentBlockerReason(blocker, t, undefined, ''), '');
  assert.equal(getLocalizedPaymentBlockerFix(blocker, t, undefined, ''), '');
});

test('the panel passes the operator locale formatter and opts out of native text', () => {
  const panel = readFileSync(
    path.join(projectRoot, 'src', 'renderer', 'components', 'ui', 'UnsettledPaymentBlockersPanel.tsx'),
    'utf8',
  );
  assert.match(panel, /getLocalizedPaymentBlockerReason\(blocker, t, formatCurrency, ""\)/);
  assert.match(panel, /getLocalizedPaymentBlockerFix\(blocker, t, formatCurrency, ""\)/);
});

test('the Review summary names platform payment problems and has a generic label in all six languages', () => {
  const labels = {
    el: ['Ασυμφωνία πληρωμής μεταξύ πλατφόρμας και ταμείου', 'Λείπει η πληρωμή από την πλατφόρμα', 'Άλλο θέμα πληρωμής'],
    en: ['Payment mismatch between the platform and the till', 'Missing platform payment', 'Other payment issue'],
    de: ['Zahlungsabweichung zwischen Plattform und Kasse', 'Plattformzahlung fehlt', 'Anderes Zahlungsproblem'],
    fr: ['Écart de paiement entre la plateforme et la caisse', 'Paiement de la plateforme manquant', 'Autre problème de paiement'],
    it: ['Discrepanza di pagamento tra la piattaforma e la cassa', 'Pagamento della piattaforma mancante', 'Altro problema di pagamento'],
    sq: ['Mospërputhje e pagesës mes platformës dhe arkës', 'Mungon pagesa nga platforma', 'Problem tjetër me pagesën'],
  };
  const keys = [
    'modals.zReport.reconciliationReason.platform_settlement_mismatch',
    'modals.zReport.reconciliationReason.platform_settlement_missing',
    'modals.zReport.reconciliationReasonFallback',
  ];

  for (const lng of LOCALES) {
    const t: (key: string) => string = translatorFor(lng);
    assert.deepEqual(keys.map(key => t(key)), labels[lng], lng);
  }
});
