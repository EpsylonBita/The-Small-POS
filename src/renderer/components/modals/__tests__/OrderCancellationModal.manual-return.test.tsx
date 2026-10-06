import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import OrderCancellationModal from '../OrderCancellationModal';
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('../../ui/pos-glass-components', () => ({ LiquidGlassModal: ({ isOpen, children, footer }: any) => isOpen ? <div>{children}{footer}</div> : null }));
afterEach(cleanup);
const key = (name: string) => `modals.orderCancellation.${name}`;

describe('manual paid order cancellation', () => {
  it.each([['cashDrawer', 'cash_drawer'], ['bank', 'bank']] as const)('records %s only after explicit channel and reason', async (label, channel) => {
    const confirm = vi.fn().mockResolvedValue(undefined);
    render(<OrderCancellationModal isOpen orderCount={1} manualReturn={{ amountCents: 600, currency: 'EUR' }} onConfirmCancel={confirm} onClose={vi.fn()} />);
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.getByText(key('confirm'))).toBeDisabled();
    expect(screen.getByText(key('cashDrawer'))).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByText(key('bank'))).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(screen.getByText(key(label)));
    expect(screen.getByText(key('confirm'))).toBeDisabled();
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Customer changed mind' } });
    fireEvent.click(screen.getByText(key('confirm')));
    await waitFor(() => expect(confirm).toHaveBeenCalledExactlyOnceWith('Customer changed mind', channel));
  });
  it('resumes the original confirmed return without another physical-return prompt', async () => {
    const confirm = vi.fn().mockResolvedValue(undefined);
    render(<OrderCancellationModal isOpen orderCount={1} manualReturn={{ amountCents: 600, currency: 'EUR' }}
      recovery={{ reason: 'Original reason', returnChannel: 'bank' }} onConfirmCancel={confirm} onClose={vi.fn()} />);
    expect(screen.queryByText(key('returnChannel'))).toBeNull();
    expect(screen.getByRole('textbox')).toHaveValue('Original reason');
    expect(screen.getByRole('textbox')).toHaveAttribute('readonly');
    fireEvent.click(screen.getByText(key('confirm')));
    await waitFor(() => expect(confirm).toHaveBeenCalledExactlyOnceWith('Original reason', 'bank'));
  });
  it('unpaid cancellation asks only for a reason', async () => {
    const confirm = vi.fn().mockResolvedValue(undefined);
    render(<OrderCancellationModal isOpen orderCount={1} onConfirmCancel={confirm} onClose={vi.fn()} />);
    expect(screen.queryByText(key('returnChannel'))).toBeNull();
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Mistake' } });
    fireEvent.click(screen.getByText(key('confirm')));
    await waitFor(() => expect(confirm).toHaveBeenCalledExactlyOnceWith('Mistake', undefined));
  });
  it('keeps the official platform reason code in a platform cancellation', async () => {
    const confirm = vi.fn().mockResolvedValue(undefined);
    render(<OrderCancellationModal isOpen orderCount={1} platformOrder onConfirmCancel={confirm} onClose={vi.fn()} />);
    expect(screen.getByText(key('confirm'))).toBeDisabled();
    fireEvent.click(screen.getByText(key('platformReasons.closed')));
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Closed early' } });
    fireEvent.click(screen.getByText(key('confirm')));
    await waitFor(() => expect(confirm).toHaveBeenCalledExactlyOnceWith('CLOSED — Closed early', undefined));
  });
  it('does not submit twice and preserves channel/reason while a failed attempt stays open', async () => {
    let finish!: () => void;
    const confirm = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
    const close = vi.fn();
    render(<OrderCancellationModal isOpen orderCount={1} manualReturn={{ amountCents: 600, currency: 'EUR' }} onConfirmCancel={confirm} onClose={close} />);
    fireEvent.click(screen.getByText(key('bank')));
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Mistake' } });
    fireEvent.click(screen.getByText(key('confirm')));
    fireEvent.click(screen.getByText(key('confirm')));
    fireEvent.click(screen.getByText(key('keepOrder')));
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(close).not.toHaveBeenCalled();
    finish();
    await waitFor(() => expect(screen.getByText(key('confirm'))).toBeEnabled());
    expect(screen.getByRole('textbox')).toHaveValue('Mistake');
    expect(screen.getByText(key('bank'))).toHaveAttribute('aria-pressed', 'true');
  });
});

// Review 06/10/2026: a table cancellation the server refused is never sent
// again; a manager clears it before the order is cancelled again.
describe('saved table cancellation attempt', () => {
  it('a refused attempt cannot be resubmitted and offers only the manager clear', async () => {
    const confirm = vi.fn();
    const release = vi.fn().mockResolvedValue(undefined);
    render(<OrderCancellationModal isOpen orderCount={1} manualReturn={{ amountCents: 600, currency: 'EUR' }}
      recovery={{ reason: 'Original reason', returnChannel: 'bank' }}
      savedAttempt={{ refused: true, onRelease: release }} onConfirmCancel={confirm} onClose={vi.fn()} />);
    expect(screen.getByRole('alert').textContent).toContain(key('refusedAttemptNotice'));
    expect(screen.getByText(key('confirm'))).toBeDisabled();
    expect(screen.queryByRole('textbox')).toBeNull();
    fireEvent.click(screen.getByText(key('clearRefusedAttempt')));
    await waitFor(() => expect(release).toHaveBeenCalledTimes(1));
    expect(confirm).not.toHaveBeenCalled();
  });
  it('a pending attempt still resumes as saved and can also be cleared', async () => {
    const confirm = vi.fn().mockResolvedValue(undefined);
    render(<OrderCancellationModal isOpen orderCount={1} manualReturn={{ amountCents: 600, currency: 'EUR' }}
      recovery={{ reason: 'Original reason', returnChannel: 'cash_drawer' }}
      savedAttempt={{ refused: false, onRelease: vi.fn() }} onConfirmCancel={confirm} onClose={vi.fn()} />);
    expect(screen.getByRole('status').textContent).toContain(key('pendingAttemptNotice'));
    expect(screen.getByText(key('clearRefusedAttempt'))).toBeEnabled();
    fireEvent.click(screen.getByText(key('confirm')));
    await waitFor(() => expect(confirm).toHaveBeenCalledExactlyOnceWith('Original reason', 'cash_drawer'));
  });
});
