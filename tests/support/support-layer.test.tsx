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
import {
  buildSingleDeliveryRouteStop,
  buildGoogleMapsDirectionsUrl,
  resolveSyncedBranchOriginFallback,
} from '../../src/renderer/utils/delivery-routing';
import { sortOrdersOldestFirst } from '../../src/renderer/utils/order-sorting';
import {
  buildResolvedAddressDetails,
  getSuggestionStreetLabel,
  selectPrimaryOnlineSuggestions,
  type AddressSuggestion,
} from '../../src/renderer/services/address-workflow';
import {
  calculatePickupToDeliveryTotal,
  getPickupToDeliveryValidationAmount,
  resolvePickupToDeliveryAddress,
} from '../../src/renderer/utils/pickup-to-delivery';
import { parseSpecialAddressInput } from '../../src/renderer/utils/specialAddress';
import { StaffShiftCheckoutFooterActions } from '../../src/renderer/components/modals/StaffShiftCheckoutFooterActions';
import {
  buildShiftCheckoutPrintSnapshot,
  canPrintShiftCheckoutSnapshot,
  queueShiftCheckoutPrint,
  type ShiftCheckoutPrintParams,
} from '../../src/renderer/utils/staffShiftCheckoutPrint';
import {
  normalizeZReportData,
  resolveShiftEarnedTotal,
  resolveZReportPeriod,
} from '../../src/renderer/utils/zReport';
import {
  buildSyncRecoveryIssues,
  getRepresentativeParityFailureReason,
} from '../../src/renderer/components/recovery/sync-recovery-issues';
import {
  resolveTerminalAuthPausePresentation,
  resolveTerminalResetPresentation,
} from '../../src/renderer/utils/terminal-lifecycle';
import {
  isLegacyFallbackAddress,
  resolveSelectedCustomerAddress,
  withMaterializedCustomerAddresses,
} from '../../src/renderer/utils/customer-addresses';
import {
  hasValidSyncedPosMenuItemId,
  normalizePosOrderItems,
} from '../../src/shared/utils/pos-order-items';
import type {
  HealthSupportContext,
  PrinterSupportContext,
} from '../../src/renderer/support';
import { HealthSupportEntryPoint } from '../../src/renderer/components/support/HealthSupportEntryPoint';
import { PrinterSupportEntryPoint } from '../../src/renderer/components/support/PrinterSupportEntryPoint';
import type { SyncQueueItem } from '../../../shared/pos/sync-queue-types';
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

const makeParityItem = (overrides: Partial<SyncQueueItem> = {}): SyncQueueItem => ({
  id: 'parity-1',
  tableName: 'orders',
  recordId: 'order-1',
  operation: 'INSERT',
  data: JSON.stringify({}),
  organizationId: 'org-1',
  createdAt: '2026-04-18T00:28:42.000Z',
  attempts: 0,
  lastAttempt: '2026-04-18T00:28:44.000Z',
  errorMessage: null,
  nextRetryAt: '2026-04-18T00:29:16.000Z',
  retryDelayMs: 1000,
  priority: 0,
  moduleType: 'orders',
  conflictStrategy: 'server-wins',
  version: 1,
  status: 'pending',
  ...overrides,
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

test('legacy delivery customers get a synthetic default address with persisted coordinates', () => {
  const customer = withMaterializedCustomerAddresses({
    id: 'customer-legacy',
    name: 'Basilis Mourouzidis',
    phone: '6986693537',
    address: 'Χαλκέων 13',
    postal_code: '546 31',
    notes: 'Call from downstairs',
    name_on_ringer: 'ΜΟΥΡΟΥΖΙΔΗΣ',
    coordinates: {
      lat: 40.6368049,
      lng: 22.9431048,
    },
    addresses: [],
  });

  assert.equal(customer.addresses.length, 1);
  assert.equal(customer.addresses[0].id, 'legacy:customer-legacy');
  assert.equal(customer.addresses[0].street_address, 'Χαλκέων 13');
  assert.equal(customer.addresses[0].postal_code, '546 31');
  assert.deepEqual(customer.addresses[0].coordinates, {
    lat: 40.6368049,
    lng: 22.9431048,
  });
  assert.equal(isLegacyFallbackAddress(customer.addresses[0]), true);
  assert.equal(resolveSelectedCustomerAddress(customer)?.id, 'legacy:customer-legacy');
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

test('normalizePosOrderItems canonicalizes manual open-price lines', () => {
  const [manualItem] = normalizePosOrderItems([
    {
      id: 'manual-line-1',
      menuItemId: 'manual',
      is_manual: true,
      name: 'Open Price Coffee',
      quantity: 2,
      unitPrice: 3.5,
      totalPrice: 7,
      notes: 'No sugar',
      categoryName: 'Manual',
    },
  ]);

  assert.equal(manualItem.id, 'manual-line-1');
  assert.equal(manualItem.menu_item_id, null);
  assert.equal(manualItem.menuItemId, null);
  assert.equal(manualItem.is_manual, true);
  assert.equal(manualItem.name, 'Open Price Coffee');
  assert.equal(manualItem.quantity, 2);
  assert.equal(manualItem.unit_price, 3.5);
  assert.equal(manualItem.total_price, 7);
  assert.equal(manualItem.notes, 'No sugar');
  assert.equal(manualItem.vat_category_code, 'gr_standard_24');
  assert.equal(manualItem.price_includes_vat, true);
  assert.equal(manualItem.fiscal_document_profile, 'manual_item');
  assert.equal(hasValidSyncedPosMenuItemId(manualItem), true);
});

test('normalizePosOrderItems keeps invalid non-manual ids detectable', () => {
  const [invalidItem] = normalizePosOrderItems([
    {
      id: 'not-a-menu-uuid',
      menuItemId: 'not-a-menu-uuid',
      name: 'Broken Item',
      quantity: 1,
      price: 4.2,
    },
  ]);

  assert.equal(invalidItem.menu_item_id, 'not-a-menu-uuid');
  assert.equal(invalidItem.is_manual, false);
  assert.equal(hasValidSyncedPosMenuItemId(invalidItem), false);
});

test('parity recovery prefers actionable order errors over dependency wait reasons', () => {
  const reason = getRepresentativeParityFailureReason(
    {
      status: 'completed',
      processed: 0,
      failed: 1,
      conflicts: 0,
      remaining: 3,
      error: null,
      reason: null,
    } as never,
    [
      makeParityItem({
        id: 'payment-waiting-parent',
        tableName: 'payments',
        moduleType: 'financial',
        errorMessage: 'Waiting for parent order sync',
      }),
      makeParityItem({
        id: 'order-http-500',
        errorMessage: 'HTTP 500: {"success":false,"error":"Failed to create order"}',
      }),
    ],
  );

  assert.equal(reason, 'HTTP 500: {"success":false,"error":"Failed to create order"}');
});

test('parity recovery does not flag retry-scheduled backlog as stalled processor', () => {
  const result = buildSyncRecoveryIssues({
    systemHealth: {
      parityQueueStatus: {
        pending: 3,
        failed: 0,
        conflicts: 0,
        total: 3,
      },
      syncBacklog: undefined,
      syncBlockerDetails: [],
      invalidOrders: { count: 0, details: [] },
      credentialState: {
        hasAdminUrl: true,
        hasApiKey: true,
      },
    } as never,
    lastParitySync: {
      status: 'completed',
      processed: 0,
      failed: 1,
      conflicts: 0,
      remaining: 3,
      error: null,
      reason: null,
      finishedAt: '2026-04-18T00:28:49.159Z',
    } as never,
    parityItems: [
      makeParityItem({
        id: 'payment-waiting-parent',
        tableName: 'payments',
        moduleType: 'financial',
        errorMessage: 'Waiting for parent order sync',
        nextRetryAt: '2026-04-18T00:29:16.000Z',
      }),
      makeParityItem({
        id: 'order-http-500',
        errorMessage: 'HTTP 500: {"success":false,"error":"Failed to create order"}',
        nextRetryAt: '2026-04-18T00:29:16.000Z',
      }),
    ],
  });

  assert.equal(
    result.issues.some((issue) => issue.id === 'parity-processor-stalled'),
    false,
  );
});

test('recovery marks fresh online waiting-parent payments as recovering and stale ones as blocking', () => {
  const freshCreatedAt = new Date(Date.now() - 5 * 60 * 1000).toISOString();
  const staleCreatedAt = new Date(Date.now() - 15 * 60 * 1000).toISOString();

  const freshResult = buildSyncRecoveryIssues({
    systemHealth: {
      parityQueueStatus: { pending: 0, failed: 0, conflicts: 0, total: 0 },
      syncBacklog: {},
      syncBlockerDetails: [],
      invalidOrders: { count: 0, details: [] },
      credentialState: { hasAdminUrl: true, hasApiKey: true },
      isOnline: true,
    } as never,
    integrity: {
      valid: false,
      issues: [
        {
          entityType: 'payment',
          entityId: 'pay-fresh',
          paymentId: 'pay-fresh',
          reasonCode: 'order_payment_waiting_parent',
          suggestedFix: 'repair_waiting_parent_payments',
          createdAt: freshCreatedAt,
          updatedAt: freshCreatedAt,
          parentHasRemoteIdentity: false,
        },
      ],
    },
  });
  const staleResult = buildSyncRecoveryIssues({
    systemHealth: {
      parityQueueStatus: { pending: 0, failed: 0, conflicts: 0, total: 0 },
      syncBacklog: {},
      syncBlockerDetails: [],
      invalidOrders: { count: 0, details: [] },
      credentialState: { hasAdminUrl: true, hasApiKey: true },
      isOnline: true,
    } as never,
    integrity: {
      valid: false,
      issues: [
        {
          entityType: 'payment',
          entityId: 'pay-stale',
          paymentId: 'pay-stale',
          reasonCode: 'order_payment_waiting_parent',
          suggestedFix: 'repair_waiting_parent_payments',
          createdAt: staleCreatedAt,
          updatedAt: staleCreatedAt,
          parentHasRemoteIdentity: false,
        },
      ],
    },
  });

  assert.equal(freshResult.issues[0]?.status, 'recovering');
  assert.equal(staleResult.issues[0]?.status, 'blocking');
});

test('recovery suppresses duplicate financial parity cards when canonical payment issues exist', () => {
  const result = buildSyncRecoveryIssues({
    systemHealth: {
      parityQueueStatus: { pending: 1, failed: 0, conflicts: 0, total: 1 },
      syncBacklog: {},
      syncBlockerDetails: [],
      invalidOrders: { count: 0, details: [] },
      credentialState: { hasAdminUrl: true, hasApiKey: true },
      isOnline: true,
    } as never,
    parityItems: [
      makeParityItem({
        id: 'legacy-payment-parity',
        tableName: 'payments',
        recordId: 'pay-dup',
        moduleType: 'financial',
      }),
    ],
    integrity: {
      valid: false,
      issues: [
        {
          entityType: 'payment',
          entityId: 'pay-dup',
          paymentId: 'pay-dup',
          reasonCode: 'order_payment_waiting_parent',
          suggestedFix: 'repair_waiting_parent_payments',
          createdAt: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
          updatedAt: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
          parentHasRemoteIdentity: false,
        },
      ],
    },
  });

  assert.equal(
    result.issues.some((issue) => issue.code === 'parity_module_pending_items'),
    false,
  );
  assert.equal(
    result.issues.some((issue) => issue.code === 'order_payment_waiting_parent'),
    true,
  );
});

test('terminal auth pause presentation keeps the POS configured locally', () => {
  const presentation = resolveTerminalAuthPausePresentation(
    {
      requestedTerminalId: 'terminal-manager',
      canonicalTerminalId: 'terminal-efe99d27',
    },
    (key, options) =>
      key === 'system.remoteAuthPausedWithIds'
        ? `paused:${options?.requestedTerminalId}:${options?.canonicalTerminalId}`
        : key,
  );

  assert.equal(presentation.clearLocalSession, false);
  assert.equal(presentation.keepConfigured, true);
  assert.equal(
    presentation.message,
    'paused:terminal-manager:terminal-efe99d27',
  );
});

test('terminal reset presentation remains destructive for inactive terminals', () => {
  const presentation = resolveTerminalResetPresentation(
    'terminal_inactive',
    (key) =>
      key === 'system.terminalInactive'
        ? 'inactive-terminal-message'
        : key,
  );

  assert.equal(presentation.clearLocalSession, true);
  assert.equal(presentation.keepConfigured, false);
  assert.equal(presentation.message, 'inactive-terminal-message');
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

test('parseSpecialAddressInput normalizes #label addresses and skips zone validation', () => {
  const parsed = parseSpecialAddressInput('#E-food');

  assert.equal(parsed.isSpecialLabelInput, true);
  assert.equal(parsed.shouldSkipZoneValidation, true);
  assert.equal(parsed.normalizedAddress, 'E-food');
});

test('parseSpecialAddressInput keeps normal addresses on the validation path', () => {
  const parsed = parseSpecialAddressInput('12 Main Street');

  assert.equal(parsed.isSpecialLabelInput, false);
  assert.equal(parsed.shouldSkipZoneValidation, false);
  assert.equal(parsed.normalizedAddress, '12 Main Street');
});

test('parseSpecialAddressInput rejects empty # labels', () => {
  const parsed = parseSpecialAddressInput('#   ');

  assert.equal(parsed.isSpecialLabelInput, true);
  assert.equal(parsed.shouldSkipZoneValidation, false);
  assert.equal(parsed.normalizedAddress, '');
});

test('buildGoogleMapsDirectionsUrl falls back to current location when store origin is missing', () => {
  const url = buildGoogleMapsDirectionsUrl(null, {
    address: '12 Main Street',
    coordinates: null,
  });

  assert.equal(
    url,
    'https://www.google.com/maps/dir/?api=1&destination=12+Main+Street&travelmode=driving',
  );
});

test('buildGoogleMapsDirectionsUrl includes store origin when configured', () => {
  const url = buildGoogleMapsDirectionsUrl(
    {
      label: 'Store',
      address: '1 Store Road',
      coordinates: null,
    },
    {
      address: '12 Main Street',
      coordinates: null,
    },
  );

  assert.equal(
    url,
    'https://www.google.com/maps/dir/?api=1&destination=12+Main+Street&travelmode=driving&origin=1+Store+Road',
  );
});

test('buildSingleDeliveryRouteStop appends persisted city and postal code to the destination', () => {
  const stop = buildSingleDeliveryRouteStop({
    id: 'order-1',
    delivery_address: 'Γρ. Λαμπράκη 30',
    delivery_city: 'Θεσσαλονίκη',
    delivery_postal_code: '546 38',
  });

  assert.deepEqual(stop, {
    orderId: 'order-1',
    orderNumber: null,
    label: 'Delivery stop',
    address: 'Γρ. Λαμπράκη 30, Θεσσαλονίκη, 546 38',
    coordinates: null,
    createdAt: null,
  });
});

test('buildSingleDeliveryRouteStop does not duplicate city or postal code already present in the saved address', () => {
  const stop = buildSingleDeliveryRouteStop({
    id: 'order-2',
    delivery_address: 'Γρ. Λαμπράκη 30, Θεσσαλονίκη 546 38',
    delivery_city: 'Θεσσαλονίκη',
    delivery_postal_code: '546 38',
  });

  assert.equal(stop?.address, 'Γρ. Λαμπράκη 30, Θεσσαλονίκη 546 38');
});

test('buildGoogleMapsDirectionsUrl uses the full persisted destination for ambiguous saved addresses', () => {
  const stop = buildSingleDeliveryRouteStop({
    id: 'order-3',
    delivery_address: 'Γρ. Λαμπράκη 30',
    delivery_city: 'Θεσσαλονίκη',
    delivery_postal_code: '546 38',
  });

  assert.equal(stop?.address, 'Γρ. Λαμπράκη 30, Θεσσαλονίκη, 546 38');

  const url = buildGoogleMapsDirectionsUrl(
    {
      label: 'Store',
      address: 'Κωνσταντινουπόλεως 62, Θεσσαλονίκη',
      coordinates: null,
    },
    stop!,
  );

  assert.equal(
    url,
    'https://www.google.com/maps/dir/?api=1&destination=%CE%93%CF%81.+%CE%9B%CE%B1%CE%BC%CF%80%CF%81%CE%AC%CE%BA%CE%B7+30%2C+%CE%98%CE%B5%CF%83%CF%83%CE%B1%CE%BB%CE%BF%CE%BD%CE%AF%CE%BA%CE%B7%2C+546+38&travelmode=driving&origin=%CE%9A%CF%89%CE%BD%CF%83%CF%84%CE%B1%CE%BD%CF%84%CE%B9%CE%BD%CE%BF%CF%85%CF%80%CF%8C%CE%BB%CE%B5%CF%89%CF%82+62%2C+%CE%98%CE%B5%CF%83%CF%83%CE%B1%CE%BB%CE%BF%CE%BD%CE%AF%CE%BA%CE%B7',
  );
});

test('resolveSyncedBranchOriginFallback uses terminal branch settings even without restaurant name', () => {
  const settings = new Map<string, unknown>([
    ['terminal.branch_id', 'branch-123'],
    ['terminal.store_address', '1 Store Road'],
  ]);
  const getSetting = <T = unknown>(category: string, key: string, defaultValue?: T): T | undefined => {
    const settingKey = `${category}.${key}`;
    return (settings.has(settingKey) ? settings.get(settingKey) : defaultValue) as T | undefined;
  };

  const origin = resolveSyncedBranchOriginFallback(getSetting, null);

  assert.deepEqual(origin, {
    branchId: 'branch-123',
    label: 'Store',
    address: '1 Store Road',
    coordinates: null,
  });
});

test('getSuggestionStreetLabel prefers the clicked google main text', () => {
  const label = getSuggestionStreetLabel({
    displayLabel: 'Κωνσταντινουπόλεως 37',
    main_text: 'Κωνσταντινουπόλεως 37',
    name: 'Γιάννη Χαλκίδη 37',
    formatted_address: 'Κωνσταντινουπόλεως 37, Θεσσαλονίκη, Ελλάδα',
  });

  assert.equal(label, 'Κωνσταντινουπόλεως 37');
});

test('selectPrimaryOnlineSuggestions keeps autocomplete predictions ahead of richer place results', () => {
  const suggestions = selectPrimaryOnlineSuggestions({
    predictions: [
      {
        place_id: 'place-1',
        description: 'Κωνσταντινουπόλεως 37, Θεσσαλονίκη, Ελλάδα',
        structured_formatting: {
          main_text: 'Κωνσταντινουπόλεως 37',
          secondary_text: 'Θεσσαλονίκη, Ελλάδα',
        },
      },
    ],
    places: [
      {
        place_id: 'place-1',
        name: 'Γιάννη Χαλκίδη 37',
        formatted_address: 'Γιάννη Χαλκίδη 37, Θεσσαλονίκη, Ελλάδα',
      },
    ],
  });

  assert.equal(suggestions.length, 1);
  assert.equal(suggestions[0]?.name, 'Κωνσταντινουπόλεως 37');
  assert.equal(suggestions[0]?.secondary_text, 'Θεσσαλονίκη, Ελλάδα');
});

test('selectPrimaryOnlineSuggestions falls back to places when autocomplete has no predictions', () => {
  const suggestions = selectPrimaryOnlineSuggestions({
    predictions: [],
    places: [
      {
        place_id: 'place-2',
        name: 'Κωνσταντινουπόλεως 37',
        formatted_address: 'Κωνσταντινουπόλεως 37, Θεσσαλονίκη, Ελλάδα',
        location: { lat: 40.6401, lng: 22.9444 },
      },
    ],
  });

  assert.equal(suggestions.length, 1);
  assert.equal(suggestions[0]?.name, 'Κωνσταντινουπόλεως 37');
  assert.deepEqual(suggestions[0]?.location, { lat: 40.6401, lng: 22.9444 });
});

test('buildResolvedAddressDetails preserves the clicked street label while using google metadata', () => {
  const suggestion: AddressSuggestion = {
    place_id: 'place-3',
    name: 'Κωνσταντινουπόλεως 37',
    displayLabel: 'Κωνσταντινουπόλεως 37',
    main_text: 'Κωνσταντινουπόλεως 37',
    secondary_text: 'Θεσσαλονίκη, Ελλάδα',
    formatted_address: 'Κωνσταντινουπόλεως 37, Θεσσαλονίκη, Ελλάδα',
    source: 'online',
  };

  const resolved = buildResolvedAddressDetails(suggestion, {
    place_id: 'place-3',
    formatted_address: 'Γιάννη Χαλκίδη 37, Θεσσαλονίκη 542 49, Ελλάδα',
    address_components: [
      { long_name: 'Γιάννη Χαλκίδη', short_name: 'Γιάννη Χαλκίδη', types: ['route'] },
      { long_name: '37', short_name: '37', types: ['street_number'] },
      { long_name: 'Θεσσαλονίκη', short_name: 'Θεσσαλονίκη', types: ['locality'] },
      { long_name: '542 49', short_name: '542 49', types: ['postal_code'] },
    ],
    geometry: {
      location: {
        lat: 40.6401,
        lng: 22.9444,
      },
    },
  });

  assert.equal(resolved.streetAddress, 'Κωνσταντινουπόλεως 37');
  assert.equal(resolved.city, 'Θεσσαλονίκη');
  assert.equal(resolved.postalCode, '542 49');
  assert.equal(resolved.resolvedStreetNumber, '37');
  assert.deepEqual(resolved.coordinates, { lat: 40.6401, lng: 22.9444 });
});

test('resolvePickupToDeliveryAddress prefers the selected customer address', () => {
  const customerId = '00000000-0000-4000-8000-000000000001';
  const addr1 = '00000000-0000-4000-8000-000000000002';
  const addr2 = '00000000-0000-4000-8000-000000000003';
  const resolved = resolvePickupToDeliveryAddress({
    id: customerId,
    name: 'Alice',
    phone: '12345',
    selected_address_id: addr2,
    addresses: [
      {
        id: addr1,
        customer_id: customerId,
        street_address: '1 First Street',
        city: 'Athens',
        postal_code: '11111',
        is_default: true,
        name_on_ringer: 'Default Bell',
      },
      {
        id: addr2,
        customer_id: customerId,
        street_address: '2 Second Street',
        city: 'Piraeus',
        postal_code: '22222',
        floor_number: '3',
        delivery_notes: 'Side entrance',
        name_on_ringer: 'Second Bell',
        coordinates: { lat: 37.95, lng: 23.63 },
        is_default: false,
      },
    ],
  });

  assert.equal(resolved?.addressId, addr2);
  assert.equal(resolved?.customerId, customerId);
  assert.equal(resolved?.streetAddress, '2 Second Street');
  assert.equal(resolved?.city, 'Piraeus');
  assert.equal(resolved?.postalCode, '22222');
  assert.equal(resolved?.floor, '3');
  assert.equal(resolved?.notes, 'Side entrance');
  assert.equal(resolved?.nameOnRinger, 'Second Bell');
  assert.deepEqual(resolved?.coordinates, { lat: 37.95, lng: 23.63 });
});

test('getPickupToDeliveryValidationAmount uses subtotal minus discount first', () => {
  const amount = getPickupToDeliveryValidationAmount({
    subtotal: 18,
    discount_amount: 3,
    total_amount: 20,
    deliveryFee: 2,
  });

  assert.equal(amount, 15);
});

test('calculatePickupToDeliveryTotal replaces the existing delivery fee', () => {
  const total = calculatePickupToDeliveryTotal(
    {
      totalAmount: 22,
      deliveryFee: 2,
    },
    4,
  );

  assert.equal(total, 24);
});

test('sortOrdersOldestFirst keeps new realtime orders at the bottom', () => {
  const sorted = sortOrdersOldestFirst([
    {
      id: 'order-new',
      order_number: '00003',
      orderNumber: '00003',
      created_at: '2026-03-22T10:10:00.000Z',
      createdAt: '2026-03-22T10:10:00.000Z',
      updated_at: '2026-03-22T10:10:00.000Z',
      updatedAt: '2026-03-22T10:10:00.000Z',
    },
    {
      id: 'order-oldest',
      order_number: '00001',
      orderNumber: '00001',
      created_at: '2026-03-22T10:00:00.000Z',
      createdAt: '2026-03-22T10:00:00.000Z',
      updated_at: '2026-03-22T10:00:00.000Z',
      updatedAt: '2026-03-22T10:00:00.000Z',
    },
    {
      id: 'order-middle',
      order_number: '00002',
      orderNumber: '00002',
      created_at: '2026-03-22T10:05:00.000Z',
      createdAt: '2026-03-22T10:05:00.000Z',
      updated_at: '2026-03-22T10:05:00.000Z',
      updatedAt: '2026-03-22T10:05:00.000Z',
    },
  ]);

  assert.deepEqual(
    sorted.map((order) => order.id),
    ['order-oldest', 'order-middle', 'order-new'],
  );
});

test('staff shift checkout footer actions render print beside checkout', () => {
  const html = renderToStaticMarkup(
    <StaffShiftCheckoutFooterActions
      onPrint={() => {}}
      onCheckout={() => {}}
      printLabel="Print"
      checkoutLabel="Check Out"
    />,
  );

  assert.match(html, /staff-checkout-print-button/);
  assert.match(html, /staff-checkout-confirm-button/);
  assert.match(html, />Print</);
  assert.match(html, />Check Out</);
});

test('staff shift checkout footer actions respect disabled print state', () => {
  const html = renderToStaticMarkup(
    <StaffShiftCheckoutFooterActions
      onPrint={() => {}}
      onCheckout={() => {}}
      printLabel="Print"
      checkoutLabel="Check Out"
      isPrintDisabled
    />,
  );

  assert.match(html, /staff-checkout-print-button/);
  assert.match(html, /disabled=""/);
});

test('cashier checkout print snapshot stays available before counted cash is entered', () => {
  const summary = {
    breakdown: {
      instore: {
        cashTotal: 80,
      },
    },
    totalExpenses: 10,
    cashRefunds: 0,
    cashDrawer: {},
  };
  const shift = {
    role_type: 'cashier',
    opening_cash_amount: 100,
    calculation_version: 2,
  };

  assert.equal(
    canPrintShiftCheckoutSnapshot({
      shift,
      shiftSummary: summary,
      closingCash: '',
      driverActualCash: '',
      isNonFinancialCheckoutRole: false,
    }),
    true,
  );

  const previewSnapshot = buildShiftCheckoutPrintSnapshot({
    shift,
    shiftSummary: summary,
    closingCash: '',
    driverActualCash: '',
    isNonFinancialCheckoutRole: false,
    snapshotCheckOutTime: '2026-03-24T09:20:00.000Z',
  });

  assert.deepEqual(previewSnapshot, {
    snapshotCheckOutTime: '2026-03-24T09:20:00.000Z',
    expectedAmount: 170,
  });

  const snapshot = buildShiftCheckoutPrintSnapshot({
    shift,
    shiftSummary: summary,
    closingCash: '172.00',
    driverActualCash: '',
    isNonFinancialCheckoutRole: false,
    snapshotCheckOutTime: '2026-03-24T09:30:00.000Z',
  });

  assert.deepEqual(snapshot, {
    snapshotCheckOutTime: '2026-03-24T09:30:00.000Z',
    expectedAmount: 170,
    closingAmount: 172,
    varianceAmount: 2,
  });
});

test('driver checkout print snapshot works before and after actual cash is entered', () => {
  const previewSnapshot = buildShiftCheckoutPrintSnapshot({
    shift: {
      role_type: 'driver',
      opening_cash_amount: 25,
    },
    shiftSummary: {
      totalExpenses: 7,
      driverDeliveries: [
        { status: 'delivered', cash_collected: 42 },
        { status: 'cancelled', cash_collected: 1000 },
      ],
    },
    closingCash: '',
    driverActualCash: '',
    isNonFinancialCheckoutRole: false,
    snapshotCheckOutTime: '2026-03-24T09:50:00.000Z',
  });

  assert.deepEqual(previewSnapshot, {
    snapshotCheckOutTime: '2026-03-24T09:50:00.000Z',
    expectedAmount: 60,
  });

  const snapshot = buildShiftCheckoutPrintSnapshot({
    shift: {
      role_type: 'driver',
      opening_cash_amount: 25,
    },
    shiftSummary: {
      totalExpenses: 7,
      driverDeliveries: [
        { status: 'delivered', cash_collected: 42 },
        { status: 'cancelled', cash_collected: 1000 },
      ],
    },
    closingCash: '',
    driverActualCash: '62.00',
    isNonFinancialCheckoutRole: false,
    snapshotCheckOutTime: '2026-03-24T10:00:00.000Z',
  });

  assert.deepEqual(snapshot, {
    snapshotCheckOutTime: '2026-03-24T10:00:00.000Z',
    expectedAmount: 60,
    closingAmount: 62,
    varianceAmount: 2,
  });
});

test('non-financial checkout print snapshot only uses the snapshot timestamp', () => {
  const snapshot = buildShiftCheckoutPrintSnapshot({
    shift: {
      role_type: 'kitchen',
      opening_cash_amount: 0,
    },
    shiftSummary: {},
    closingCash: '',
    driverActualCash: '',
    isNonFinancialCheckoutRole: true,
    snapshotCheckOutTime: '2026-03-24T11:00:00.000Z',
  });

  assert.deepEqual(snapshot, {
    snapshotCheckOutTime: '2026-03-24T11:00:00.000Z',
  });
});

test('queueShiftCheckoutPrint sends snapshot overrides through the bridge', async () => {
  let capturedPayload: ShiftCheckoutPrintParams | null = null;
  const bridge = {
    terminalConfig: {
      getSetting: async (_category: string, _key: string): Promise<unknown> => 'Front Counter',
    },
    shifts: {
      printCheckout: async (params: ShiftCheckoutPrintParams): Promise<unknown> => {
        capturedPayload = params;
        return { success: true };
      },
    },
  };

  await queueShiftCheckoutPrint({
    bridge,
    shiftId: 'shift-1',
    roleType: 'cashier',
    snapshot: {
      snapshotCheckOutTime: '2026-03-24T12:00:00.000Z',
      expectedAmount: 170,
      closingAmount: 172,
      varianceAmount: 2,
    },
  });

  assert.deepEqual(capturedPayload, {
    shiftId: 'shift-1',
    roleType: 'cashier',
    terminalName: 'Front Counter',
    snapshotCheckOutTime: '2026-03-24T12:00:00.000Z',
    expectedAmount: 170,
    closingAmount: 172,
    varianceAmount: 2,
  });
});

test('resolveZReportPeriod supports flat-only payloads', () => {
  assert.deepEqual(
    resolveZReportPeriod({
      periodStart: '2026-03-24T08:00:00Z',
      periodEnd: '2026-03-24T18:00:00Z',
    } as never),
    {
      start: '2026-03-24T08:00:00Z',
      end: '2026-03-24T18:00:00Z',
    },
  );
});

test('normalizeZReportData promotes nested period values to flat compatibility fields', () => {
  const normalized = normalizeZReportData({
    date: '2026-03-24',
    period: {
      start: '2026-03-24T08:00:00Z',
      end: '2026-03-24T18:00:00Z',
    },
    shifts: {
      total: 2,
      cashier: 1,
      driver: 1,
    },
    sales: {
      totalOrders: 10,
      totalSales: 120,
      cashSales: 40,
      cardSales: 80,
    },
    cashDrawer: {
      totalVariance: 0,
      totalCashDrops: 0,
      unreconciledCount: 0,
    },
    expenses: {
      total: 0,
      pendingCount: 0,
    },
    driverEarnings: {
      totalDeliveries: 0,
      totalEarnings: 0,
      unsettledCount: 0,
    },
  });

  assert.equal(normalized?.periodStart, '2026-03-24T08:00:00Z');
  assert.equal(normalized?.periodEnd, '2026-03-24T18:00:00Z');
  assert.equal(normalized?.period?.start, '2026-03-24T08:00:00Z');
  assert.equal(normalized?.period?.end, '2026-03-24T18:00:00Z');
});

test('normalizeZReportData prefers nested period values when both shapes are present', () => {
  const normalized = normalizeZReportData({
    date: '2026-03-24',
    period: {
      start: '2026-03-24T06:00:00Z',
      end: '2026-03-24T16:00:00Z',
    },
    periodStart: '2026-03-24T08:00:00Z',
    periodEnd: '2026-03-24T18:00:00Z',
    shifts: {
      total: 1,
      cashier: 1,
      driver: 0,
    },
    sales: {
      totalOrders: 1,
      totalSales: 10,
      cashSales: 10,
      cardSales: 0,
    },
    cashDrawer: {
      totalVariance: 0,
      totalCashDrops: 0,
      unreconciledCount: 0,
    },
    expenses: {
      total: 0,
      pendingCount: 0,
    },
    driverEarnings: {
      totalDeliveries: 0,
      totalEarnings: 0,
      unsettledCount: 0,
    },
  });

  assert.equal(normalized?.periodStart, '2026-03-24T06:00:00Z');
  assert.equal(normalized?.periodEnd, '2026-03-24T16:00:00Z');
  assert.equal(normalized?.period?.start, '2026-03-24T06:00:00Z');
  assert.equal(normalized?.period?.end, '2026-03-24T16:00:00Z');
});

test('resolveZReportPeriod prefers nested fields when both shapes are present', () => {
  assert.deepEqual(
    resolveZReportPeriod({
      period: {
        start: '2026-03-24T06:00:00Z',
        end: '2026-03-24T16:00:00Z',
      },
      periodStart: '2026-03-24T08:00:00Z',
      periodEnd: '2026-03-24T18:00:00Z',
    } as never),
    {
      start: '2026-03-24T06:00:00Z',
      end: '2026-03-24T16:00:00Z',
    },
  );
});

test('resolveZReportPeriod tolerates a missing end timestamp', () => {
  assert.deepEqual(
    resolveZReportPeriod({
      periodStart: '2026-03-24T08:00:00Z',
    } as never),
    {
      start: '2026-03-24T08:00:00Z',
      end: undefined,
    },
  );
});

test('resolveShiftEarnedTotal uses explicit totals and falls back to cash plus card', () => {
  assert.equal(
    resolveShiftEarnedTotal({
      orders: {
        count: 3,
        cashAmount: 20,
        cardAmount: 30,
        totalAmount: 55,
      },
    } as never),
    55,
  );

  assert.equal(
    resolveShiftEarnedTotal({
      orders: {
        count: 3,
        cashAmount: 20,
        cardAmount: 30,
        totalAmount: Number.NaN,
      },
    } as never),
    50,
  );
});
