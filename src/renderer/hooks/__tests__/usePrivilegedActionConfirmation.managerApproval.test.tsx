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
  default: ({ isOpen, subtitle, onClose, onSubmit, blockedMessage, errorMessage }: any) =>
    isOpen ? (
      <div role="dialog">
        <p data-testid="pin-subtitle">{subtitle}</p>
        {blockedMessage ? <p role="status">{blockedMessage}</p> : <button type="button" onClick={() => void onSubmit('2468')}>
          Enter PIN
        </button>}
        {errorMessage && <p role="alert">{errorMessage}</p>}
        <button type="button" onClick={onClose}>Cancel</button>
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

function Harness({ action, onDone, onError, onPinRefused }: { action: () => Promise<string>; onDone: (v: string) => void; onError?: (error: unknown) => void; onPinRefused?: () => void }) {
  const { runWithPrivilegedConfirmation, confirmationModal } = usePrivilegedActionConfirmation();
  return (
    <>
      <button
        type="button"
        onClick={() =>
          void runWithPrivilegedConfirmation({
            scope: 'cash_drawer_control',
            action,
            onPinRefused,
            title: 'Approve recording the payment',
            subtitle: 'Enter the cashier or manager PIN.',
          }).then(onDone, onError)
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

describe('till sign-in for privileged actions', () => {
  it('asks for the till PIN when expired, records a wrong PIN and resumes after confirmation', async () => {
    const action = vi.fn().mockRejectedValueOnce({ code: 'AUTH_SESSION_EXPIRED' }).mockResolvedValueOnce('recorded');
    const onDone = vi.fn();
    const onPinRefused = vi.fn();
    mock.confirmPrivilegedAction.mockRejectedValueOnce({ code: 'AUTH_PIN_WRONG' });
    render(<Harness action={action} onDone={onDone} onPinRefused={onPinRefused} />);
    await act(async () => screen.getByRole('button', { name: 'Record' }).click());
    expect(screen.getByTestId('pin-subtitle')).toHaveTextContent('The till sign-in has expired. Enter the till PIN again.');
    await act(async () => screen.getByRole('button', { name: 'Enter PIN' }).click());
    expect(onPinRefused).toHaveBeenCalledOnce();
    expect(action).toHaveBeenCalledTimes(1);
    await act(async () => screen.getByRole('button', { name: 'Enter PIN' }).click());
    expect(onDone).toHaveBeenCalledWith('recorded');
    expect(action).toHaveBeenCalledTimes(2);
  });

  it('forwards a missing session without offering a misleading confirmation', async () => {
    const error = { code: 'AUTH_SESSION_REQUIRED' };
    const onError = vi.fn();
    render(<Harness action={vi.fn().mockRejectedValue(error)} onDone={vi.fn()} onError={onError} />);
    await act(async () => screen.getByRole('button', { name: 'Record' }).click());
    expect(onError).toHaveBeenCalledWith(error);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it.each(['AUTH_SHIFT_REQUIRED', 'AUTH_PERMISSION_REQUIRED'])('does not ask for a PIN after %s', async code => {
    const onError = vi.fn();
    render(<Harness action={vi.fn().mockRejectedValue({ code })} onDone={vi.fn()} onError={onError} />);
    await act(async () => screen.getByRole('button', { name: 'Record' }).click());
    expect(onError).toHaveBeenCalledWith({ code });
    expect(mock.confirmPrivilegedAction).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('closes confirmation on lockout and leaves the action unexecuted', async () => {
    const action = vi.fn().mockRejectedValueOnce({ code: 'AUTH_SESSION_EXPIRED' });
    const lockout = { code: 'AUTH_LOCKED_OUT', minutes: 15 };
    const onError = vi.fn();
    mock.confirmPrivilegedAction.mockRejectedValueOnce(lockout);
    render(<Harness action={action} onDone={vi.fn()} onError={onError} />);
    await act(async () => screen.getByRole('button', { name: 'Record' }).click());
    await act(async () => screen.getByRole('button', { name: 'Enter PIN' }).click());
    expect(onError).toHaveBeenCalledWith(expect.objectContaining(lockout));
    expect(action).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('explains that the approval expired and renews it for the original action', async () => {
    const action = vi.fn().mockRejectedValueOnce({ code: 'AUTH_GRANT_EXPIRED' }).mockResolvedValueOnce('recorded');
    const onDone = vi.fn();
    render(<Harness action={action} onDone={onDone} />);
    await act(async () => screen.getByRole('button', { name: 'Record' }).click());
    expect(screen.getByTestId('pin-subtitle')).toHaveTextContent('recovery.actionStatus.grantExpired');
    await act(async () => screen.getByRole('button', { name: 'Enter PIN' }).click());
    expect(action).toHaveBeenCalledTimes(2);
    expect(onDone).toHaveBeenCalledWith('recorded');
  });

  it('does not run the action when confirmation is cancelled', async () => {
    const action = vi.fn().mockRejectedValueOnce({ code: 'AUTH_SESSION_EXPIRED' });
    const onError = vi.fn();
    render(<Harness action={action} onDone={vi.fn()} onError={onError} />);
    await act(async () => screen.getByRole('button', { name: 'Record' }).click());
    await act(async () => screen.getByRole('button', { name: 'Cancel' }).click());
    expect(onError).toHaveBeenCalledWith(new Error('AUTH_CONFIRMATION_CANCELLED'));
    expect(action).toHaveBeenCalledTimes(1);
  });

  it('closes the PIN prompt before an accepted action can commit', async () => {
    let finish!: (value: string) => void;
    const executing = new Promise<string>(resolve => { finish = resolve; });
    const action = vi.fn().mockRejectedValueOnce({ code: 'AUTH_SESSION_EXPIRED' }).mockReturnValueOnce(executing);
    const onDone = vi.fn();
    render(<Harness action={action} onDone={onDone} />);
    await act(async () => screen.getByRole('button', { name: 'Record' }).click());
    await act(async () => screen.getByRole('button', { name: 'Enter PIN' }).click());
    expect(action).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull();
    await act(async () => finish('recorded'));
    expect(onDone).toHaveBeenCalledWith('recorded');
  });
});

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
