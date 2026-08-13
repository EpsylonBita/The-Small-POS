/**
 * procurement-loop Tasks 10.2 + 10.4: Purchase Orders tab renderer tests.
 *
 * Pins the POS surface contract: renders from the offline snapshot,
 * hidden without the suppliers module, view + receive ONLY (no PO
 * creation/editing), receive dialog defaults lines to remaining
 * quantities with expected cost, offline submits queue with a
 * capture-time idempotency key, and queued receipts surface as
 * pending-sync / parked / needs-attention states with recorded
 * quantities preserved. [R10.1, R10.4, R11.1, R11.6, R11.7, R12.5]
 */
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  isModuleEnabled: vi.fn(() => true),
  staff: {
    staffId: 'staff-local-1',
    databaseStaffId: '44444444-4444-4444-8444-444444444444',
    name: 'Maria',
    role: 'manager',
    branchId: 'branch-1',
    terminalId: 'terminal-1',
  } as Record<string, unknown> | null,
  loadPurchaseOrderSnapshot: vi.fn(),
  syncPurchaseOrderSnapshot: vi.fn(async () => ({
    purchaseOrders: [],
    serverCursor: null,
    fetchedAt: null,
  })),
  listQueuedPoReceipts: vi.fn(async () => []),
  retryQueuedPoReceipt: vi.fn(async () => undefined),
  offlineCommitPoReceipt: vi.fn(async () => ({
    idempotencyKey: 'key',
    recordedAt: 'now',
    queueId: 'queue-1',
    queued: true,
  })),
  posApiPost: vi.fn(),
  onEvent: vi.fn(),
  offEvent: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (
      _key: string,
      fallback?: string | { defaultValue?: string; [key: string]: unknown },
    ) => {
      if (typeof fallback === 'string') {
        return fallback;
      }
      if (fallback && typeof fallback === 'object') {
        let text = String(fallback.defaultValue ?? _key);
        for (const [name, value] of Object.entries(fallback)) {
          if (name !== 'defaultValue') {
            text = text.replaceAll(`{{${name}}}`, String(value));
          }
        }
        return text;
      }
      return _key;
    },
    i18n: { language: 'en' },
  }),
}));

vi.mock('react-hot-toast', () => ({
  toast: {
    success: (...args: unknown[]) => mocks.toastSuccess(...args),
    error: (...args: unknown[]) => mocks.toastError(...args),
  },
}));

vi.mock('../../../contexts/theme-context', () => ({
  useTheme: () => ({ resolvedTheme: 'light' }),
}));

vi.mock('../../../contexts/module-context', () => ({
  useModules: () => ({ isModuleEnabled: mocks.isModuleEnabled }),
}));

vi.mock('../../../contexts/shift-context', () => ({
  useShift: () => ({ staff: mocks.staff }),
}));

vi.mock('../../../../lib', () => ({
  onEvent: mocks.onEvent,
  offEvent: mocks.offEvent,
}));

vi.mock('../../../utils/format', () => ({
  formatCurrency: (amount: number) => `€${amount}`,
  formatDate: (value: string) => value,
}));

vi.mock('../../../utils/api-helpers', () => ({
  posApiPost: mocks.posApiPost,
  isModuleRequiredApiError: (error: unknown) =>
    typeof error === 'string' && error.includes('MODULE_REQUIRED'),
}));

vi.mock('../../../services/purchase-order-snapshot', () => ({
  PURCHASE_ORDER_SNAPSHOT_EVENT: 'purchase-orders:snapshot',
  loadPurchaseOrderSnapshot: mocks.loadPurchaseOrderSnapshot,
  syncPurchaseOrderSnapshot: mocks.syncPurchaseOrderSnapshot,
}));

vi.mock('../../../services/po-receipt-queue', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../services/po-receipt-queue')>();
  return {
    ...actual,
    listQueuedPoReceipts: mocks.listQueuedPoReceipts,
    retryQueuedPoReceipt: mocks.retryQueuedPoReceipt,
  };
});

vi.mock('../../../services/offline-mutations', () => ({
  offlineCommitPoReceipt: mocks.offlineCommitPoReceipt,
}));

vi.mock('../../../services/ParitySyncCoordinator', () => ({
  PARITY_QUEUE_STATUS_EVENT: 'parity-queue:status',
}));

import PurchaseOrdersTab, { classifyReceiveFailure } from '../PurchaseOrdersTab';

function snapshotWithPo(overrides: Record<string, unknown> = {}) {
  return {
    purchaseOrders: [
      {
        id: 'po-1',
        organizationId: 'org-1',
        branchId: 'branch-1',
        supplierId: 'supplier-1',
        supplierName: 'Athens Fresh Produce',
        orderReference: 'PO-2026-000001',
        status: 'ordered',
        expectedDeliveryDate: '2026-08-07',
        notes: null,
        items: [
          {
            id: 'item-1',
            flavor: 'inventory',
            inventoryItemId: 'inv-1',
            retailProductId: null,
            productId: null,
            itemNameSnapshot: 'Tomatoes',
            unit: 'kg',
            quantityOrdered: 10,
            expectedUnitCost: 2.5,
            quantityReceived: 4,
            remainingQuantity: 6,
            isUnplanned: false,
          },
        ],
        orderedTotalCost: 25,
        receivedProgress: { orderedQty: 10, receivedQty: 4 },
        createdAt: '2026-08-04T09:00:00.000Z',
        updatedAt: '2026-08-04T09:00:00.000Z',
        ...overrides,
      },
    ],
    serverCursor: '2026-08-05T10:00:00.000Z',
    fetchedAt: '2026-08-05T10:00:01.000Z',
  };
}

function setNavigatorOnline(value: boolean) {
  Object.defineProperty(window.navigator, 'onLine', {
    configurable: true,
    get: () => value,
  });
}

async function openDetailAndReceive() {
  fireEvent.click(screen.getByText('PO-2026-000001'));
  fireEvent.click(screen.getByText('Receive delivery'));
  await screen.findByText('Record receipt');
}

describe('PurchaseOrdersTab', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.isModuleEnabled.mockReturnValue(true);
    mocks.loadPurchaseOrderSnapshot.mockReturnValue(snapshotWithPo());
    mocks.listQueuedPoReceipts.mockResolvedValue([]);
    setNavigatorOnline(true);
  });

  // Vitest runs without injected globals, so RTL's auto-cleanup never
  // registers — unmount explicitly or renders accumulate across tests.
  afterEach(() => {
    cleanup();
  });

  it('renders the purchase order list from the offline snapshot', async () => {
    render(<PurchaseOrdersTab />);

    expect(screen.getByText('PO-2026-000001')).toBeTruthy();
    expect(screen.getByText('Athens Fresh Produce')).toBeTruthy();
    expect(screen.getAllByText('Ordered').length).toBeGreaterThan(0);
    // Staleness label from the snapshot's fetchedAt. [R11.1]
    expect(screen.getByText(/Last synced/)).toBeTruthy();
  });

  it('renders nothing when the suppliers module is not enabled for this terminal', () => {
    mocks.isModuleEnabled.mockReturnValue(false);
    const { container } = render(<PurchaseOrdersTab />);
    expect(container.innerHTML).toBe('');
  });

  it('offers view + receive only — no PO creation or editing affordances', async () => {
    render(<PurchaseOrdersTab />);
    fireEvent.click(screen.getByText('PO-2026-000001'));

    expect(screen.getByText('Receive delivery')).toBeTruthy();
    expect(screen.queryByText(/create/i)).toBeNull();
    expect(screen.queryByText(/new order/i)).toBeNull();
    expect(screen.queryByText(/edit/i)).toBeNull();
  });

  it('does not offer receiving against a closed purchase order', () => {
    mocks.loadPurchaseOrderSnapshot.mockReturnValue(
      snapshotWithPo({ status: 'received_closed' }),
    );
    render(<PurchaseOrdersTab />);
    fireEvent.click(screen.getByText('PO-2026-000001'));
    expect(screen.queryByText('Receive delivery')).toBeNull();
  });

  it('defaults receive lines to the remaining quantity and the expected unit cost', async () => {
    render(<PurchaseOrdersTab />);
    await openDetailAndReceive();

    const quantityInput = screen.getByLabelText('Quantity') as HTMLInputElement;
    const costInput = screen.getByLabelText('Unit cost') as HTMLInputElement;
    // ordered 10, received 4 → remaining 6; expected cost 2.5. [R6.1, R8.1]
    expect(quantityInput.value).toBe('6');
    expect(costInput.value).toBe('2.5');
  });

  it('queues the receipt offline with a capture-time idempotency key and recordedAt', async () => {
    setNavigatorOnline(false);
    render(<PurchaseOrdersTab />);
    await openDetailAndReceive();

    fireEvent.click(screen.getByText('Record receipt'));

    await waitFor(() => expect(mocks.offlineCommitPoReceipt).toHaveBeenCalledTimes(1));
    const payload = mocks.offlineCommitPoReceipt.mock.calls[0][0];
    expect(payload.purchaseOrderId).toBe('po-1');
    // Staff actor: the logged-in POS staff member's database id. [R10.2]
    expect(payload.staffId).toBe('44444444-4444-4444-8444-444444444444');
    expect(typeof payload.idempotencyKey).toBe('string');
    expect(payload.idempotencyKey.length).toBeGreaterThan(10);
    expect(() => new Date(payload.recordedAt).toISOString()).not.toThrow();
    expect(payload.lines).toEqual([
      { purchaseOrderItemId: 'item-1', quantityReceived: 6, unitCost: 2.5 },
    ]);
    // No direct POST attempted while offline.
    expect(mocks.posApiPost).not.toHaveBeenCalled();
  });

  it('posts directly when online, sending the same capture-time key in the body', async () => {
    mocks.posApiPost.mockResolvedValueOnce({
      success: true,
      data: { success: true, receiptId: 'r-1', wasReplay: false },
      status: 201,
    });
    render(<PurchaseOrdersTab />);
    await openDetailAndReceive();

    fireEvent.click(screen.getByText('Record receipt'));

    await waitFor(() => expect(mocks.posApiPost).toHaveBeenCalledTimes(1));
    const [endpoint, body] = mocks.posApiPost.mock.calls[0];
    expect(endpoint).toBe('pos/purchase-orders/po-1/receipts');
    expect(body.source).toBe('pos_desktop');
    expect(typeof body.idempotencyKey).toBe('string');
    expect(body.staffId).toBe('44444444-4444-4444-8444-444444444444');
    expect(mocks.offlineCommitPoReceipt).not.toHaveBeenCalled();
    await waitFor(() => expect(mocks.toastSuccess).toHaveBeenCalled());
  });

  it('falls back to the offline queue with the SAME key when the online POST never reaches the server', async () => {
    mocks.posApiPost.mockResolvedValueOnce({
      success: false,
      error: 'This action requires an online connection.',
      // no HTTP status → transport failure
    });
    render(<PurchaseOrdersTab />);
    await openDetailAndReceive();

    fireEvent.click(screen.getByText('Record receipt'));

    await waitFor(() => expect(mocks.offlineCommitPoReceipt).toHaveBeenCalledTimes(1));
    const postBody = mocks.posApiPost.mock.calls[0][1];
    const queuedPayload = mocks.offlineCommitPoReceipt.mock.calls[0][0];
    // Exactly-once under retry: identical capture-time key. [R11.4]
    expect(queuedPayload.idempotencyKey).toBe(postBody.idempotencyKey);
    expect(queuedPayload.recordedAt).toBe(postBody.recordedAt);
  });

  it('surfaces a PO state conflict outcome without dropping the dialog state', async () => {
    mocks.posApiPost.mockResolvedValueOnce({
      success: false,
      status: 409,
      error: 'PO_STATE_CONFLICT (HTTP 409): {"success":false,"error":"PO_STATE_CONFLICT","poStatus":"cancelled"}',
    });
    render(<PurchaseOrdersTab />);
    await openDetailAndReceive();

    fireEvent.click(screen.getByText('Record receipt'));

    await waitFor(() =>
      expect(
        screen.getByText(/This purchase order changed on the server/),
      ).toBeTruthy(),
    );
    // The dialog stays open for staff resolution — never a silent drop. [R11.7]
    expect(screen.getByText('Record receipt')).toBeTruthy();
    expect(mocks.offlineCommitPoReceipt).not.toHaveBeenCalled();
  });

  it('shows queued receipts as a pending-sync overlay that adjusts remaining quantities', async () => {
    mocks.listQueuedPoReceipts.mockResolvedValue([
      {
        queueId: 'queue-1',
        idempotencyKey: 'key-1',
        purchaseOrderId: 'po-1',
        recordedAt: '2026-08-05T10:15:00.000Z',
        notes: null,
        state: 'pending',
        errorMessage: null,
        lines: [
          { purchaseOrderItemId: 'item-1', quantityReceived: 2, unitCost: 2.5, isUnplanned: false },
        ],
      },
    ]);
    render(<PurchaseOrdersTab />);
    await screen.findAllByText('Pending sync');

    fireEvent.click(screen.getByText('PO-2026-000001'));
    // Optimistic entry visible with the recorded quantities. [R11.1]
    expect(screen.getAllByText('Pending sync').length).toBeGreaterThan(0);
    expect(screen.getByText('Recorded quantities')).toBeTruthy();
    // Received column labels the queued quantity as "+2" pending...
    expect(
      screen.getByText(
        (_, element) =>
          element?.tagName === 'SPAN' && /^\s*\+2\s*$/.test(element.textContent ?? ''),
      ),
    ).toBeTruthy();
    // ...and remaining adjusts locally: 6 remaining - 2 pending = 4
    // (the received cell also reads 4, so both cells match).
    expect(screen.getAllByText('4').length).toBe(2);
  });

  it('surfaces conflicted receipts as a needs-attention card with retry, preserving quantities', async () => {
    mocks.listQueuedPoReceipts.mockResolvedValue([
      {
        queueId: 'queue-9',
        idempotencyKey: 'key-9',
        purchaseOrderId: 'po-1',
        recordedAt: '2026-08-05T10:15:00.000Z',
        notes: null,
        state: 'conflict',
        errorMessage: 'Conflict detected (HTTP 409) requiring review: manual',
        lines: [
          { purchaseOrderItemId: 'item-1', quantityReceived: 3, unitCost: null, isUnplanned: false },
        ],
      },
    ]);
    render(<PurchaseOrdersTab />);
    await screen.findAllByText('Needs attention');

    fireEvent.click(screen.getByText('PO-2026-000001'));
    expect(screen.getAllByText('Needs attention').length).toBeGreaterThan(0);
    // Recorded quantities preserved for staff resolution. [R11.7]
    expect(screen.getByText(/Tomatoes: 3/)).toBeTruthy();

    fireEvent.click(screen.getByText('Retry sync'));
    await waitFor(() => expect(mocks.retryQueuedPoReceipt).toHaveBeenCalledWith('queue-9'));
  });

  it('labels parked receipts waiting for module access', async () => {
    mocks.listQueuedPoReceipts.mockResolvedValue([
      {
        queueId: 'queue-5',
        idempotencyKey: 'key-5',
        purchaseOrderId: 'po-1',
        recordedAt: '2026-08-05T10:15:00.000Z',
        notes: null,
        state: 'parked',
        errorMessage: 'MODULE_REQUIRED: organization is missing module(s): suppliers',
        lines: [
          { purchaseOrderItemId: 'item-1', quantityReceived: 1, unitCost: null, isUnplanned: false },
        ],
      },
    ]);
    render(<PurchaseOrdersTab />);
    await screen.findAllByText('Pending sync');

    fireEvent.click(screen.getByText('PO-2026-000001'));
    // Parked = retained, visibly waiting for the module. [R11.6]
    expect(screen.getByText('Waiting for module access')).toBeTruthy();
  });
});

describe('classifyReceiveFailure', () => {
  it('maps typed outcomes from status + error text', () => {
    expect(
      classifyReceiveFailure({
        status: 409,
        error: 'PO_STATE_CONFLICT (HTTP 409): {"poStatus":"received_closed"}',
      }),
    ).toEqual({ type: 'conflict', poStatus: 'received_closed' });

    expect(
      classifyReceiveFailure({
        status: 403,
        error: 'MODULE_REQUIRED (HTTP 403): {"missingModules":["suppliers"]}',
      }),
    ).toEqual({ type: 'module_required' });

    expect(
      classifyReceiveFailure({
        status: 422,
        error: 'OVER_RECEIPT_CONFIRMATION_REQUIRED (HTTP 422)',
      }),
    ).toEqual({ type: 'confirmation_required' });

    expect(classifyReceiveFailure({ status: 400, error: 'Invalid request body' })).toEqual({
      type: 'rejected',
      message: 'Invalid request body',
    });

    // No HTTP status → the request never reached the server.
    expect(
      classifyReceiveFailure({ error: 'This action requires an online connection.' }),
    ).toEqual({ type: 'transport' });
  });
});
