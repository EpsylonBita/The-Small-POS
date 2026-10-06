import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Item D1, fix review 30/09/2026. Releasing a table (Set available,
// Cleaned, a reservation released) used to leave the table's order alone
// and rely on the server to cancel it. The server now frees the table and
// ends its session but leaves an order that owes money open, so it lingered
// as an orphan: shown occupied, payable, not cancellable, exempt from the Z.
// Now the operator decides first: collect, cancel with a reason and the
// manager's approval, or keep it as an open tab.

const mock = vi.hoisted(() => ({
  getSettlementSnapshot: vi.fn(),
  cancelWithApproval: vi.fn(),
  emit: vi.fn(),
  invoke: vi.fn(),
}));

vi.mock('../../../lib', () => ({
  emitCompatEvent: mock.emit,
  getBridge: () => ({
    invoke: mock.invoke,
    payments: { getSettlementSnapshot: mock.getSettlementSnapshot },
    orders: { cancelWithApproval: mock.cancelWithApproval },
  }),
}));

vi.mock('react-i18next', () => ({ initReactI18next: { type: '3rdParty', init: () => {} }, useTranslation: () => ({ i18n: { language: 'en' }, t: (key: string) => ({ 'modals.orderCancellation.confirm': 'Cancel the order', 'modals.orderCancellation.keepOrder': 'Keep order', 'modals.orderCancellation.cashDrawer': 'Cash drawer', 'modals.orderCancellation.bank': 'Bank' }[key] ?? key) }) }));
vi.mock('react-hot-toast', () => ({
  default: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), dismiss: vi.fn() }),
}));

vi.mock('../../contexts/i18n-context', () => {
  const t = (key: string, options?: { defaultValue?: string } & Record<string, unknown>) => {
    let text = options?.defaultValue ?? key;
    for (const [name, value] of Object.entries(options ?? {})) {
      text = text.replace(`{{${name}}}`, String(value));
    }
    return text;
  };
  return { useI18n: () => ({ t, language: 'en' }) };
});

vi.mock('../../components/ui/pos-glass-components', () => ({
  LiquidGlassModal: ({ isOpen, title, children, footer }: any) =>
    isOpen ? (
      <div role="dialog">
        <h2>{title}</h2>
        {children}{footer}
      </div>
    ) : null,
}));

import { owingCancelFailureMessage, refuseOwingCancelUpFront, useTableReleaseGuard } from '../useTableReleaseGuard';

it('explains why a cancellation retry needs its original approving staff member', () => {
  const message = owingCancelFailureMessage(new Error('ORIGINAL_CANCEL_APPROVER_REQUIRED'), (_key, options) => options?.defaultValue);
  expect(message).toContain('original approving staff member');
  expect(message).toContain('table was not released');
});
it('explains that offline canonical cancellation requires reconnecting and syncing', () => {
  const message = owingCancelFailureMessage(new Error('TABLE_CANCEL_SYNC_REQUIRED'), (_key, options) => options?.defaultValue);
  expect(message).toContain('Reconnect');
  expect(message).toContain('table was not released');
});

import type { RestaurantTable } from '../../types/tables';

const table = {
  id: 'table-5',
  organizationId: 'org-1',
  branchId: 'branch-1',
  tableNumber: 5,
  capacity: 4,
  status: 'cleaning',
  positionX: null,
  positionY: null,
  shape: null,
  notes: null,
  createdAt: '2026-09-30T10:00:00Z',
  updatedAt: '2026-09-30T10:00:00Z',
  currentOrderId: 'order-table-5',
  tableSessionId: '11111111-1111-4111-8111-111111111111',
} as RestaurantTable;

const release = vi.fn(async () => true);
const onCollect = vi.fn();
const runWithPrivilegedConfirmation = vi.fn(async ({ action }: { action: () => Promise<unknown> }) =>
  action(),
);

function Harness() {
  const guard = useTableReleaseGuard({
    runWithPrivilegedConfirmation: runWithPrivilegedConfirmation as any,
    onCollect,
  });
  return (
    <>
      <button type="button" onClick={() => void guard.guardRelease(table, release)}>
        Release
      </button>
      {guard.modal}
    </>
  );
}

beforeEach(() => {
  mock.invoke.mockReset().mockImplementation(async (_command, args) => ({ success: true, ...args, requiresReturn: false, requiresHandback: false, amountCents: 0, currency: 'EUR', generation: 'generation-1', requestId: 'cancel-event-1' }));
  mock.getSettlementSnapshot.mockReset();
  mock.cancelWithApproval.mockReset();
  mock.emit.mockClear();
  release.mockClear();
  onCollect.mockClear();
  runWithPrivilegedConfirmation.mockClear();
});

afterEach(() => cleanup());

const clickRelease = async () => {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Release' }));
  });
};

describe('releasing a table whose order owes money', () => {
  it('releases at once when the order owes nothing', async () => {
    mock.getSettlementSnapshot.mockResolvedValue({ outstandingAmount: 0 });
    render(<Harness />);

    await clickRelease();

    await waitFor(() => expect(release).toHaveBeenCalledTimes(1));
    expect(screen.queryByTestId('table-release-owed')).toBeNull();
  });

  it('asks first and releases nothing on its own', async () => {
    mock.getSettlementSnapshot.mockResolvedValue({ outstandingAmount: 13 });
    render(<Harness />);

    await clickRelease();

    expect(await screen.findByTestId('table-release-owed')).toBeTruthy();
    expect(screen.getByRole('heading').textContent).toContain('still owes');
    expect(release).not.toHaveBeenCalled();
  });

  it('collect opens the check and keeps the table as it is', async () => {
    mock.getSettlementSnapshot.mockResolvedValue({ outstandingAmount: 13 });
    render(<Harness />);
    await clickRelease();

    await act(async () => {
      fireEvent.click(await screen.findByRole('button', { name: 'Collect the payment' }));
    });

    expect(onCollect).toHaveBeenCalledWith(table);
    expect(release).not.toHaveBeenCalled();
  });

  it('keep as an open tab releases the table and leaves the order open', async () => {
    mock.getSettlementSnapshot.mockResolvedValue({ outstandingAmount: 13 });
    render(<Harness />);
    await clickRelease();

    await act(async () => {
      fireEvent.click(await screen.findByRole('button', { name: /Keep as an open tab/ }));
    });

    await waitFor(() => expect(release).toHaveBeenCalledTimes(1));
    expect(mock.cancelWithApproval).not.toHaveBeenCalled();
  });

  it('cancel needs a reason and the approval, then releases the table', async () => {
    mock.getSettlementSnapshot.mockResolvedValue({ outstandingAmount: 13 });
    mock.cancelWithApproval.mockResolvedValue({ success: true, orderId: 'order-table-5', data: { workflow: {
      affected_table_ids: ['table-5', 'table-6'], affected_session_ids: [table.tableSessionId],
    } } });
    render(<Harness />);
    await clickRelease();

    await act(async () => {
      fireEvent.click(await screen.findByRole('button', { name: 'Cancel the order' }));
    });
    const confirm = screen.getByRole('button', { name: 'Cancel the order' });
    expect((confirm as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByRole('textbox'), {
      target: { value: 'The customer left without ordering' },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Cancel the order' }));
    });

    await waitFor(() => expect(mock.emit).toHaveBeenCalledWith('table-session-settled', expect.objectContaining({tableId:'table-6'})));
    expect(release).not.toHaveBeenCalled();
    expect(runWithPrivilegedConfirmation).toHaveBeenCalledWith(
      expect.objectContaining({ scope: 'cash_drawer_control' }),
    );
    expect(mock.cancelWithApproval).toHaveBeenCalledWith(expect.objectContaining({
      orderId: 'order-table-5',
      reason: 'The customer left without ordering',
      tableSessionId: table.tableSessionId,
    }));
  });

  it('a refused approval releases nothing', async () => {
    mock.getSettlementSnapshot.mockResolvedValue({ outstandingAmount: 13 });
    mock.cancelWithApproval.mockRejectedValue(new Error('Privileged action confirmation cancelled'));
    render(<Harness />);
    await clickRelease();
    await act(async () => {
      fireEvent.click(await screen.findByRole('button', { name: 'Cancel the order' }));
    });
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'No show' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Cancel the order' }));
    });

    expect(release).not.toHaveBeenCalled();
  });

  it('an order money was taken on is refused with its own message and the table stays', async () => {
    // The till answers a plain message (a Tauri command error is a string).
    mock.getSettlementSnapshot.mockResolvedValue({ outstandingAmount: 8 });
    mock.cancelWithApproval.mockRejectedValue(
      'ORDER_HAS_PAYMENTS: money was taken on this order. Void or refund it from the order first, or collect the rest.',
    );
    const toast = (await import('react-hot-toast')).default as unknown as {
      error: ReturnType<typeof vi.fn>;
    };
    toast.error.mockClear();
    render(<Harness />);
    await clickRelease();
    await act(async () => {
      fireEvent.click(await screen.findByRole('button', { name: 'Cancel the order' }));
    });
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'The customer left' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Cancel the order' }));
    });

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        'Money was taken on this order. Void or refund it from the order first, or collect the rest.',
      ),
    );
    expect(release).not.toHaveBeenCalled();
    // The question stays: collect the rest or keep an open tab.
    expect(screen.getByRole('textbox')).toBeTruthy();
  });

  it('an unreadable ledger falls back to the table balance, never "nothing owed"', async () => {
    mock.getSettlementSnapshot.mockRejectedValue(new Error('database is locked'));
    render(<Harness />);
    const owingTable = { ...table, unpaidBalance: 9 } as RestaurantTable;
    function OwingHarness() {
      const guard = useTableReleaseGuard({
        runWithPrivilegedConfirmation: runWithPrivilegedConfirmation as any,
        onCollect,
      });
      return (
        <>
          <button type="button" onClick={() => void guard.guardRelease(owingTable, release)}>
            Release owing
          </button>
          {guard.modal}
        </>
      );
    }
    cleanup();
    render(<OwingHarness />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Release owing' }));
    });

    expect(await screen.findByTestId('table-release-owed')).toBeTruthy();
    expect(release).not.toHaveBeenCalled();
  });
});

// Round 2 review (founder rule 30/09 and 01/10/2026: an order is never paid
// without its payment record; a missing record is restored or recorded,
// never charged again; a refusal comes before any reason or PIN). The
// settlement snapshot already names the till's refusal, and the release
// question ignored it: it offered Collect on an order labelled paid with no
// payment record, and asked the cancel reason before the refusal.
describe('releasing a table whose order the till refuses to cancel', () => {
  it('never offers to collect a paid label with no payment record, nor to cancel it', async () => {
    mock.getSettlementSnapshot.mockResolvedValue({
      outstandingAmount: 9,
      netPaid: 0,
      cancelRefusal: 'ORDER_PAYMENT_NOT_RECORDED',
    });
    render(<Harness />);

    await clickRelease();

    expect(await screen.findByTestId('table-release-owed')).toBeTruthy();
    expect(screen.getByRole('heading').textContent).toContain('payment is not recorded');
    expect(screen.queryByRole('button', { name: 'Collect the payment' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Cancel the order' })).toBeNull();
    expect(screen.getByTestId('table-release-owed').textContent).toContain('Do not charge it again');
    expect(release).not.toHaveBeenCalled();
  });

  it('can still free the table and leave such an order as it is', async () => {
    mock.getSettlementSnapshot.mockResolvedValue({
      outstandingAmount: 9,
      cancelRefusal: 'ORDER_PAYMENT_NOT_RECORDED',
    });
    render(<Harness />);
    await clickRelease();

    await act(async () => {
      fireEvent.click(await screen.findByRole('button', { name: /Keep as an open tab/ }));
    });

    await waitFor(() => expect(release).toHaveBeenCalledTimes(1));
    expect(onCollect).not.toHaveBeenCalled();
    expect(mock.cancelWithApproval).not.toHaveBeenCalled();
  });

  it('offers canonical cancellation when the order has received money', async () => {
    mock.getSettlementSnapshot.mockResolvedValue({
      outstandingAmount: 4,
      netPaid: 5,
      cancelRefusal: 'ORDER_HAS_PAYMENTS',
    });
    render(<Harness />);
    await clickRelease();

    expect(await screen.findByRole('button', { name: 'Collect the payment' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Cancel the order' })).toBeTruthy();
    expect(screen.queryByTestId('table-release-cancel-refused')).toBeNull();
  });
});

// Review 06/10/2026, regression from 91591acc8: "Cancel the order" did
// nothing at all when the table had no check session (the canonical preflight
// needs one). Such a table keeps the release question's own reason step.
describe('releasing a table that has no check session', () => {
  const noSession = { ...table, tableSessionId: null } as RestaurantTable;
  function NoSessionHarness() {
    const guard = useTableReleaseGuard({
      runWithPrivilegedConfirmation: runWithPrivilegedConfirmation as any,
      onCollect,
    });
    return (
      <>
        <button type="button" onClick={() => void guard.guardRelease(noSession, release)}>
          Release legacy
        </button>
        {guard.modal}
      </>
    );
  }

  it('cancels an unpaid order with a reason and the approval instead of doing nothing', async () => {
    mock.getSettlementSnapshot.mockResolvedValue({ outstandingAmount: 13, netPaid: 0, cancelRefusal: null });
    mock.cancelWithApproval.mockResolvedValue({ success: true, orderId: 'order-table-5', data: { workflow: {
      affected_table_ids: ['table-5'], affected_session_ids: [],
    } } });
    render(<NoSessionHarness />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Release legacy' }));
    });
    await act(async () => {
      fireEvent.click(await screen.findByRole('button', { name: 'Cancel the order' }));
    });
    // The reason step opened: no canonical preflight without a check session.
    expect(mock.invoke).not.toHaveBeenCalled();
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Walked out' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Cancel the order' }));
    });
    await waitFor(() => expect(mock.cancelWithApproval).toHaveBeenCalledTimes(1));
    const params = mock.cancelWithApproval.mock.calls[0][0];
    expect(params).toMatchObject({ orderId: 'order-table-5', reason: 'Walked out' });
    expect(params.tableSessionId).toBeUndefined();
    expect(params.manualCancellation).toBeUndefined();
  });

  it('a paid order says why it cannot be cancelled here instead of a dead button', async () => {
    mock.getSettlementSnapshot.mockResolvedValue({ outstandingAmount: 4, netPaid: 5, cancelRefusal: 'ORDER_HAS_PAYMENTS' });
    render(<NoSessionHarness />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Release legacy' }));
    });
    expect(await screen.findByTestId('table-release-cancel-refused')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Cancel the order' })).toBeNull();
  });
});

// Review 06/10/2026: a refused table cancellation used to lock the check, its
// refunds and the Z for good. A proven refusal is never sent again and a
// manager clears it with their own PIN; the check is then read again.
describe('a saved table cancellation the server refused', () => {
  const refusedPlan = {
    success: true, orderId: 'order-table-5', tableSessionId: table.tableSessionId, requestId: 'refused-event',
    requiresReturn: true, requiresHandback: false, amountCents: 1050, currency: 'EUR', generation: 'g-1',
    pending: true, refused: true, refusalCode: 'approval_refused:HTTP_403', reason: 'Customer left', returnChannel: 'bank',
  };

  it('is cleared by a manager and the next attempt starts from a fresh plan', async () => {
    mock.getSettlementSnapshot.mockResolvedValue({ outstandingAmount: 0.01, netPaid: 10.5, cancelRefusal: 'ORDER_HAS_PAYMENTS' });
    mock.invoke.mockReset()
      .mockResolvedValueOnce(refusedPlan)
      .mockResolvedValueOnce({ ...refusedPlan, requestId: 'fresh-event', pending: false, refused: false, refusalCode: null, reason: undefined, returnChannel: undefined });
    mock.cancelWithApproval.mockResolvedValue({ success: true, released: true, orderId: 'order-table-5' });
    render(<Harness />);
    await clickRelease();
    await act(async () => {
      fireEvent.click(await screen.findByRole('button', { name: 'Cancel the order' }));
    });
    expect(await screen.findByTestId('order-cancellation-saved-attempt')).toBeTruthy();
    // Never resubmitted: the confirm stays disabled.
    expect((screen.getByRole('button', { name: 'Cancel the order' }) as HTMLButtonElement).disabled).toBe(true);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'modals.orderCancellation.clearRefusedAttempt' }));
    });
    await waitFor(() => expect(mock.cancelWithApproval).toHaveBeenCalledTimes(1));
    expect(mock.cancelWithApproval.mock.calls[0][0]).toMatchObject({
      orderId: 'order-table-5', tableSessionId: table.tableSessionId,
      releaseRefusedCancellation: { clientEventId: 'refused-event' },
    });
    expect(mock.cancelWithApproval.mock.calls[0][0].manualCancellation).toBeUndefined();
    await waitFor(() => expect(mock.invoke).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByTestId('order-cancellation-saved-attempt')).toBeNull());
    // The fresh attempt starts with no return channel chosen.
    expect(screen.getByRole('button', { name: 'Bank' }).getAttribute('aria-pressed')).toBe('false');
    expect(screen.getByRole('button', { name: 'Cash drawer' }).getAttribute('aria-pressed')).toBe('false');
    expect(mock.emit).not.toHaveBeenCalled();
    expect(release).not.toHaveBeenCalled();
  });

  it('explains a refused attempt and a clear that has to wait', () => {
    const t = (_key: string, options?: Record<string, unknown>) => {
      let text = String(options?.defaultValue ?? '');
      for (const [name, value] of Object.entries(options ?? {})) text = text.replace(`{{${name}}}`, String(value));
      return text;
    };
    expect(owingCancelFailureMessage('TABLE_CANCELLATION_REFUSED: refused', t)).toContain('No money was returned');
    expect(owingCancelFailureMessage(new Error('TABLE_CANCELLATION_RELEASE_WAIT:9'), t)).toContain('9 min');
    expect(owingCancelFailureMessage('TABLE_CANCELLATION_COMMITTED: done', t)).toContain('already recorded');
  });
});

describe('refuseOwingCancelUpFront (the table check asks it before the reason)', () => {
  const t = (key: string, options?: Record<string, unknown>) =>
    typeof options?.defaultValue === 'string' ? options.defaultValue : key;

  it('refuses a paid label with no payment record and says what to do', async () => {
    const toast = (await import('react-hot-toast')).default as unknown as {
      error: ReturnType<typeof vi.fn>;
    };
    toast.error.mockClear();
    mock.getSettlementSnapshot.mockResolvedValue({
      outstandingAmount: 9,
      netPaid: 0,
      cancelRefusal: 'ORDER_PAYMENT_NOT_RECORDED',
    });

    await expect(refuseOwingCancelUpFront('order-table-5', t)).resolves.toBe(true);
    expect(toast.error).toHaveBeenCalledWith(
      'This order is marked paid, but its payment is not recorded on this till. Restore it from the server with Sync Now, or record the payment from the Z Report, then cancel.',
    );
  });

  it('lets an order with nothing taken go on to the reason', async () => {
    mock.getSettlementSnapshot.mockResolvedValue({ outstandingAmount: 9, netPaid: 0, cancelRefusal: null });

    await expect(refuseOwingCancelUpFront('order-table-5', t)).resolves.toBe(false);
  });
});
