import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nProvider } from '../../src/renderer/contexts/i18n-context';
import {
  buildHealthSupportContext,
  buildPrinterSupportContext,
  evaluateHealthSupportRules,
  evaluatePrinterSupportRules,
  getHealthSupportExplanation,
} from '../../src/renderer/support';
import type {
  HealthSupportContext,
  PrinterSupportContext,
} from '../../src/renderer/support';
import { HealthSupportEntryPoint } from '../../src/renderer/components/support/HealthSupportEntryPoint';
import { PrinterSupportEntryPoint } from '../../src/renderer/components/support/PrinterSupportEntryPoint';
import i18n from '../../src/lib/i18n';

const createCleanHealthContext = (): HealthSupportContext => ({
  isOnline: true,
  lastSync: '2026-03-20T10:00:00.000Z',
  telemetryLastSync: '2026-03-20T10:00:00.000Z',
  syncError: null,
  pendingItems: 0,
  queuedRemote: 0,
  backpressureDeferred: 0,
  pendingPaymentItems: 0,
  failedPaymentItems: 0,
  terminalHealth: 1,
  totalBacklog: 0,
  isTelemetryStale: false,
  financialPendingCount: 0,
  financialFailedCount: 0,
  invalidOrdersCount: 0,
  invalidOrderIds: [],
  pendingReportDate: null,
  hasBlockedQueue: false,
  hasScheduledRetry: false,
  lastQueueFailure: null,
  systemHealth: null,
});

const createCleanPrinterContext = (): PrinterSupportContext => ({
  view: 'list',
  printersCount: 1,
  hasDefaultPrinter: true,
  selectedPrinterId: 'printer-1',
  selectedPrinterName: 'Receipt Printer',
  selectedPrinterRole: 'receipt',
  selectedPrinterEnabled: true,
  statusState: 'ready',
  statusError: null,
  queueLength: 0,
  verificationStatus: 'verified',
  resolvedTransport: 'tcp',
  resolvedAddress: '192.168.1.20',
  transportReachable: true,
  recentJobsFailed: 0,
  recentJobsTotal: 0,
});

test('buildHealthSupportContext aggregates diagnostics and financial counts', () => {
  const context = buildHealthSupportContext({
    syncStatus: {
      isOnline: true,
      lastSync: '2026-03-20T09:58:00.000Z',
      error: null,
      pendingItems: 3,
      queuedRemote: 2,
      backpressureDeferred: 1,
      pendingPaymentItems: 1,
      failedPaymentItems: 0,
      terminalHealth: 0.85,
      lastQueueFailure: {
        entityType: 'order',
        entityId: 'ord_123',
        status: 'failed',
        classification: 'blocked',
        lastError: 'Validation error',
        retryCount: 3,
        maxRetries: 5,
        nextRetryAt: '2026-03-20T10:05:00.000Z',
      },
    },
    systemHealth: {
      lastSyncTime: '2026-03-20T09:57:00.000Z',
      syncQueue: {
        pending: 1,
        failed: 1,
        details: [],
      },
      invalidOrders: {
        count: 2,
        details: [
          { order_id: 'ord_a' },
          { order_id: 'ord_b' },
        ],
      },
      activeAlerts: [],
    } as never,
    financialStats: {
      driver_earnings: { pending: 1, failed: 0 },
      staff_payments: { pending: 2, failed: 1 },
      shift_expenses: { pending: 0, failed: 2 },
    },
    totalBacklog: 7,
    isTelemetryStale: true,
    hasBlockedQueue: true,
    hasScheduledRetry: true,
    pendingReportDate: '2026-03-19',
  });

  assert.equal(context.financialPendingCount, 3);
  assert.equal(context.financialFailedCount, 3);
  assert.deepEqual(context.invalidOrderIds, ['ord_a', 'ord_b']);
  assert.equal(context.pendingReportDate, '2026-03-19');
  assert.equal(context.lastQueueFailure?.entityId, 'ord_123');
});

test('buildPrinterSupportContext prefers the default printer and diagnostics overrides', () => {
  const context = buildPrinterSupportContext({
    view: 'diagnostics',
    printers: [
      {
        id: 'printer-a',
        name: 'Kitchen',
        role: 'kitchen',
        isDefault: false,
        enabled: true,
      },
      {
        id: 'printer-b',
        name: 'Receipt',
        role: 'receipt',
        isDefault: true,
        enabled: true,
        connectionDetails: {
          capabilities: {
            resolvedTransport: 'usb',
            resolvedAddress: 'USB001',
          },
        },
      },
    ],
    statuses: {
      'printer-b': {
        state: 'ready',
        queueLength: 1,
        verificationStatus: 'verified',
      },
    },
    diagnostics: {
      printerId: 'printer-b',
      verificationStatus: 'verified',
      resolvedTransport: 'tcp',
      resolvedAddress: '10.0.0.8',
      transportReachable: true,
      recentJobs: {
        total: 4,
        failed: 1,
      },
    },
  });

  assert.equal(context.selectedPrinterId, 'printer-b');
  assert.equal(context.selectedPrinterName, 'Receipt');
  assert.equal(context.resolvedTransport, 'tcp');
  assert.equal(context.resolvedAddress, '10.0.0.8');
  assert.equal(context.recentJobsFailed, 1);
});

test('health rules prioritize offline before sync errors', () => {
  const rule = evaluateHealthSupportRules({
    ...createCleanHealthContext(),
    isOnline: false,
    syncError: 'Queue failed',
    failedPaymentItems: 2,
    pendingItems: 3,
  });

  assert.equal(rule?.issueCode, 'health.offline');
});

test('printer rules prioritize missing default profile before offline status', () => {
  const rule = evaluatePrinterSupportRules({
    ...createCleanPrinterContext(),
    hasDefaultPrinter: false,
    statusState: 'offline',
  });

  assert.equal(rule?.issueCode, 'printer.no_default_profile');
});

test('retrieval uses localized generic fallback without marking it as english fallback', () => {
  const explanation = getHealthSupportExplanation(createCleanHealthContext(), 'it');

  assert.equal(explanation.issueCode, null);
  assert.equal(explanation.title, 'Il sistema sembra pronto');
  assert.equal(explanation.usedFallback, false);
});

test('retrieval falls back to english for unsupported locales', () => {
  const explanation = getHealthSupportExplanation(
    {
      ...createCleanHealthContext(),
      isOnline: false,
    },
    'es-ES',
  );

  assert.equal(explanation.title, 'Terminal is offline');
  assert.equal(explanation.usedFallback, true);
});

test('health support entry point renders the open panel in english', async () => {
  await i18n.changeLanguage('en');

  const html = renderToStaticMarkup(
    <I18nProvider>
      <HealthSupportEntryPoint
        context={{
          ...createCleanHealthContext(),
          isOnline: false,
          pendingItems: 4,
        }}
        onExportDiagnostics={() => {}}
        onRefreshStatus={() => {}}
        defaultOpen
      />
    </I18nProvider>,
  );

  assert.match(html, /Explain/);
  assert.match(html, /Terminal is offline/);
  assert.match(html, /Export diagnostics/);
});

test('printer support entry point renders translated german copy', async () => {
  await i18n.changeLanguage('de');

  const html = renderToStaticMarkup(
    <I18nProvider>
      <PrinterSupportEntryPoint
        context={{
          ...createCleanPrinterContext(),
          printersCount: 0,
          hasDefaultPrinter: false,
          selectedPrinterId: null,
          selectedPrinterName: null,
        }}
        onOpenQuickSetup={() => {}}
        defaultOpen
      />
    </I18nProvider>,
  );

  assert.match(html, /Fehlerbehebung/);
  assert.match(html, /Kein Drucker ist konfiguriert/);
  assert.match(html, /Schnellsetup öffnen/);
});
