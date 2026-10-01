import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import {
  FISCAL_CLOSE_BLOCKED_ERROR_CODE,
  FISCAL_QUEUE_UNREADABLE_REASON,
  extractFiscalCloseBlockedPayload,
  formatFiscalCloseBlockedError,
} from '../../src/lib/fiscal-closeout';
import { formatOperatorFacingError } from '../../src/lib/payment-integrity';

// Field incident 29/09/2026 (Le Petit Paris, Android POS 1.0.12): a Z was
// refused over two queued fiscal submissions with «Close blocked: 2 fiscal
// submission(s)…», an English sentence built in native code, detected with
// startsWith('Close blocked') — a check a translation would have switched
// off. The desktop guard answered the same way, from a command the renderer
// never called. The refusal is now typed (FISCAL_CLOSE_BLOCKED + count +
// businessDay) and the operator reads it in the store's configured language.

const projectRoot = process.cwd();
const localesDir = path.join(projectRoot, 'src', 'locales');
const guardPath = path.join(projectRoot, 'src-tauri', 'src', 'fiscal', 'close_day_guard.rs');
const modalPath = path.join(
  projectRoot,
  'src',
  'renderer',
  'components',
  'modals',
  'ZReportModal.tsx',
);
const LOCALES = ['en', 'el', 'de', 'fr', 'it', 'sq'] as const;

type ZReportLocale = {
  fiscalCloseBlocked: string;
  fiscalCloseBlockedNoDate: string;
  fiscalQueue: Record<string, string>;
};

const zReportLocale = (lng: string): ZReportLocale =>
  JSON.parse(readFileSync(path.join(localesDir, `${lng}.json`), 'utf8')).modals.zReport;

/** A minimal i18next-like `t` over one locale's `modals.zReport` block. */
const translatorFor = (lng: string) => {
  const table = zReportLocale(lng) as unknown as Record<string, unknown>;
  return ((key: string, options: Record<string, unknown> = {}) => {
    const leaf = key.replace(/^modals\.zReport\./, '').split('.');
    let template: unknown = table;
    for (const part of leaf) {
      template = (template as Record<string, unknown> | undefined)?.[part];
    }
    const text = typeof template === 'string' ? template : String(options.defaultValue ?? key);
    return text.replace(/\{\{(\w+)\}\}/g, (whole, name: string) =>
      name in options ? String(options[name]) : whole,
    );
  }) as never;
};

const NATIVE_ENGLISH =
  'Cannot close day: 2 fiscal receipt(s) of 2026-09-29 have not been sent to the tax authority yet.';
const nativeRefusal = {
  success: false,
  errorCode: 'FISCAL_CLOSE_BLOCKED',
  code: 'fiscal_close_blocked',
  reason: 'fiscal_queue_not_empty',
  count: 2,
  businessDay: '2026-09-29',
  activeVerdict: 'unknown',
  fiscalRows: [],
  error: NATIVE_ENGLISH,
  message: NATIVE_ENGLISH,
};
const toGreekDate = (isoDay: string) => isoDay.split('-').reverse().join('/');

test('every POS locale carries the fiscal close-day sentences with their parameters', () => {
  for (const lng of LOCALES) {
    const z = zReportLocale(lng);
    assert.match(z.fiscalCloseBlocked, /\{\{count\}\}/, `${lng}: fiscalCloseBlocked needs {{count}}`);
    assert.match(z.fiscalCloseBlocked, /\{\{date\}\}/, `${lng}: fiscalCloseBlocked needs {{date}}`);
    assert.match(z.fiscalCloseBlockedNoDate, /\{\{count\}\}/, `${lng}: NoDate needs {{count}}`);
    for (const key of [
      'label',
      'pending',
      'pendingNoDate',
      'retryAction',
      'retryRequested',
      'retryFailed',
      'listTitle',
      'attempts',
    ]) {
      assert.ok(z.fiscalQueue?.[key], `${lng} is missing modals.zReport.fiscalQueue.${key}`);
    }
  }
});

test('the refusal reads in each store language, never as the native English', () => {
  const english = zReportLocale('en').fiscalCloseBlocked.split('{{')[0];
  for (const lng of LOCALES) {
    const message = formatFiscalCloseBlockedError(nativeRefusal, translatorFor(lng), toGreekDate);
    assert.ok(message, `${lng}: the typed refusal must be recognised`);
    assert.ok(message.includes('2'), `${lng}: the count must survive: ${message}`);
    assert.ok(message.includes('29/09/2026'), `${lng}: the business day must survive: ${message}`);
    assert.equal(message.includes('Cannot close day'), false, `${lng}: ${message}`);
    assert.equal(/\{\{\w+\}\}/.test(message), false, `${lng}: no placeholder may leak: ${message}`);
    if (lng !== 'en') {
      assert.equal(message.startsWith(english), false, `${lng} fell back to English: ${message}`);
    }
  }
  const greek = formatFiscalCloseBlockedError(nativeRefusal, translatorFor('el'), toGreekDate);
  assert.ok(greek?.includes('φορολογικές υποβολές'), String(greek));
});

test('the operator-facing formatter routes the fiscal refusal to the localized sentence', () => {
  const message = formatOperatorFacingError(nativeRefusal, 'fallback', translatorFor('el'));
  assert.ok(message.startsWith('Η ημέρα δεν μπορεί να κλείσει ακόμα'), message);
  assert.equal(message.includes(NATIVE_ENGLISH), false);
});

test('the refusal is detected by its code, never by its text', () => {
  // A translated message without the code is not a fiscal refusal.
  assert.equal(
    extractFiscalCloseBlockedPayload({ success: false, message: 'Close blocked: 2 fiscal submission(s)' }),
    null,
  );
  // The legacy zreport_generate command answers Err(<json string>).
  const legacy = extractFiscalCloseBlockedPayload(JSON.stringify({ ...nativeRefusal, errorCode: undefined }));
  assert.deepEqual(legacy, {
    count: 2,
    businessDay: '2026-09-29',
    activeVerdict: 'unknown',
    reason: 'fiscal_queue_not_empty',
  });
  // Wrapped in an error object or an Error.
  assert.equal(extractFiscalCloseBlockedPayload({ error: nativeRefusal })?.count, 2);
  assert.equal(
    extractFiscalCloseBlockedPayload(new Error(JSON.stringify(nativeRefusal)))?.businessDay,
    '2026-09-29',
  );
  // Without a business day the sentence drops the date.
  const noDate = formatFiscalCloseBlockedError(
    { errorCode: FISCAL_CLOSE_BLOCKED_ERROR_CODE, count: 1 },
    translatorFor('de'),
  );
  assert.equal(noDate, zReportLocale('de').fiscalCloseBlockedNoDate.replace('{{count}}', '1'));
});

test('the native guard and the renderer agree on the refusal code', () => {
  const guard = readFileSync(guardPath, 'utf8');
  const match = guard.match(/pub const FISCAL_CLOSE_BLOCKED_ERROR_CODE: &str = "([A-Z_]+)";/);
  assert.ok(match, 'the native refusal code constant must exist');
  assert.equal(match?.[1], FISCAL_CLOSE_BLOCKED_ERROR_CODE);
  const unreadable = guard.match(/pub const FISCAL_QUEUE_UNREADABLE_REASON: &str = "([a-z_]+)";/);
  assert.ok(unreadable, 'the native unreadable-queue reason constant must exist');
  assert.equal(unreadable?.[1], FISCAL_QUEUE_UNREADABLE_REASON);
});

// Review of the 29/09/2026 fixes: a fiscal queue the guard cannot read now
// holds the close (it used to read as "nothing queued"). The same code, with
// `reason: fiscal_queue_unreadable` and no count: the operator reads that
// the submissions could not be checked, never "0 not sent".
test('an unreadable fiscal queue reads as "could not be checked" in each store language', () => {
  const unreadableRefusal = {
    ...nativeRefusal,
    reason: FISCAL_QUEUE_UNREADABLE_REASON,
    count: null,
    checkError: 'count queued fiscal submissions: no such table: parity_sync_queue',
    error: 'Cannot close day: the fiscal submissions of 2026-09-29 could not be checked.',
    message: 'Cannot close day: the fiscal submissions of 2026-09-29 could not be checked.',
  };
  for (const lng of LOCALES) {
    const z = zReportLocale(lng) as unknown as Record<string, string>;
    assert.match(z.fiscalCloseCheckFailed, /\{\{date\}\}/, `${lng}: fiscalCloseCheckFailed needs {{date}}`);
    assert.ok(z.fiscalCloseCheckFailedNoDate, `${lng}: fiscalCloseCheckFailedNoDate missing`);
    const message = formatFiscalCloseBlockedError(unreadableRefusal, translatorFor(lng), toGreekDate);
    assert.equal(
      message,
      z.fiscalCloseCheckFailed.replace('{{date}}', '29/09/2026'),
      `${lng}: ${message}`,
    );
    assert.equal(message?.includes('parity_sync_queue'), false);
    const noDate = formatFiscalCloseBlockedError(
      { ...unreadableRefusal, businessDay: null },
      translatorFor(lng),
    );
    assert.equal(noDate, z.fiscalCloseCheckFailedNoDate, `${lng}: ${noDate}`);
  }
  assert.equal(
    formatOperatorFacingError(unreadableRefusal, 'fallback', translatorFor('el')),
    (zReportLocale('el') as unknown as Record<string, string>).fiscalCloseCheckFailed.replace(
      '{{date}}',
      '2026-09-29',
    ),
  );
});

test('the Z modal localizes the refusal before any generic formatting and holds the commit', () => {
  const modal = readFileSync(modalPath, 'utf8');
  const submit = modal.slice(modal.indexOf('const handleSubmitReport = useCallback'));
  const fiscal = submit.indexOf('formatFiscalCloseBlockedError(res, t, formatFiscalBusinessDay)');
  const generic = submit.indexOf('formatOperatorFacingError(');
  assert.ok(fiscal > 0, 'the submit handler must localize the typed fiscal refusal');
  assert.ok(fiscal < generic, 'the fiscal refusal must be recognised before generic formatting');
  assert.match(
    modal,
    /const closeoutHasHardSubmitBlocker =[\s\S]*?fiscalQueueBlocking \|\|[\s\S]*?blockingPaymentIssues\.length > 0;/,
    'queued fiscal receipts of the window must hold the commit button',
  );
  assert.match(modal, /data-z-report-fiscal-retry/);
  assert.match(modal, /retryModule\('fiscal'\)/);
});
