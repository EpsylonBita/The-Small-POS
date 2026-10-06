import React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EditSettlementDeltaModal } from '../EditSettlementDeltaModal';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (_: string, options: any) => options?.defaultValue }) }));
vi.mock('../../../utils/format', () => ({ formatCurrency: (amount: number) => `EUR ${amount.toFixed(2)}` }));
vi.mock('../../ui/pos-glass-components', () => ({ LiquidGlassModal: ({ isOpen, children }: any) => isOpen ? <div>{children}</div> : null }));

describe('EditSettlementDeltaModal confirmation', () => {
  afterEach(cleanup);
  it('retains one chosen tender and blocks cancel while the confirmed original is saving', async () => {
    let resolve!: () => void;
    const onConfirm = vi.fn(() => new Promise<void>(done => { resolve = done; }));
    const onCancel = vi.fn();
    render(<EditSettlementDeltaModal isOpen mode="collect" amount={4.5} onConfirm={onConfirm} onCancel={onCancel} />);
    act(() => {
      fireEvent.click(screen.getByTestId('edit-settlement-delta-cash'));
      fireEvent.click(screen.getByTestId('edit-settlement-delta-card'));
      fireEvent.click(screen.getByText('Cancel'));
    });
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onConfirm).toHaveBeenCalledWith('cash');
    expect(onCancel).not.toHaveBeenCalled();
    await act(async () => resolve());
    expect(screen.getByTestId('edit-settlement-delta-card')).toBeDisabled();
  });

  it('cancels the picker before any confirmation or financial dispatch', () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    render(<EditSettlementDeltaModal isOpen mode="refund" amount={2} onConfirm={onConfirm} onCancel={onCancel} />);
    fireEvent.click(screen.getByText('Cancel'));
    expect(onCancel).toHaveBeenCalledOnce();
    expect(onConfirm).not.toHaveBeenCalled();
  });
});

describe('EditSettlementDeltaModal tender policy', () => {
  afterEach(cleanup);
  it('never offers a tender this terminal may not record', () => {
    const onConfirm = vi.fn();
    render(<EditSettlementDeltaModal isOpen mode="collect" amount={4.7} allowedMethods={['card']} onConfirm={onConfirm} onCancel={vi.fn()} />);
    expect(screen.getByTestId('edit-settlement-delta-cash')).toBeDisabled();
    expect(screen.getByTestId('edit-settlement-delta-method-policy').textContent).toContain('Cash is turned off for this terminal');
    fireEvent.click(screen.getByTestId('edit-settlement-delta-cash'));
    expect(onConfirm).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('edit-settlement-delta-card'));
    expect(onConfirm).toHaveBeenCalledWith('card');
  });

  it('keeps both tenders when no policy is known', () => {
    render(<EditSettlementDeltaModal isOpen mode="refund" amount={1} onConfirm={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.getByTestId('edit-settlement-delta-cash')).not.toBeDisabled();
    expect(screen.getByTestId('edit-settlement-delta-card')).not.toBeDisabled();
    expect(screen.queryByTestId('edit-settlement-delta-method-policy')).toBeNull();
  });
});
