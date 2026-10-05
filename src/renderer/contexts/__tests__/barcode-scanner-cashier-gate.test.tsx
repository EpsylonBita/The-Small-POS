import React from 'react';
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import BarcodeScannerContext, { useOnBarcodeScan } from '../barcode-scanner-context';
import { CashierGateContext, CashierRecovery } from '../cashier-gate-context';

afterEach(cleanup);
describe('barcode cashier gate', () => {
  it('ignores operational coupon/product scans while locked, preserves lifecycle scans, and unsubscribes', () => {
    const subscribers = new Set<(barcode: string) => void>();
    const scanner = { subscribe: (callback: (barcode: string) => void) => {
      subscribers.add(callback);
      return () => { subscribers.delete(callback); };
    } } as any;
    const sale = vi.fn();
    const recovery = vi.fn();
    function Subscriber({ callback }: { callback: (barcode: string) => void }) {
      useOnBarcodeScan(callback);
      return null;
    }
    const tree = (locked: boolean) => <BarcodeScannerContext.Provider value={scanner}>
      <CashierGateContext.Provider value={locked}>
        <Subscriber callback={sale} />
        <CashierRecovery><Subscriber callback={recovery} /></CashierRecovery>
      </CashierGateContext.Provider>
    </BarcodeScannerContext.Provider>;
    const { rerender, unmount } = render(tree(false));
    subscribers.forEach(callback => callback('first-scan'));
    expect(sale).toHaveBeenCalledOnce();
    expect(recovery).toHaveBeenCalledOnce();
    rerender(tree(true));
    subscribers.forEach(callback => callback('locked-scan'));
    expect(sale).toHaveBeenCalledOnce();
    expect(recovery).toHaveBeenLastCalledWith('locked-scan');
    expect(subscribers.size).toBe(2);
    rerender(tree(false));
    subscribers.forEach(callback => callback('replacement-cashier-scan'));
    expect(sale).toHaveBeenLastCalledWith('replacement-cashier-scan');
    unmount();
    expect(subscribers.size).toBe(0);
  });
});
