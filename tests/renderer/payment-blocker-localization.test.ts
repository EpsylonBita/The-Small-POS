import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import {
  getLocalizedPaymentBlockerFix,
  getLocalizedPaymentBlockerReason,
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

/** A minimal i18next-like `t` reading straight from one locale overlay. */
const translatorFor = (lng: string) => {
  const table = overlay(lng).paymentIntegrity;
  return ((keys: string | string[], options: Record<string, unknown> = {}) => {
    const candidates = Array.isArray(keys) ? keys : [keys];
    for (const key of candidates) {
      const [, namespace, ...rest] = key.split('.');
      const leaf = rest.join('.');
      const group = (table as Record<string, Record<string, string>>)[namespace];
      const template = group?.[leaf];
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

  assert.ok(reason.includes('πλατφόρμα'), reason);
  assert.ok(reason.includes('6.50 €'), `the amount must survive: ${reason}`);
  assert.equal(reason.includes('The platform settles'), false, reason);
  assert.equal(/\{\{\w+\}\}/.test(reason), false, `no placeholder may leak: ${reason}`);

  // Polite plural, like every other instruction in the product.
  assert.ok(fix.includes('Ακυρώστε'), fix);
  assert.equal(fix.includes('Void the cash/card row'), false, fix);
  assert.equal(/\{\{\w+\}\}/.test(fix), false, `no placeholder may leak: ${fix}`);
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

test('a code no locale has translated still says something true', () => {
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
});

test('the panel hands the localiser the operator locale formatter', () => {
  const panel = readFileSync(
    path.join(projectRoot, 'src', 'renderer', 'components', 'ui', 'UnsettledPaymentBlockersPanel.tsx'),
    'utf8',
  );
  assert.match(panel, /getLocalizedPaymentBlockerReason\(blocker, t, formatCurrency\)/);
  assert.match(panel, /getLocalizedPaymentBlockerFix\(blocker, t, formatCurrency\)/);
});
