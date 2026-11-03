import React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { PaymentDialog } from '../PaymentDialog';

const mocks = vi.hoisted(() => ({ ipc: vi.fn() }));
vi.mock('../../../../lib/ipc-adapter', () => ({ supportIpc: mocks.ipc }));
vi.mock('react-i18next', async importOriginal => ({
  ...await importOriginal<typeof import('react-i18next')>(),
  useTranslation: () => ({ t: (key: string, fallback?: string) => fallback ?? key }),
}));
beforeEach(() => { vi.useFakeTimers(); mocks.ipc.mockReset().mockResolvedValue({}); });
afterEach(() => { cleanup(); vi.useRealTimers(); });

it('holds the same token through terminal approval and the awaited parent save', async () => {
  let finish: () => void = () => {};
  const onComplete = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
  const processPayment = vi.fn().mockResolvedValue({ transactionId: 'your_transaction', status: 'approved' });
  const view = render(<PaymentDialog isOpen amount={1300} currency="EUR" processPayment={processPayment} onComplete={onComplete} onClose={vi.fn()} onCancel={vi.fn()} />);
  const token = mocks.ipc.mock.calls[0][1].token;
  expect(mocks.ipc).toHaveBeenCalledWith('support_payment_open', { token });
  expect(processPayment).toHaveBeenCalledOnce();
  await act(async () => {});
  expect(mocks.ipc).not.toHaveBeenCalledWith('support_payment_closed', { token });
  await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
  expect(onComplete).toHaveBeenCalledOnce();
  expect(mocks.ipc).not.toHaveBeenCalledWith('support_payment_closed', { token });
  await act(async () => { finish(); });
  expect(mocks.ipc).toHaveBeenCalledWith('support_payment_closed', { token });
  view.unmount();
});

it('closes an error token, uses a fresh token on retry and cleans up when cancelled/unmounted', async () => {
  const processPayment = vi.fn().mockRejectedValueOnce(new Error('DECLINED')).mockImplementation(() => new Promise(() => {}));
  const onClose = vi.fn(); const onCancel = vi.fn();
  const view = render(<PaymentDialog isOpen amount={1300} currency="EUR" processPayment={processPayment} onComplete={vi.fn()} onClose={onClose} onCancel={onCancel} />);
  const first = mocks.ipc.mock.calls[0][1].token;
  await act(async () => {});
  expect(mocks.ipc).toHaveBeenCalledWith('support_payment_closed', { token: first });
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
  const opens = mocks.ipc.mock.calls.filter(([command]) => command === 'support_payment_open');
  const retry = opens[opens.length - 1]?.[1].token;
  expect(retry).not.toBe(first);
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  expect(mocks.ipc).toHaveBeenCalledWith('support_payment_closed', { token: retry });
  expect(onClose).toHaveBeenCalledOnce(); expect(onCancel).toHaveBeenCalledOnce();
  view.unmount();
});

it('starts the terminal operation even if support never responds', async () => {
  mocks.ipc.mockImplementation(() => new Promise(() => {}));
  const processPayment = vi.fn().mockResolvedValue({ transactionId: 'your_transaction', status: 'declined' });
  render(<PaymentDialog isOpen amount={1300} currency="EUR" processPayment={processPayment} onComplete={vi.fn()} onClose={vi.fn()} onCancel={vi.fn()} />);
  expect(processPayment).toHaveBeenCalledOnce();
  await act(async () => {});
  expect(screen.getByRole('button', { name: 'Retry' })).toBeEnabled();
});
