import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
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
  isViewAccessDenied,
  resolveViewModuleId,
} from '../../src/renderer/utils/module-view-access';
import { isModuleRequiredApiError } from '../../src/renderer/utils/api-helpers';
import {
  FOLIO_STATUSES,
  FOLIO_STATUS_PRESENTATION,
  folioChargesEndpoint,
  folioCheckoutEndpoint,
  folioPaymentsEndpoint,
  isFolioStatus,
  parseFolioCheckoutOutstanding,
  summarizeFolios,
} from '../../src/renderer/utils/guest-billing';
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
  resolveCanonicalCustomerAddress,
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

test('resolveCanonicalCustomerAddress honors selected_address_id and preserves floor aliases', () => {
  const customer = {
    id: 'customer-1',
    name: 'Alice',
    phone: '12345',
    selected_address_id: 'addr-2',
    addresses: [
      {
        id: 'addr-1',
        customer_id: 'customer-1',
        street_address: '1 First Street',
        city: 'Athens',
        postal_code: '11111',
        is_default: true,
      },
      {
        id: 'addr-2',
        customer_id: 'customer-1',
        street_address: '2 Second Street',
        city: 'Piraeus',
        postal_code: '22222',
        floor_number: '3',
        notes: 'Side entrance',
        name_on_ringer: 'Second Bell',
        latitude: 37.95,
        longitude: 23.63,
        is_default: false,
      },
    ],
  };

  const resolved = resolveCanonicalCustomerAddress(customer);

  assert.equal(resolved?.id, 'addr-2');
  assert.equal(resolved?.street_address, '2 Second Street');
  assert.equal(resolved?.street, '2 Second Street');
  assert.equal(resolved?.postal_code, '22222');
  assert.equal(resolved?.postalCode, '22222');
  assert.equal(resolved?.floor_number, '3');
  assert.equal(resolved?.floor, '3');
  assert.equal(resolved?.notes, 'Side entrance');
  assert.equal(resolved?.delivery_notes, 'Side entrance');
  assert.equal(resolved?.name_on_ringer, 'Second Bell');
  assert.equal(resolved?.nameOnRinger, 'Second Bell');
  assert.equal(resolved?.latitude, 37.95);
  assert.equal(resolved?.longitude, 23.63);
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

test('normalizePosOrderItems preserves alternate customization shapes', () => {
  const modifierCustomization = [{ ingredient_id: 'extra-cheese', quantity: 1 }];
  const ingredientCustomization = [{ ingredientId: 'no-onion', action: 'without' }];
  const [modifierItem, ingredientItem] = normalizePosOrderItems([
    {
      id: 'line-with-modifier',
      menuItemId: 'menu-item-1',
      name: 'Toast',
      quantity: 1,
      price: 4,
      modifiers: modifierCustomization,
    },
    {
      id: 'line-with-ingredient',
      menuItemId: 'menu-item-2',
      name: 'Burger',
      quantity: 1,
      price: 8,
      ingredients: ingredientCustomization,
    },
  ]);

  assert.deepEqual(modifierItem.customizations, modifierCustomization);
  assert.deepEqual(ingredientItem.customizations, ingredientCustomization);
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

test('recovery maps payment total conflicts to the guided repair action and suppresses generic payment card', () => {
  const result = buildSyncRecoveryIssues({
    systemHealth: {
      parityQueueStatus: { pending: 0, failed: 1, conflicts: 0, total: 1 },
      syncBacklog: {},
      syncBlockerDetails: [],
      invalidOrders: { count: 0, details: [] },
      credentialState: { hasAdminUrl: true, hasApiKey: true },
      isOnline: true,
    } as never,
    parityItems: [
      makeParityItem({
        id: 'payment-conflict-row',
        tableName: 'payments',
        recordId: 'local-payment-1',
        moduleType: 'payment',
        status: 'failed',
        nextRetryAt: null,
        errorMessage:
          'HTTP 422: {"success":false,"error":"Payment exceeds order total","details":"Order total: 8.18, tip: 0, existing completed: 0, payment: 10.4"}',
        data: JSON.stringify({
          paymentId: 'local-payment-1',
          orderId: 'local-order-1',
          remote_payment_id: 'remote-payment-1',
          amount: 10.4,
          settlement_adjustments: [
            {
              adjustment_id: 'adjustment-1',
              payment_id: 'local-payment-1',
              order_id: 'local-order-1',
              adjustment_type: 'refund',
              adjustment_context: 'edit_settlement',
              amount_cents: 222,
              idempotency_key: 'adjustment:adjustment-1',
            },
          ],
        }),
      }),
    ],
  });

  const issue = result.issues.find((candidate) => candidate.code === 'payment_total_conflict');
  assert.ok(issue, 'guided payment total conflict issue should be present');
  assert.equal(issue?.paymentId, 'local-payment-1');
  assert.equal(issue?.orderId, 'local-order-1');
  assert.equal(issue?.params?.remoteOrderTotal, '8.18');
  assert.equal(issue?.params?.paymentAmount, '10.40');
  assert.equal(issue?.params?.settlementMath, '10.40 - 2.22 = 8.18');
  assert.deepEqual(
    issue?.actions.map((action) => action.id),
    ['repairPaymentTotalConflict', 'retryParityItem', 'runParitySyncNow'],
  );
  assert.equal(issue?.actions[0]?.recommended, true);
  assert.equal(
    result.issues.some((candidate) => candidate.code === 'parity_module_failed_items'),
    false,
  );
});

test('recovery maps catalog availability 405 failures to a guided retry and suppresses generic catalog card', () => {
  const result = buildSyncRecoveryIssues({
    systemHealth: {
      parityQueueStatus: { pending: 0, failed: 1, conflicts: 0, total: 1 },
      syncBacklog: {},
      syncBlockerDetails: [],
      invalidOrders: { count: 0, details: [] },
      credentialState: { hasAdminUrl: true, hasApiKey: true },
      isOnline: true,
    } as never,
    parityItems: [
      makeParityItem({
        id: 'catalog-405-row',
        tableName: 'subcategories',
        recordId: 'subcategory-1',
        moduleType: 'catalog',
        status: 'failed',
        errorMessage:
          "HTTP 405: Generic POS sync updates are not allowed for 'subcategories'",
      }),
    ],
  });

  const issue = result.issues.find(
    (candidate) => candidate.code === 'catalog_availability_retry',
  );
  assert.ok(issue, 'guided catalog availability issue should be present');
  assert.equal(issue?.params?.sampleTableName, 'subcategories');
  assert.deepEqual(
    issue?.actions.map((action) => action.id),
    ['retryParityItem', 'retryParityModule', 'runParitySyncNow'],
  );
  assert.equal(issue?.actions[0]?.recommended, true);
  assert.equal(
    result.issues.some((candidate) => candidate.code === 'parity_module_failed_items'),
    false,
  );
});

test('recovery maps invalid driver order failures to a guided repair and suppresses generic order card', () => {
  const result = buildSyncRecoveryIssues({
    systemHealth: {
      parityQueueStatus: { pending: 0, failed: 1, conflicts: 0, total: 1 },
      syncBacklog: {},
      syncBlockerDetails: [],
      invalidOrders: { count: 0, details: [] },
      credentialState: { hasAdminUrl: true, hasApiKey: true },
      isOnline: true,
    } as never,
    parityItems: [
      makeParityItem({
        id: 'order-invalid-driver-row',
        tableName: 'orders',
        recordId: 'local-order-1',
        moduleType: 'orders',
        operation: 'UPDATE',
        status: 'failed',
        nextRetryAt: null,
        errorMessage: 'HTTP 400: {"success":false,"error":"Invalid driver"}',
        data: JSON.stringify({
          orderId: 'local-order-1',
          status: 'delivered',
          driverId: 'b96b6236-8164-4881-b45f-b75c1c79859c',
          driverName: 'Driver Name',
        }),
      }),
    ],
  });

  const issue = result.issues.find(
    (candidate) => candidate.code === 'order_invalid_driver_update',
  );
  assert.ok(issue, 'guided invalid-driver order issue should be present');
  assert.equal(issue?.orderId, 'local-order-1');
  assert.equal(issue?.params?.driverId, 'b96b6236-8164-4881-b45f-b75c1c79859c');
  assert.equal(issue?.params?.driverName, 'Driver Name');
  assert.deepEqual(
    issue?.actions.map((action) => action.id),
    ['repairInvalidDriverOrderUpdate', 'retryParityItem', 'runParitySyncNow'],
  );
  assert.equal(issue?.actions[0]?.recommended, true);
  assert.equal(
    result.issues.some((candidate) => candidate.code === 'parity_module_failed_items'),
    false,
  );
});

test('recovery maps order updates waiting for remote parent to the guided repair', () => {
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
        id: 'order-parent-wait-row',
        tableName: 'orders',
        recordId: '53288fdd-c217-4c80-b87c-5132d6ff3de2',
        moduleType: 'orders',
        operation: 'UPDATE',
        status: 'pending',
        errorMessage: 'Waiting for parent order sync',
        data: JSON.stringify({
          orderId: '53288fdd-c217-4c80-b87c-5132d6ff3de2',
          totalAmount: 7.7,
        }),
      }),
    ],
  });

  const issue = result.issues.find(
    (candidate) => candidate.code === 'order_update_parent_wait',
  );
  assert.ok(issue, 'guided parent-wait order issue should be present');
  assert.equal(issue?.orderId, '53288fdd-c217-4c80-b87c-5132d6ff3de2');
  assert.equal(issue?.params?.totalAmount, '7.70');
  assert.deepEqual(
    issue?.actions.map((action) => action.id),
    ['repairOrderUpdateReplayBlockers', 'retryParityModule', 'retryParityItem', 'runParitySyncNow'],
  );
  assert.equal(issue?.actions[0]?.recommended, true);
  assert.equal(
    result.issues.some((candidate) => candidate.code === 'parity_module_pending_items'),
    false,
  );
});

test('recovery maps stale parent-wait order updates and suppresses processor duplicate', () => {
  const result = buildSyncRecoveryIssues({
    systemHealth: {
      parityQueueStatus: { pending: 0, failed: 0, conflicts: 1, total: 1 },
      syncBacklog: {},
      syncBlockerDetails: [],
      invalidOrders: { count: 0, details: [] },
      credentialState: { hasAdminUrl: true, hasApiKey: true },
      isOnline: true,
    } as never,
    lastParitySync: {
      status: 'completed',
      processed: 0,
      failed: 0,
      conflicts: 0,
      remaining: 1,
      finishedAt: '2026-04-30T03:44:06.494Z',
    } as never,
    parityItems: [
      makeParityItem({
        id: 'stale-order-parent-wait-row',
        tableName: 'orders',
        recordId: '53288fdd-c217-4c80-b87c-5132d6ff3de2',
        moduleType: 'orders',
        operation: 'UPDATE',
        status: 'conflict',
        nextRetryAt: null,
        attempts: 50,
        errorMessage:
          'Deferred too many times (50× "Waiting for parent order sync"); escalated to conflict',
        data: JSON.stringify({
          orderId: '53288fdd-c217-4c80-b87c-5132d6ff3de2',
          totalAmount: 7.7,
        }),
      }),
    ],
  });

  const issue = result.issues.find(
    (candidate) => candidate.code === 'stale_order_update_parent_wait',
  );
  assert.ok(issue, 'guided stale parent-wait order issue should be present');
  assert.equal(issue?.severity, 'error');
  assert.equal(issue?.orderId, '53288fdd-c217-4c80-b87c-5132d6ff3de2');
  assert.equal(issue?.params?.totalAmount, '7.70');
  assert.deepEqual(
    issue?.actions.map((action) => action.id),
    ['repairOrderUpdateReplayBlockers', 'retryParityModule', 'retryParityItem', 'runParitySyncNow'],
  );
  assert.equal(issue?.actions[0]?.recommended, true);
  assert.equal(issue?.actions[0]?.confirmationRequired, true);
  assert.equal(
    result.issues.some(
      (candidate) => candidate.code === 'parity_processor_stalled_zero_progress',
    ),
    false,
  );
  assert.equal(
    result.issues.some((candidate) => candidate.code === 'parity_module_failed_items'),
    false,
  );
});

test('recovery maps order update replay blockers to the guided repair and suppresses dependent generic cards', () => {
  const result = buildSyncRecoveryIssues({
    systemHealth: {
      parityQueueStatus: { pending: 2, failed: 1, conflicts: 1, total: 4 },
      syncBacklog: {},
      syncBlockerDetails: [],
      invalidOrders: { count: 0, details: [] },
      credentialState: { hasAdminUrl: true, hasApiKey: true },
      isOnline: true,
    } as never,
    parityItems: [
      makeParityItem({
        id: 'order-replay-row-a',
        tableName: 'orders',
        recordId: 'local-order-a',
        moduleType: 'orders',
        operation: 'UPDATE',
        status: 'failed',
        nextRetryAt: null,
        errorMessage: 'HTTP 500: {"success":false,"error":"Failed to update order"}',
        data: JSON.stringify({ orderId: 'local-order-a', status: 'completed' }),
      }),
      makeParityItem({
        id: 'order-replay-row-b',
        tableName: 'orders',
        recordId: 'local-order-b',
        moduleType: 'orders',
        operation: 'UPDATE',
        status: 'pending',
        nextRetryAt: null,
        errorMessage:
          'HTTP 500: null value in column "menu_item_id" of relation "order_items"',
        data: JSON.stringify({ orderId: 'local-order-b', status: 'delivered' }),
      }),
      makeParityItem({
        id: 'payment-waiting-parent-row',
        tableName: 'payments',
        recordId: 'payment-waits',
        moduleType: 'payment',
        operation: 'INSERT',
        status: 'conflict',
        nextRetryAt: null,
        errorMessage:
          'Deferred too many times (50x "Waiting for parent order update sync"); escalated to conflict',
        data: JSON.stringify({ orderId: 'local-order-b', paymentId: 'payment-waits' }),
      }),
    ],
  });

  const issue = result.issues.find(
    (candidate) => candidate.code === 'order_update_replay_blocked',
  );
  assert.ok(issue, 'guided order replay issue should be present');
  assert.equal(issue?.orderId, 'local-order-a');
  assert.equal(issue?.params?.count, 2);
  assert.equal(issue?.params?.dependentPaymentCount, 1);
  assert.deepEqual(
    issue?.actions.map((action) => action.id),
    ['repairOrderUpdateReplayBlockers', 'retryParityModule', 'runParitySyncNow'],
  );
  assert.equal(issue?.actions[0]?.recommended, true);
  assert.equal(
    result.issues.some((candidate) => candidate.code === 'parity_module_failed_items'),
    false,
  );
  assert.equal(
    result.issues.some((candidate) => candidate.code === 'parity_module_pending_items'),
    false,
  );
});

test('recovery maps legacy financial parity orphans to the local clear action', () => {
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
        id: 'legacy-payment-orphan',
        tableName: 'payments',
        recordId: 'pay-orphan',
        moduleType: 'financial',
      }),
    ],
    integrity: {
      valid: false,
      issues: [
        {
          entityType: 'payment',
          entityId: 'pay-orphan',
          paymentId: 'pay-orphan',
          reasonCode: 'legacy_financial_parity_orphan',
          suggestedFix: 'clear_legacy_financial_parity_orphan',
          createdAt: new Date(Date.now() - 20 * 60 * 1000).toISOString(),
          lastError: 'Waiting for parent order sync',
          legacyParityRowId: 'legacy-row-a',
        },
      ],
    },
  });

  const issue = result.issues.find(
    (candidate) => candidate.code === 'legacy_financial_parity_orphan',
  );
  assert.ok(issue, 'legacy orphan issue should be present');
  assert.deepEqual(
    issue?.actions.map((action) => action.id),
    ['clearLegacyFinancialOrphan', 'contactDev'],
  );
});

test('recovery suppresses legacy financial orphan issues when the parity row is already gone', () => {
  const result = buildSyncRecoveryIssues({
    systemHealth: {
      parityQueueStatus: { pending: 0, failed: 0, conflicts: 0, total: 0 },
      syncBacklog: {},
      syncBlockerDetails: [],
      invalidOrders: { count: 0, details: [] },
      credentialState: { hasAdminUrl: true, hasApiKey: true },
      isOnline: true,
    } as never,
    parityItems: [],
    integrity: {
      valid: false,
      issues: [
        {
          entityType: 'payment',
          entityId: 'pay-orphan-cleared',
          paymentId: 'pay-orphan-cleared',
          reasonCode: 'legacy_financial_parity_orphan',
          suggestedFix: 'clear_legacy_financial_parity_orphan',
          createdAt: new Date(Date.now() - 20 * 60 * 1000).toISOString(),
          legacyParityRowId: 'legacy-row-cleared',
        },
      ],
    },
  });

  assert.equal(
    result.issues.some((candidate) => candidate.code === 'legacy_financial_parity_orphan'),
    false,
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

test('isViewAccessDenied fails closed for unowned module views (THE-315)', () => {
  const owned = (...ids: string[]) => ids.map((id) => ({ module: { id } }));
  const typicalOrg = owned('orders', 'menu', 'users', 'tables');

  // A catalog module the org never acquired is denied even though the API
  // sync path leaves it out of lockedModules entirely.
  assert.equal(isViewAccessDenied(typicalOrg, 'delivery'), true);
  assert.equal(isViewAccessDenied(typicalOrg, 'rooms'), true);

  // Owning the module grants the view.
  assert.equal(isViewAccessDenied(owned('delivery'), 'delivery'), false);

  // Core screen + non-module shell views are always reachable.
  assert.equal(isViewAccessDenied(typicalOrg, 'dashboard'), false);
  assert.equal(isViewAccessDenied(typicalOrg, 'settings'), false);

  // View aliases resolve to their backing module before the check.
  assert.equal(resolveViewModuleId('customers'), 'users');
  assert.equal(resolveViewModuleId('integrations'), 'plugin_integrations');
  assert.equal(resolveViewModuleId('services'), 'service_catalog');
  assert.equal(isViewAccessDenied(typicalOrg, 'customers'), false);
  assert.equal(isViewAccessDenied(typicalOrg, 'integrations'), true);
  assert.equal(isViewAccessDenied(owned('plugin_integrations'), 'integrations'), false);
  assert.equal(isViewAccessDenied(owned('service_catalog'), 'services'), false);
  assert.equal(isViewAccessDenied(owned('services'), 'service_catalog'), false);

  // Bootstrap window: module data not hydrated yet -> nothing is denied
  // (a synced terminal always carries its core modules, so an empty list
  // can only mean "not loaded").
  assert.equal(isViewAccessDenied([], 'delivery'), false);

  // Unknown ids are denied too once data is loaded — fail closed beats the
  // old fail-open; the layout's ModuleNotAvailableView only handled ids
  // that slipped through.
  assert.equal(isViewAccessDenied(typicalOrg, 'not_a_module'), true);
});

test('isModuleRequiredApiError recognizes both transport shapes (THE-306 sweep item 3)', () => {
  // Web fetch path: the route's error code verbatim.
  assert.equal(isModuleRequiredApiError('MODULE_REQUIRED'), true);
  // IPC path: admin_fetch folds the code into its message.
  assert.equal(
    isModuleRequiredApiError('MODULE_REQUIRED (HTTP 403): {"success":false,"error":"MODULE_REQUIRED","missingModules":["coupons"]}'),
    true,
  );
  // Everything else keeps the normal retry path.
  assert.equal(isModuleRequiredApiError('HTTP 403'), false);
  assert.equal(isModuleRequiredApiError('Failed to fetch'), false);
  assert.equal(isModuleRequiredApiError(undefined), false);
  assert.equal(isModuleRequiredApiError(null), false);
});

// --- GuestBillingView folio vocabulary + action wiring (hotel-rooms-full-pass 10.4) ---

const guestBillingViewPath = path.join(
  process.cwd(),
  'src',
  'renderer',
  'pages',
  'verticals',
  'hotel',
  'GuestBillingView.tsx',
);

const readGuestBillingViewSource = () => readFileSync(guestBillingViewPath, 'utf8');

const roomsViewPath = path.join(
  process.cwd(),
  'src',
  'renderer',
  'pages',
  'verticals',
  'hotel',
  'RoomsView.tsx',
);
const roomsServicePath = path.join(
  process.cwd(),
  'src',
  'renderer',
  'services',
  'RoomsService.ts',
);
const paymentModalPath = path.join(
  process.cwd(),
  'src',
  'renderer',
  'components',
  'modals',
  'PaymentModal.tsx',
);
const orderDashboardPath = path.join(
  process.cwd(),
  'src',
  'renderer',
  'components',
  'OrderDashboard.tsx',
);
const orderFlowPath = path.join(
  process.cwd(),
  'src',
  'renderer',
  'components',
  'OrderFlow.tsx',
);
const newOrderPagePath = path.join(
  process.cwd(),
  'src',
  'renderer',
  'pages',
  'NewOrderPage.tsx',
);
const orderServicePath = path.join(process.cwd(), 'src', 'services', 'OrderService.ts');
const nativePaymentsPath = path.join(process.cwd(), 'src-tauri', 'src', 'payments.rs');
const nativeSyncPath = path.join(process.cwd(), 'src-tauri', 'src', 'sync.rs');
const localeDirectoryPath = path.join(process.cwd(), 'src', 'locales');
const posLocaleCodes = ['de', 'el', 'en', 'fr', 'it'] as const;

const readRoomsViewSource = () => readFileSync(roomsViewPath, 'utf8');
const readRoomsServiceSource = () => readFileSync(roomsServicePath, 'utf8');
const readPaymentModalSource = () => readFileSync(paymentModalPath, 'utf8');
const readOrderDashboardSource = () => readFileSync(orderDashboardPath, 'utf8');
const readOrderFlowSource = () => readFileSync(orderFlowPath, 'utf8');
const readNewOrderPageSource = () => readFileSync(newOrderPagePath, 'utf8');
const readOrderServiceSource = () => readFileSync(orderServicePath, 'utf8');
const readNativePaymentsSource = () => readFileSync(nativePaymentsPath, 'utf8');
const readNativeSyncSource = () => readFileSync(nativeSyncPath, 'utf8');

const hasLocaleValue = (messages: unknown, key: string): boolean => {
  const value = key
    .split('.')
    .reduce<unknown>(
      (current, segment) =>
        current && typeof current === 'object' && segment in current
          ? (current as Record<string, unknown>)[segment]
          : undefined,
      messages,
    );

  return typeof value === 'string' && value.trim().length > 0 && !value.includes('[NEEDS');
};

test('guest billing status vocabulary matches the guest_folios server CHECK (task 10.4)', () => {
  // Server truth: active | closed | disputed.
  assert.deepEqual([...FOLIO_STATUSES], ['active', 'closed', 'disputed']);
  assert.deepEqual(
    Object.keys(FOLIO_STATUS_PRESENTATION).sort(),
    ['active', 'closed', 'disputed'],
  );
  for (const status of FOLIO_STATUSES) {
    assert.equal(isFolioStatus(status), true);
    const presentation = FOLIO_STATUS_PRESENTATION[status];
    assert.match(presentation.labelKey, /^guestBilling\.status\./);
    assert.ok(presentation.defaultLabel.length > 0);
    assert.ok(presentation.badgeClass.length > 0);
  }

  // The old desktop-only vocabulary never existed on the server and is gone.
  for (const dead of ['open', 'settled', 'pending_checkout']) {
    assert.equal(isFolioStatus(dead), false);
    assert.equal(dead in FOLIO_STATUS_PRESENTATION, false);
  }
});

test('GuestBillingView source carries only the server status vocabulary', () => {
  const source = readGuestBillingViewSource();

  // No quoted dead-status literal anywhere in the view.
  assert.doesNotMatch(
    source,
    /['"`](open|settled|pending_checkout)['"`]/,
    'the open/settled/pending_checkout vocabulary must not reappear in GuestBillingView',
  );
  // Status rendering and filters flow through the shared server-truth helpers.
  assert.match(source, /FOLIO_STATUS_PRESENTATION/);
  assert.match(source, /FOLIO_STATUSES/);
  assert.match(source, /summarizeFolios/);
});

test('guest billing folio actions target the existing POS folio routes', () => {
  assert.equal(folioChargesEndpoint('folio-1'), '/pos/guest-billing/folio-1/charges');
  assert.equal(folioPaymentsEndpoint('folio-1'), '/pos/guest-billing/folio-1/payments');
  assert.equal(folioCheckoutEndpoint('folio-1'), '/pos/guest-billing/folio-1/checkout');
});

test('GuestBillingView wires Add Charge / Payment / Checkout buttons to the folio endpoints', () => {
  const source = readGuestBillingViewSource();

  // Buttons post through the shared endpoint builders over the POS API bridge.
  assert.match(source, /folioChargesEndpoint\(/);
  assert.match(source, /folioPaymentsEndpoint\(/);
  assert.match(source, /folioCheckoutEndpoint\(/);
  assert.match(source, /posApiPost/);
  // Checkout uses the close_paid resolution and steers outstanding balances
  // to Add Payment via the dual-transport 409 parser.
  assert.match(source, /resolution: 'close_paid'/);
  assert.match(source, /parseFolioCheckoutOutstanding\(/);
  assert.match(source, /setActionModal\('payment'\)/);
  // MODULE_REQUIRED denials surface a clear message instead of raw transport noise.
  assert.match(source, /isModuleRequiredApiError\(/);
});

test('parseFolioCheckoutOutstanding recognizes both transport shapes', () => {
  // Browser fetch path: posApiFetch keeps only the human message + HTTP status.
  const browser = parseFolioCheckoutOutstanding(
    'Cannot complete checkout with outstanding balance 84.50.',
    409,
  );
  assert.equal(browser.outstanding, true);
  assert.equal(browser.balance, 84.5);

  // Tauri IPC path: admin_fetch folds the entire JSON body into the error
  // string and no status survives the bridge.
  const ipc = parseFolioCheckoutOutstanding(
    'Cannot complete checkout with outstanding balance 84.50. (HTTP 409): {"success":false,"error":"Cannot complete checkout with outstanding balance 84.50.","code":"folio_checkout_outstanding","balance":84.5,"reconciliation":{"status":"outstanding","paid":false}}',
    undefined,
  );
  assert.equal(ipc.outstanding, true);
  assert.equal(ipc.balance, 84.5);

  // Everything else keeps the normal error path.
  assert.equal(parseFolioCheckoutOutstanding('Folio is already closed', 409).outstanding, false);
  assert.equal(
    parseFolioCheckoutOutstanding(
      'MODULE_REQUIRED (HTTP 403): {"success":false,"error":"MODULE_REQUIRED"}',
      undefined,
    ).outstanding,
    false,
  );
  assert.equal(parseFolioCheckoutOutstanding(undefined, 409).outstanding, false);
  assert.equal(parseFolioCheckoutOutstanding(null, 409).outstanding, false);
  // A 500 carrying similar text is not the structured 409 denial.
  assert.equal(
    parseFolioCheckoutOutstanding('Cannot complete checkout with outstanding balance 84.50.', 500)
      .outstanding,
    false,
  );
});

test('summarizeFolios counts active/disputed folios and sums only active balances', () => {
  const summary = summarizeFolios([
    { status: 'active', balance: 120.5 },
    { status: 'active', balance: 0 },
    { status: 'closed', balance: 0 },
    { status: 'disputed', balance: 75 },
  ]);

  assert.equal(summary.activeCount, 2);
  assert.equal(summary.disputedCount, 1);
  assert.equal(summary.activeBalance, 120.5);

  const empty = summarizeFolios([]);
  assert.deepEqual(empty, { activeCount: 0, disputedCount: 0, activeBalance: 0 });
});

// --- RoomsView desktop convergence (hotel-rooms-full-pass 10.3) ---

test('RoomsService preserves effective room status and active folio payloads', () => {
  const source = readRoomsServiceSource();

  assert.match(source, /effective_status\?: RoomStatus \| null/);
  assert.match(source, /active_folio\?:/);
  assert.match(source, /effectiveStatus: data\.effective_status \|\| null/);
  assert.match(source, /activeFolio: transformActiveFolio\(data\.active_folio\)/);
  assert.match(source, /balanceCents/);
});

test('RoomsView uses the room-stay endpoints for folio check-in and checkout', () => {
  const source = readRoomsViewSource();

  assert.match(source, /isModuleEnabled\('guest_billing' as any\)/);
  assert.match(source, /offlineRoomCheckin\(/);
  assert.match(source, /\/pos\/rooms\/\$\{encodeURIComponent\(selectedRoom\.id\)\}\/checkin/);
  assert.match(source, /\/pos\/rooms\/\$\{encodeURIComponent\(room\.id\)\}\/checkout/);
  assert.match(source, /parseFolioCheckoutOutstanding\(/);
  assert.match(source, /folioPaymentsEndpoint\(/);
});

test('RoomsView fallback receipt is gated to rooms without guest billing and orders-owned orgs', () => {
  const source = readRoomsViewSource();

  assert.match(source, /const hasGuestBilling = isModuleEnabled\('guest_billing' as any\)/);
  assert.match(source, /const hasOrders = isModuleEnabled\('orders' as any\)/);
  assert.match(source, /if \(hasGuestBilling\) \{/);
  assert.match(source, /if \(hasOrders\) \{[\s\S]*createFallbackReceiptOrder\(/);
  assert.match(source, /else if \(!reservationCreated\) \{/);
});

test('RoomsView checkout cannot construct the old stay billing order', () => {
  const source = readRoomsViewSource();

  assert.doesNotMatch(source, /createHotelBillingOrder/);
  assert.doesNotMatch(source, /checkoutAmount/);
  assert.doesNotMatch(source, /nightsStayed/);
  assert.doesNotMatch(source, /Room \$\{actionRoom\.roomNumber\} checkout/);
});

test('RoomsView renders effective status, active folio balance, and posts Add Charge to folio routes', () => {
  const source = readRoomsViewSource();

  assert.match(source, /getRoomEffectiveStatus\(room\)/);
  assert.match(source, /room\.activeFolio\?\.guestName/);
  assert.match(source, /room\.activeFolio\.balanceCents \/ 100/);
  assert.match(source, /folioChargesEndpoint\(/);
  assert.doesNotMatch(source, /console\.log\('Add charge'\)/);
});

// --- Charge-to-room desktop payment surface (hotel-rooms-full-pass 10.5) ---

test('PaymentModal gates room_charge on room context, active folio, and module ownership', () => {
  const source = readPaymentModalSource();

  assert.match(source, /interface RoomChargeContext/);
  assert.match(source, /roomChargeContext\?\.roomId && roomChargeContext\?\.activeFolioId/);
  assert.match(source, /hasModule\(MODULE_IDS\.ROOMS\)/);
  assert.match(source, /hasModule\(MODULE_IDS\.ORDERS\)/);
  assert.match(source, /hasModule\('guest_billing'\)/);
  assert.match(source, /handlePaymentMethodSelect\('room_charge'\)/);
  assert.match(source, /room_id: roomChargeContext\.roomId/);
});

test('room_charge late failure keeps the created order and prompts immediate payment', () => {
  const paymentModal = readPaymentModalSource();
  const orderDashboard = readOrderDashboardSource();
  const orderFlow = readOrderFlowSource();
  const newOrderPage = readNewOrderPageSource();

  assert.match(paymentModal, /interface RoomChargeFallbackPrompt/);
  assert.match(paymentModal, /isRoomChargeFallbackPrompt\(completionResult\)/);
  assert.match(paymentModal, /paymentPayload\.existingOrderId/);
  assert.match(paymentModal, /existingOrderId: roomChargeFallback\.orderId/);
  assert.match(paymentModal, /modals\.payment\.roomChargeFallback/);

  for (const source of [orderDashboard, orderFlow, newOrderPage]) {
    assert.match(source, /roomCharge\?\.applied === false/);
    assert.match(source, /orderData\.paymentData\.existingOrderId = result\.orderId/);
    assert.match(source, /orderData\.paymentData\.roomChargeFallback = true/);
    assert.match(source, /bridge\.payments\.recordPayment\(/);
    assert.match(source, /existingOrderId/);
  }
});

test('order creation sends room_id for room_charge and strips API initialPayment', () => {
  const orderService = readOrderServiceSource();

  for (const source of [readOrderDashboardSource(), readOrderFlowSource(), readNewOrderPageSource()]) {
    assert.match(source, /payment_method: isGhostOrder[\s\S]*paymentMethod/);
    assert.match(source, /room_id: isRoomChargePayment \? roomId : null/);
    assert.match(source, /paymentMethod === ['"]room_charge['"]/);
  }

  assert.match(orderService, /room_id: isRoomChargeOrder \? normalizedRoomId : null/);
  assert.match(orderService, /initialPayment: isRoomChargeOrder \? null : normalizedInitialPayment/);
  assert.match(orderService, /newOrder\.roomCharge = result\.roomCharge/);
});

test('native payment and sync layers preserve room_charge as a separate local method', () => {
  const payments = readNativePaymentsSource();
  const sync = readNativeSyncSource();

  assert.match(payments, /"room_charge" \| "room-charge" => Some\("room_charge"\.to_string\(\)\)/);
  assert.match(payments, /"room_charge" \| "room-charge" => "room_charge"\.to_string\(\)/);
  assert.match(payments, /Only cash, card, and room_charge payments can be recorded locally/);
  assert.match(sync, /"room_charge" \| "room-charge" => "room_charge"/);
  assert.match(sync, /"room_id": str_any\(source, &\["roomId", "room_id"\]\)/);
  assert.match(sync, /"room_id": str_any\(&data, &\["room_id", "roomId"\]\)/);
});

// --- Desktop hotel locale coverage (hotel-rooms-full-pass 10.6) ---

test('desktop hotel and room-charge locale keys exist in every POS locale', () => {
  const requiredKeys = new Set([
    'roomsView.status.available',
    'roomsView.status.occupied',
    'roomsView.status.reserved',
    'roomsView.status.maintenance',
    'roomsView.status.cleaning',
    'guestBilling.status.active',
    'guestBilling.status.closed',
    'guestBilling.status.disputed',
  ]);
  const translationCallPattern = /t\(\s*['"]([^'"`]+)['"]/g;
  for (const source of [readPaymentModalSource(), readRoomsViewSource(), readGuestBillingViewSource()]) {
    for (const match of source.matchAll(translationCallPattern)) {
      const key = match[1];
      if (
        key.startsWith('modals.payment.') ||
        key.startsWith('roomsView.') ||
        key.startsWith('guestBilling.')
      ) {
        requiredKeys.add(key);
      }
    }
  }

  for (const locale of posLocaleCodes) {
    const messages = JSON.parse(
      readFileSync(path.join(localeDirectoryPath, `${locale}.json`), 'utf8'),
    );
    const missing = [...requiredKeys].filter((key) => !hasLocaleValue(messages, key)).sort();

    assert.deepEqual(missing, [], `${locale} is missing desktop hotel/payment locale keys`);
  }
});

// --- Waiter-device management (feat/waiter-terminal-lockdown) ---

const connectionSettingsModalPath = path.join(
  process.cwd(),
  'src',
  'renderer',
  'components',
  'modals',
  'ConnectionSettingsModal.tsx',
);
const waiterDevicesSectionPath = path.join(
  process.cwd(),
  'src',
  'renderer',
  'components',
  'settings',
  'WaiterDevicesSection.tsx',
);

test('settings hub registers the waiter_devices section gated on main terminal', () => {
  const source = readFileSync(connectionSettingsModalPath, 'utf8');

  // The section id exists in the SettingsSectionId union and renders the section component.
  assert.match(source, /\|\s*'waiter_devices'/);
  assert.match(source, /<WaiterDevicesSection\s*\/>/);
  assert.match(source, /settings\.settingsHub\.sections\.waiter_devices\.label/);
  assert.match(source, /settings\.settingsHub\.sections\.waiter_devices\.detail/);

  // Main-terminal gate: derived from useFeatures' terminalType, stripping the
  // nav entry AND guarding the render block for non-main terminals.
  assert.match(source, /const isMainTerminal = terminalType === 'main'/);
  assert.match(source, /id !== 'waiter_devices' \|\| isMainTerminal/);
  assert.match(
    source,
    /activeSettingsSection === 'waiter_devices' && isMainTerminal/,
  );
});

test('WaiterDevicesSection consumes the terminal-authenticated waiter-device endpoints', () => {
  const source = readFileSync(waiterDevicesSectionPath, 'utf8');

  // Reads and writes go through the shared POS API helpers (dual transport),
  // never through a direct Supabase client.
  assert.match(source, /posApiGet[\s\S]{0,120}'\/api\/pos\/terminals\/waiter-devices'/);
  assert.match(
    source,
    /posApiPut[\s\S]{0,200}\/api\/pos\/terminals\/waiter-devices\/\$\{encodeURIComponent\(/,
  );
  assert.doesNotMatch(source, /supabase/i);

  // Saves send only enabled_features; the not-a-main-terminal denial is
  // recognized on both transport shapes and surfaced with friendly copy.
  assert.match(source, /\{ enabled_features: nextFeatures \}/);
  assert.match(source, /WAITER_MGMT_MAIN_ONLY/);
  assert.match(source, /Only a main terminal can manage waiter devices/);
  assert.match(source, /settings\.waiterDevices\.mainOnly/);

  // The managed allowed-action keys stay pinned to the server vocabulary.
  for (const key of [
    'order_creation',
    'table_management',
    'payment_processing',
    'refunds',
  ]) {
    assert.match(source, new RegExp(`'${key}'`));
  }
});

test('waiter-device locale keys exist in every POS locale', () => {
  const requiredKeys = new Set([
    'settings.settingsHub.sections.waiter_devices.label',
    'settings.settingsHub.sections.waiter_devices.detail',
  ]);
  const translationCallPattern = /t\(\s*\n?\s*['"]([^'"`]+)['"]/g;
  const source = readFileSync(waiterDevicesSectionPath, 'utf8');
  for (const match of source.matchAll(translationCallPattern)) {
    const key = match[1];
    if (key.startsWith('settings.waiterDevices.') || key.startsWith('sync.time.')) {
      requiredKeys.add(key);
    }
  }
  assert.ok(
    [...requiredKeys].some((key) => key.startsWith('settings.waiterDevices.')),
    'expected WaiterDevicesSection to reference settings.waiterDevices.* keys',
  );

  for (const locale of posLocaleCodes) {
    const messages = JSON.parse(
      readFileSync(path.join(localeDirectoryPath, `${locale}.json`), 'utf8'),
    );
    const missing = [...requiredKeys].filter((key) => !hasLocaleValue(messages, key)).sort();

    assert.deepEqual(missing, [], `${locale} is missing waiter-device locale keys`);
  }
});
