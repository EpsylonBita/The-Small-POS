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
}));

vi.mock('../../../lib', () => ({
  getBridge: () => ({ auth: { confirmPrivilegedAction: mock.confirmPrivilegedAction } }),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { defaultValue?: string }) => options?.defaultValue ?? key,
  }),
}));

vi.mock('../../components/auth/PINLoginModal', () => ({
  default: ({ isOpen, subtitle, onSubmit }: any) =>
    isOpen ? (
      <div role="dialog">
        <p data-testid="pin-subtitle">{subtitle}</p>
        <button type="button" onClick={() => void onSubmit('2468')}>
          Enter PIN
        </button>
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
});
afterEach(cleanup);

describe('usePrivilegedActionConfirmation: a manager approves with nobody on shift', () => {
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
