import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import NavigationSidebar from '../NavigationSidebar';
import { CashierGateContext, CashierWaiterContext } from '../../contexts/cashier-gate-context';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('../../contexts/theme-context', () => ({ useTheme: () => ({ resolvedTheme: 'light' }) }));
vi.mock('../../contexts/shift-context', () => ({ useShift: () => ({ staff: null, isShiftActive: false }) }));
vi.mock('../../contexts/module-context', () => ({ useModules: () => ({
  isLoading: false, navigationModules: [{ module: { id: 'orders', name: 'Orders', icon: 'ClipboardList', category: 'core' }, isLocked: false }],
}) }));
vi.mock('../../hooks/useEfoodPartner', () => ({ useEfoodPartner: () => ({ available: false }) }));
vi.mock('../modals/UpgradePromptModal', () => ({ default: () => null }));
afterEach(cleanup);

describe('real sidebar cashier-day admission', () => {
  it.each([false, true])('uses the main day while preserving waiter personal check-in (waiter=%s)', waiter => {
    const onViewChange = vi.fn();
    const onStartShift = vi.fn();
    render(<CashierWaiterContext.Provider value={waiter}>
      <CashierGateContext.Provider value={false}>
        <NavigationSidebar currentView="dashboard" onViewChange={onViewChange} onLogout={() => {}} onStartShift={onStartShift} />
      </CashierGateContext.Provider>
    </CashierWaiterContext.Provider>);
    fireEvent.click(screen.getByRole('button', { name: 'navigation.menu.orders' }));
    if (waiter) {
      expect(onStartShift).toHaveBeenCalledOnce();
      expect(onViewChange).not.toHaveBeenCalled();
    } else {
      expect(onViewChange).toHaveBeenCalledWith('orders');
      expect(onStartShift).not.toHaveBeenCalled();
    }
  });

  it('opens Z for the verified main day without triggering a duplicate personal check-in', () => {
    const onStartShift = vi.fn();
    const onOpenZReport = vi.fn();
    render(<CashierGateContext.Provider value={false}>
      <NavigationSidebar currentView="dashboard" onViewChange={() => {}} onLogout={() => {}} onStartShift={onStartShift} onOpenZReport={onOpenZReport} />
    </CashierGateContext.Provider>);
    fireEvent.click(screen.getByRole('button', { name: 'navigation.zReport' }));
    expect(onOpenZReport).toHaveBeenCalledOnce();
    expect(onStartShift).not.toHaveBeenCalled();
  });
});
