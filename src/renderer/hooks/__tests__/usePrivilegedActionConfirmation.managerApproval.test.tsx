import React from 'react';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Fix review 30/09/2026. The Z needs every staff member checked out, and its
// money actions ("Record cash/card", "Money given back") needed an active
// cashier or manager shift on this terminal: they answered "shift required"
// exactly when the Z needed them. The till now asks a manager's own PIN
// (REAUTH_REQUIRED with `approval`); the prompt says so and the PIN goes to the
// till with what it approves.

const mock = vi.hoisted(() => ({
  confirmPrivilegedAction: vi.fn(),
  available: vi.fn(),
}));

vi.mock('../../../lib', () => ({
  getBridge: () => ({ auth: { confirmPrivilegedAction: mock.confirmPrivilegedAction } }),
}));

vi.mock('../../services/manager-approval', () => ({
  managerApprovalAvailable: mock.available,
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { defaultValue?: string; right?: string; minutes?: number }) =>
      `${options?.defaultValue ?? key}${options?.right ? `: ${options.right}` : ''}${options?.minutes ? `: ${options.minutes}` : ''}`,
  }),
}));

vi.mock('../../components/auth/PINLoginModal', () => ({
  default: ({ isOpen, subtitle, onSubmit, blockedMessage, errorMessage }: any) =>
    isOpen ? (
      <div role="dialog">
        <p data-testid="pin-subtitle">{subtitle}</p>
        {blockedMessage ? <p role="status">{blockedMessage}</p> : <button type="button" onClick={() => void onSubmit('2468')}>
          Enter PIN
        </button>}
        {errorMessage && <p role="alert">{errorMessage}</p>}
      </div>
    ) : null,
}));

import { usePrivilegedActionConfirmation } from '../usePrivilegedActionConfirmation';

const managerApprovalRequired = {
  code: 'REAUTH_REQUIRED',
  scope: 'cash_drawer_control',
  reason:
    'No cashier or manager is on shift at this terminal: a manager approves with their own PIN',
  ttlSeconds: 300,
  approval: 'void_payments',
};

function Harness({ action, onDone }: { action: () => Promise<string>; onDone: (v: string) => void }) {
  const { runWithPrivilegedConfirmation, confirmationModal } = usePrivilegedActionConfirmation();
  return (
    <>
      <button
        type="button"
        onClick={() =>
          void runWithPrivilegedConfirmation({
            scope: 'cash_drawer_control',
            action,
            title: 'Approve recording the payment',
            subtitle: 'Enter the cashier or manager PIN.',
          }).then(onDone, () => undefined)
        }
      >
        Record
      </button>
      {confirmationModal}
    </>
  );
}

beforeEach(() => {
  mock.confirmPrivilegedAction.mockReset().mockResolvedValue({ success: true });
  mock.available.mockReset().mockResolvedValue({ available: true, permission: 'pos.refunds.process' });
});
afterEach(cleanup);

describe('usePrivilegedActionConfirmation: a manager approves with nobody on shift', () => {
  it('shows the missing store right instead of collecting a PIN when nobody can approve', async () => {
    mock.available.mockResolvedValue({ available: false, permission: 'pos.refunds.process' });
    const action = vi.fn().mockRejectedValue(managerApprovalRequired);
    render(<Harness action={action} onDone={vi.fn()} />);
    await act(async () => { screen.getByRole('button', { name: 'Record' }).click(); });
    expect(mock.available).toHaveBeenCalledWith('void_payments');
    expect(screen.getByRole('status').textContent).toContain('auth.managerApproval.noApprover');
    expect(screen.queryByRole('button', { name: 'Enter PIN' })).toBeNull();
    expect(mock.confirmPrivilegedAction).not.toHaveBeenCalled();
  });

  it('keeps the dialog open and explains a refused personal manager PIN', async () => {
    mock.confirmPrivilegedAction.mockRejectedValue({ code: 'UNAUTHORIZED', reason: 'Invalid PIN' });
    render(<Harness action={vi.fn().mockRejectedValue(managerApprovalRequired)} onDone={vi.fn()} />);
    await act(async () => { screen.getByRole('button', { name: 'Record' }).click(); });
    await act(async () => { screen.getByRole('button', { name: 'Enter PIN' }).click(); });
    expect(screen.getByRole('alert').textContent).toContain('auth.managerApproval.pinRefused');
    expect(screen.getByRole('dialog')).toBeTruthy();
  });

  it('keeps paused approvals open without a PIN pad, then allows entry when the pause expires', async () => {
    mock.confirmPrivilegedAction.mockRejectedValue(JSON.stringify({ code: 'APPROVALS_PAUSED', minutes: 5, permission: 'pos.refunds.process' }));
    render(<Harness action={vi.fn().mockRejectedValue(managerApprovalRequired)} onDone={vi.fn()} />);
    await act(async () => { screen.getByRole('button', { name: 'Record' }).click(); });
    vi.useFakeTimers();
    try {
      await act(async () => { screen.getByRole('button', { name: 'Enter PIN' }).click(); });
      expect(screen.getByRole('status').textContent).toContain('auth.managerApproval.paused');
      expect(screen.getByRole('status').textContent).toContain('5');
      expect(screen.queryByRole('button', { name: 'Enter PIN' })).toBeNull();
      await act(async () => { await vi.advanceTimersByTimeAsync(5 * 60_000); });
      expect(screen.getByRole('button', { name: 'Enter PIN' })).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it('handles a directory change discovered during PIN confirmation without closing', async () => {
    mock.confirmPrivilegedAction.mockRejectedValue({ code: 'NO_APPROVER_IN_STORE', permission: 'pos.refunds.process' });
    render(<Harness action={vi.fn().mockRejectedValue(managerApprovalRequired)} onDone={vi.fn()} />);
    await act(async () => { screen.getByRole('button', { name: 'Record' }).click(); });
    await act(async () => { screen.getByRole('button', { name: 'Enter PIN' }).click(); });
    expect(screen.getByRole('status').textContent).toContain('auth.managerApproval.noApprover');
    expect(screen.queryByRole('button', { name: 'Enter PIN' })).toBeNull();
  });
  it("asks for a manager's own PIN and sends what it approves", async () => {
    const action = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(managerApprovalRequired)
      .mockResolvedValueOnce('recorded');
    const onDone = vi.fn();
    render(<Harness action={action} onDone={onDone} />);

    await act(async () => {
      screen.getByRole('button', { name: 'Record' }).click();
    });
    expect(await screen.findByRole('dialog')).toBeTruthy();
    expect(screen.getByTestId('pin-subtitle').textContent).toContain(
      'A manager with the right to approve it enters their own PIN',
    );

    await act(async () => {
      screen.getByRole('button', { name: 'Enter PIN' }).click();
    });

    await waitFor(() => expect(onDone).toHaveBeenCalledWith('recorded'));
    expect(mock.confirmPrivilegedAction).toHaveBeenCalledWith({
      pin: '2468',
      scope: 'cash_drawer_control',
      approval: 'void_payments',
    });
  });

  it('keeps the terminal PIN prompt as it was when a shift is open', async () => {
    const action = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce({ code: 'REAUTH_REQUIRED', scope: 'cash_drawer_control', reason: 'Fresh PIN confirmation required' })
      .mockResolvedValueOnce('recorded');
    const onDone = vi.fn();
    render(<Harness action={action} onDone={onDone} />);

    await act(async () => {
      screen.getByRole('button', { name: 'Record' }).click();
    });
    expect(screen.getByTestId('pin-subtitle').textContent).toBe('Enter the cashier or manager PIN.');
    await act(async () => {
      screen.getByRole('button', { name: 'Enter PIN' }).click();
    });

    await waitFor(() => expect(onDone).toHaveBeenCalledWith('recorded'));
    expect(mock.confirmPrivilegedAction).toHaveBeenCalledWith({
      pin: '2468',
      scope: 'cash_drawer_control',
    });
  });

  it("says why a paid cancellation asks for an approver's PIN while a cashier is on shift", async () => {
    // Founder 07/10/2026: nobody at the till may cancel the paid order, so a
    // staff member who may approves it; "nobody is checked in" would be false.
    function CancelHarness({ action, onDone }: { action: () => Promise<string>; onDone: (v: string) => void }) {
      const { runWithPrivilegedConfirmation, confirmationModal } = usePrivilegedActionConfirmation();
      return (
        <>
          <button
            type="button"
            onClick={() =>
              void runWithPrivilegedConfirmation({
                scope: 'cash_drawer_control',
                action,
                title: 'Approve the cancellation',
                approvalSubtitle: 'Cancelling a paid order needs the right to cancel.',
              }).then(onDone, () => undefined)
            }
          >
            Cancel order
          </button>
          {confirmationModal}
        </>
      );
    }
    const action = vi
      .fn<() => Promise<string>>()
      // The till's own words, as the Rust command sends them: a JSON string.
      .mockRejectedValueOnce(
        JSON.stringify({
          code: 'REAUTH_REQUIRED',
          scope: 'cash_drawer_control',
          reason:
            'ORDER_CANCELLATION_PERMISSION_REQUIRED: a staff member who may cancel paid orders approves it with their own PIN',
          ttlSeconds: 300,
          approval: 'void_orders',
        }),
      )
      .mockResolvedValueOnce('cancelled');
    const onDone = vi.fn();
    render(<CancelHarness action={action} onDone={onDone} />);

    await act(async () => {
      screen.getByRole('button', { name: 'Cancel order' }).click();
    });
    expect(screen.getByTestId('pin-subtitle').textContent).toBe(
      'Cancelling a paid order needs the right to cancel.',
    );
    await act(async () => {
      screen.getByRole('button', { name: 'Enter PIN' }).click();
    });

    await waitFor(() => expect(onDone).toHaveBeenCalledWith('cancelled'));
    expect(mock.confirmPrivilegedAction).toHaveBeenCalledWith({
      pin: '2468',
      scope: 'cash_drawer_control',
      approval: 'void_orders',
    });
  });
});
