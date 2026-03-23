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
  const resolved = resolvePickupToDeliveryAddress({
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
        name_on_ringer: 'Default Bell',
      },
      {
        id: 'addr-2',
        customer_id: 'customer-1',
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

  assert.equal(resolved?.addressId, 'addr-2');
  assert.equal(resolved?.customerId, 'customer-1');
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
      orderNumber: '00003',
      createdAt: '2026-03-22T10:10:00.000Z',
      updatedAt: '2026-03-22T10:10:00.000Z',
    },
    {
      id: 'order-oldest',
      orderNumber: '00001',
      createdAt: '2026-03-22T10:00:00.000Z',
      updatedAt: '2026-03-22T10:00:00.000Z',
    },
    {
      id: 'order-middle',
      orderNumber: '00002',
      createdAt: '2026-03-22T10:05:00.000Z',
      updatedAt: '2026-03-22T10:05:00.000Z',
    },
  ]);

  assert.deepEqual(
    sorted.map((order) => order.id),
    ['order-oldest', 'order-middle', 'order-new'],
  );
});
