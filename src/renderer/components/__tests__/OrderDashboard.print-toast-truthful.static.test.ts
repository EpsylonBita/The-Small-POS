import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Symptom (desktop 1.4.123): Print in the order details said "Receipt printed
 * successfully" the moment the job was queued. `payment:print-receipt` only
 * queues the job and spawns processing, so a food print waiting for its efood
 * items (or any job that later failed) was reported as printed.
 *
 * This is a source guard because the dashboard host needs its whole context
 * tree to mount; the outcome classification it now relies on is tested
 * behaviorally in printing/__tests__/PrintQueuePanel.foodItems.test.tsx.
 */
const SOURCE = fs.readFileSync(path.join(__dirname, '..', 'OrderDashboard.tsx'), 'utf8');
const LOCALES = ['en', 'el', 'de', 'fr', 'it', 'sq'] as const;
const NEW_TOAST_KEYS = ['printSent', 'printQueued', 'printWaitingForItems', 'printNotPrinted'] as const;
const NEW_REASON_KEYS = ['foodOrderItemsPending', 'foodOrderItemsUnavailable'] as const;

function viewModalPrintHandler(): string {
  const marker = SOURCE.indexOf('id: "dashboard-view-print"');
  expect(marker).toBeGreaterThan(-1);
  const start = SOURCE.lastIndexOf('onPrintReceipt={async () => {', marker);
  expect(start).toBeGreaterThan(-1);
  const end = SOURCE.indexOf('<OrderApprovalPanel', marker);
  expect(end).toBeGreaterThan(start);
  return SOURCE.slice(start, end);
}

function readLocale(locale: string): Record<string, any> {
  const file = path.join(__dirname, '..', '..', '..', 'locales', `${locale}.json`);
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

describe('order details Print toast', () => {
  it('never claims a printed receipt from the queueing reply', () => {
    const handler = viewModalPrintHandler();
    expect(handler).not.toMatch(/orderApprovalPanel\.printSuccess/);
    expect(handler).not.toMatch(/printed successfully/i);
  });

  it('reads the queued job outcome and names waiting, sent, failed and still-queued apart', () => {
    const handler = viewModalPrintHandler();
    expect(handler).toMatch(/observeQueuedPrintJob\(\s*bridge\.printer\.listJobs,\s*jobId/);
    expect(handler).toMatch(/outcome\.kind === "waiting"[\s\S]*?orderApprovalPanel\.printWaitingForItems/);
    expect(handler).toMatch(/outcome\.kind === "sent"[\s\S]*?orderApprovalPanel\.printSent/);
    expect(handler).toMatch(/outcome\.kind === "not_printed"[\s\S]*?orderApprovalPanel\.printNotPrinted/);
    expect(handler).toMatch(/orderApprovalPanel\.printQueued/);
    expect(handler).toMatch(/orderApprovalPanel\.printAlreadyQueued/);
    expect(handler).toMatch(/orderApprovalPanel\.printSkipped/);
  });

  it('ships every new message in all six POS languages', () => {
    for (const locale of LOCALES) {
      const bundle = readLocale(locale);
      for (const key of NEW_TOAST_KEYS) {
        expect(typeof bundle.orderApprovalPanel?.[key], `${locale} orderApprovalPanel.${key}`).toBe('string');
        expect(bundle.orderApprovalPanel[key].trim().length).toBeGreaterThan(0);
      }
      for (const key of NEW_REASON_KEYS) {
        const value = bundle.settings?.printQueue?.issue?.[key];
        expect(typeof value, `${locale} settings.printQueue.issue.${key}`).toBe('string');
        expect(value.trim().length).toBeGreaterThan(0);
      }
    }
    const en = readLocale('en');
    for (const locale of LOCALES.filter((code) => code !== 'en')) {
      const bundle = readLocale(locale);
      for (const key of NEW_REASON_KEYS) {
        expect(bundle.settings.printQueue.issue[key], `${locale} must be translated`).not.toBe(
          en.settings.printQueue.issue[key],
        );
      }
      for (const key of NEW_TOAST_KEYS) {
        expect(bundle.orderApprovalPanel[key], `${locale} must be translated`).not.toBe(
          en.orderApprovalPanel[key],
        );
      }
    }
  });
});
