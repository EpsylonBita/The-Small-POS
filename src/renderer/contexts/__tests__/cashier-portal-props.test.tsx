import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { CashierGateContext, CashierRecovery, useCashierPortalProps } from '../cashier-gate-context';

afterEach(cleanup);
function Portal() {
  return <div data-testid="portal" {...useCashierPortalProps()}><input defaultValue="retained" /></div>;
}
it('hides locked operational portals but keeps them visible when unlocked or in recovery', () => {
  const { rerender } = render(<CashierGateContext.Provider value={true}><Portal /></CashierGateContext.Provider>);
  const portal = screen.getByTestId('portal');
  expect(portal).toHaveAttribute('inert');
  expect(portal).toHaveAttribute('aria-hidden', 'true');
  expect(portal).not.toBeVisible();
  rerender(<CashierGateContext.Provider value={false}><Portal /></CashierGateContext.Provider>);
  expect(screen.getByTestId('portal')).toBe(portal);
  expect(portal).toBeVisible();
  expect(portal).not.toHaveAttribute('inert');
  expect(portal).not.toHaveAttribute('aria-hidden');
  rerender(<CashierGateContext.Provider value={true}><CashierRecovery><Portal /></CashierRecovery></CashierGateContext.Provider>);
  expect(screen.getByTestId('portal')).toBeVisible();
  expect(screen.getByTestId('portal')).not.toHaveAttribute('inert');
  expect(screen.getByTestId('portal')).not.toHaveAttribute('aria-hidden');
});
