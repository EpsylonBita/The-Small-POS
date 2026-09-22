import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import {
  resolvePlatformHeldNotice,
  SETTLEMENT_RECONCILIATION_REQUIRED_KEY,
} from '../../../shared/platforms/payment-coverage';

// Founder request, 16/09/2026: «Η πληρωμή έχει εισπραχθεί από την πλατφόρμα.
// Μην εισπράξετε μετρητά ή κάρτα από τον πελάτη.»
//
// The write paths already REFUSE a cash/card row on platform-held money. This
// is the operator-facing half: say it before they try, instead of letting them
// meet a generic error at the counter with a customer waiting.
//
// Presentation only. The banner resolves through the SAME collectability logic
// the refusal uses, and — deliberately — never through `payment_status`, which
// a failed settlement honestly lowers to `pending` at exactly the moment the
// warning matters most.

const projectRoot = process.cwd();
const noticePath = path.join(
  projectRoot, 'src', 'renderer', 'components', 'ui', 'PlatformHeldPaymentNotice.tsx',
);
const orderDetailsPath = path.join(
  projectRoot, 'src', 'renderer', 'components', 'modals', 'OrderDetailsModal.tsx',
);
const splitPath = path.join(
  projectRoot, 'src', 'renderer', 'components', 'modals', 'SplitPaymentModal.tsx',
);
const singlePath = path.join(
  projectRoot, 'src', 'renderer', 'components', 'modals', 'SinglePaymentCollectionModal.tsx',
);
const localesDir = path.join(projectRoot, 'src', 'locales');
const LOCALES = ['el', 'en', 'de', 'fr', 'it', 'sq'] as const;

const read = (file: string) => readFileSync(file, 'utf8');
const loadLocale = (lng: string) =>
  JSON.parse(read(path.join(localesDir, `${lng}.json`))) as Record<string, unknown>;
const get = (obj: unknown, dotted: string): unknown =>
  dotted.split('.').reduce<unknown>(
    (acc, key) => (acc && typeof acc === 'object' ? (acc as Record<string, unknown>)[key] : undefined),
    obj,
  );

const efood = (food_delivery: Record<string, unknown>, paymentStatus = 'pending') => ({
  id: 'ord-1',
  platform: 'efood',
  paymentStatus,
  totalAmount: 12.1,
  ghostMetadata: { food_delivery },
});

test('1. a platform-held order resolves to the "do not collect" notice', () => {
  assert.equal(
    resolvePlatformHeldNotice(efood({ prepaid: true, payment_method: 'online' })),
    'platform_settled',
  );
  assert.equal(
    resolvePlatformHeldNotice(
      efood({ prepaid: false, payment_method: 'cash', delivery_provider: 'platform_delivery' }),
    ),
    'platform_settled',
  );
});

test('2. a platform order OUR driver carries shows nothing', () => {
  assert.equal(
    resolvePlatformHeldNotice(
      efood({ prepaid: false, payment_method: 'cash', delivery_provider: 'vendor_delivery' }),
    ),
    null,
  );
  // Neither does a plain store order, nor one whose disposition we lack.
  assert.equal(resolvePlatformHeldNotice({ id: 'o', platform: 'pos', totalAmount: 5 }), null);
  assert.equal(resolvePlatformHeldNotice({ id: 'o', platform: 'efood', totalAmount: 5 }), null);
});

test('3. an unsynced settlement escalates to the reconciliation wording', () => {
  assert.equal(
    resolvePlatformHeldNotice(
      efood({
        prepaid: true,
        payment_method: 'online',
        [SETTLEMENT_RECONCILIATION_REQUIRED_KEY]: true,
      }),
    ),
    'platform_settlement_unsynced',
  );
});

test('the notice never keys on payment_status', () => {
  // A failed settlement leaves `pending`, which reads exactly like money owed.
  for (const status of ['pending', 'partially_paid', 'paid']) {
    assert.equal(
      resolvePlatformHeldNotice(efood({ prepaid: true, payment_method: 'online' }, status)),
      'platform_settled',
      `payment_status=${status} must not change the notice`,
    );
  }
  // Strip comments: the file EXPLAINS why it ignores the field, which is not
  // the same as reading it.
  const source = read(noticePath)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  assert.ok(
    !/payment_status|paymentStatus/.test(source),
    'the banner must not read payment_status in code',
  );
  // It reads the shared collectability logic, not a fresh string check.
  assert.match(source, /resolvePlatformHeldNotice/);
  assert.match(source, /shared\/platforms\/payment-coverage/);
});

test('4. every collect surface shows it and disables the tender actions', () => {
  // Order details: the banner sits under the payment status, and the collect
  // action is withheld.
  const details = read(orderDetailsPath);
  assert.match(details, /<PlatformHeldPaymentNotice order=\{platformHeldOrder\}/);
  assert.match(details, /const platformHeldNotice = usePlatformHeldNotice\(platformHeldOrder\)/);
  assert.match(details, /const canSplitPayment =\s*\n\s*!isCancelledOrder &&\s*\n\s*platformHeldNotice === null/);

  // Split payment: resolved by order id, folded into the existing collect
  // lock so every confirm/portion path is covered at once.
  const split = read(splitPath);
  assert.match(split, /const platformHeldNotice = usePlatformHeldNoticeForOrderId\(orderId, isOpen\)/);
  assert.match(split, /const platformHeld = platformHeldNotice !== null;/);
  assert.match(split, /<PlatformHeldPaymentNotice\s*\n\s*notice=\{platformHeldNotice\}\s*\n\s*showBlockedAction/);
  assert.match(split, /!isReconciliationPending && !platformHeld,/);
  assert.match(split, /if \(isReconciliationPending \|\| platformHeld\) return;/);
  assert.match(split, /isTerminalChargeInFlight \|\| isReconciliationPending \|\| platformHeld;/);

  // Single collection: banner replaces the "Payment Required" prompt, and
  // both the button and the Enter shortcut are disabled.
  const single = read(singlePath);
  assert.match(single, /const platformHeldNotice = usePlatformHeldNoticeForOrderId\(orderId, isOpen\)/);
  assert.match(single, /<PlatformHeldPaymentNotice notice=\{platformHeldNotice\} showBlockedAction \/>/);
  assert.match(single, /isProcessing \|\| amountToCollect <= 0\.009 \|\| platformHeldNotice !== null/);
  assert.match(single, /amountToCollect > 0\.009 && platformHeldNotice === null/);
});

test('every locale carries the operator copy', () => {
  const KEYS = ['title', 'body', 'unsyncedTitle', 'unsyncedBody', 'blockedAction'] as const;
  for (const lng of LOCALES) {
    const locale = loadLocale(lng);
    for (const key of KEYS) {
      const value = get(locale, `payment.platformHeld.${key}`);
      assert.equal(typeof value, 'string', `${lng}: payment.platformHeld.${key} must be translated`);
      assert.ok(
        (value as string).trim().length > 0 && !(value as string).startsWith('[NEEDS TRANSLATION]'),
        `${lng}: payment.platformHeld.${key} is empty or untranslated`,
      );
    }
  }
});
