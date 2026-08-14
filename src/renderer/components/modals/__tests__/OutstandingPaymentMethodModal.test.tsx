import React from 'react';
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

let capturedPaymentModalProps: Record<string, unknown> | null = null;

vi.mock('../PaymentModal', () => ({
  PaymentModal: (props: Record<string, unknown>) => {
    capturedPaymentModalProps = props;
    return <div data-testid="payment-modal" />;
  },
}));

import { OutstandingPaymentMethodModal } from '../OutstandingPaymentMethodModal';

describe('OutstandingPaymentMethodModal', () => {
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    capturedPaymentModalProps = null;
  });

  it('can restrict historical missing-payment repair to cash and card', () => {
    render(
      <OutstandingPaymentMethodModal
        isOpen
        amount={18.5}
        allowSplit={false}
        onClose={() => {}}
        onSelect={() => {}}
      />,
    );

    expect(capturedPaymentModalProps).not.toBeNull();
    expect(capturedPaymentModalProps?.onSplitPayment).toBeUndefined();
    expect(capturedPaymentModalProps?.allowTips).toBe(false);
  });

  it('uses a synchronous guard so a same-tick second tender cannot collect twice', async () => {
    let resolveSelection: ((value: boolean) => void) | undefined;
    const onSelect = vi.fn().mockImplementation(
      () => new Promise<boolean>((resolve) => {
        resolveSelection = resolve;
      }),
    );
    render(
      <OutstandingPaymentMethodModal
        isOpen
        amount={18.5}
        allowSplit={false}
        onClose={() => {}}
        onSelect={onSelect}
      />,
    );

    const complete = capturedPaymentModalProps?.onPaymentComplete as (
      value: { method: 'card'; amount: number; transactionId: string },
    ) => Promise<boolean>;
    const first = complete({ method: 'card', amount: 18.5, transactionId: 'CARD-attempt-1' });
    const secondPromise = complete({ method: 'card', amount: 18.5, transactionId: 'CARD-attempt-2' });
    const second = await Promise.race([
      secondPromise,
      new Promise<'blocked'>(resolve => setTimeout(() => resolve('blocked'), 25)),
    ]);

    expect(second).toBe(false);
    expect(onSelect).toHaveBeenCalledOnce();
    resolveSelection?.(true);
    await expect(first).resolves.toBe(true);
  });

  it('shares the same guard between split and cash/card selection', async () => {
    let resolveSelection: (() => void) | undefined;
    const onSelect = vi.fn().mockImplementation(
      () => new Promise<void>((resolve) => {
        resolveSelection = resolve;
      }),
    );
    render(
      <OutstandingPaymentMethodModal
        isOpen
        amount={18.5}
        onClose={() => {}}
        onSelect={onSelect}
      />,
    );

    const split = capturedPaymentModalProps?.onSplitPayment as () => void;
    const complete = capturedPaymentModalProps?.onPaymentComplete as (
      value: { method: 'cash'; amount: number; transactionId: string },
    ) => Promise<boolean>;
    split();

    await expect(complete({
      method: 'cash',
      amount: 18.5,
      transactionId: 'CASH-attempt-1',
    })).resolves.toBe(false);
    expect(onSelect).toHaveBeenCalledOnce();
    expect(onSelect).toHaveBeenCalledWith({ method: 'split', amount: 18.5 });
    resolveSelection?.();
  });

  it('rejects missing or native-invalid cash/card attempt keys before selection', async () => {
    const onSelect = vi.fn();
    render(
      <OutstandingPaymentMethodModal
        isOpen
        amount={18.5}
        allowSplit={false}
        onClose={() => {}}
        onSelect={onSelect}
      />,
    );

    const complete = capturedPaymentModalProps?.onPaymentComplete as (
      value: { method: 'card'; amount: number; transactionId?: string },
    ) => Promise<boolean>;

    await expect(complete({ method: 'card', amount: 18.5 })).resolves.toBe(false);
    await expect(complete({
      method: 'card',
      amount: 18.5,
      transactionId: 'x'.repeat(129),
    })).resolves.toBe(false);
    await expect(complete({
      method: 'card',
      amount: 18.5,
      transactionId: 'CARD key with spaces',
    })).resolves.toBe(false);

    expect(onSelect).not.toHaveBeenCalled();
  });

  it('locks the tender and retries only the retained attempt snapshot while reconciliation is unknown', async () => {
    vi.useFakeTimers();
    const onSelect = vi.fn()
      .mockResolvedValueOnce('reconciliation-pending')
      .mockResolvedValueOnce('reconciliation-pending')
      .mockResolvedValueOnce(false);
    render(
      <OutstandingPaymentMethodModal
        isOpen
        amount={18.5}
        onClose={() => {}}
        onSelect={onSelect}
      />,
    );

    const complete = capturedPaymentModalProps?.onPaymentComplete as (
      value: { method: 'card'; amount: number; transactionId: string },
    ) => Promise<boolean>;
    const split = capturedPaymentModalProps?.onSplitPayment as () => void;

    await act(async () => {
      await expect(complete({
        method: 'card',
        amount: 18.5,
        transactionId: 'CARD-stable-attempt',
      })).resolves.toBe(false);
    });

    expect(capturedPaymentModalProps?.isProcessing).toBe(true);
    split();
    expect(onSelect).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.runOnlyPendingTimersAsync();
    });
    expect(onSelect).toHaveBeenCalledTimes(2);
    expect(onSelect.mock.calls[1]?.[0]).toMatchObject({
      method: 'card',
      amount: 18.5,
      transactionId: 'CARD-stable-attempt',
      reconciliationOnly: true,
    });
    expect(capturedPaymentModalProps?.isProcessing).toBe(true);

    await act(async () => {
      await vi.runOnlyPendingTimersAsync();
    });
    expect(onSelect).toHaveBeenCalledTimes(3);
    expect(onSelect.mock.calls[2]?.[0]).toMatchObject({
      transactionId: 'CARD-stable-attempt',
      reconciliationOnly: true,
    });
    expect(capturedPaymentModalProps?.isProcessing).toBe(false);
  });
});
