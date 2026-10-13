import React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GlobalCashierGate } from '../GlobalCashierGate';

// Founder rule R6 (13/10/2026, Tomikro desktop 1.4.127): pressing Z with no
// cashier on shift opened the check-in instead of the Z, a cashier checked in
// at 03:45 and that shift survived the Z. The sidebar Z must open a Z modal
// that is usable — the gate's recovery modal while the cashier day is locked
// (the layout's own modal is fenced and hidden then), the layout's otherwise —
// and never the check-in.

const model = vi.hoisted(() => ({
  blocked: true,
  pendingZ: false,
  zAction: vi.fn(),
}));

vi.mock('react-i18next', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-i18next')>()),
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('framer-motion', () => ({
  AnimatePresence: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock('../dashboards/BusinessCategoryDashboard', () => ({
  BusinessCategoryDashboard: () => <div>Dashboard</div>,
}));
vi.mock('../../contexts/navigation-context', () => ({
  NavigationProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock('../NavigationSidebar', () => ({
  default: ({ onOpenZReport }: { onOpenZReport?: () => void }) => (
    <button type="button" onClick={onOpenZReport}>navigation.zReport</button>
  ),
}));
vi.mock('../ThemeSwitcher', () => ({ ThemeSwitcher: () => null }));
vi.mock('../ui/ContentContainer', () => ({
  default: ({ children }: { children: React.ReactNode }) => <main>{children}</main>,
}));
vi.mock('../ui/PageLoadMotion', () => ({
  default: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock('../../contexts/theme-context', () => ({ useTheme: () => ({ resolvedTheme: 'light' }) }));
vi.mock('../../contexts/i18n-context', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('../../contexts/shift-context', () => ({
  useShift: () => ({ staff: { branchId: 'branch-1' }, activeShift: null, isShiftActive: false }),
}));
vi.mock('../../contexts/module-context', () => ({
  getModuleAccessStatic: () => ({ isLocked: false }),
  useModuleAccess: () => ({ isLocked: false, requiredPlan: undefined }),
  useModules: () => ({ enabledModules: [], isModuleEnabled: () => false, lockedModules: [] }),
}));
vi.mock('../../utils/module-view-access', () => ({ isViewAccessDenied: () => false }));
vi.mock('../../hooks/useCashierDayGate', () => ({
  useCashierDayGate: () => ({ isBlocked: model.blocked, isResolving: false, branchId: 'branch-1', recheck: vi.fn() }),
}));
vi.mock('../../hooks/useFeatures', () => ({ useFeatures: () => ({ isMobileWaiter: false, loading: false }) }));
vi.mock('../../hooks/useEndOfDayStatus', () => ({
  useEndOfDayStatus: () => ({ endOfDayStatus: {}, isPendingLocalSubmit: model.pendingZ }),
}));
vi.mock('../../hooks/useBlockerRegistration', () => ({ useBlockerRegistration: () => undefined }));
vi.mock('../../hooks/useEfoodPartner', () => ({
  useEfoodPartner: () => ({ available: false, settings: { muted: false } }),
}));
vi.mock('../ShiftManager', async () => {
  const React = await import('react');
  const { LiquidGlassModal } = await import('../ui/pos-glass-components');
  return {
    ShiftManager: React.forwardRef((_props, ref) => {
      const [open, setOpen] = React.useState(false);
      React.useImperativeHandle(ref, () => ({ openCheckin: () => setOpen(true), openCheckout: () => {} }));
      return <LiquidGlassModal isOpen={open} onClose={() => setOpen(false)} title="cashier check-in"><input aria-label="cashier PIN" /></LiquidGlassModal>;
    }),
  };
});
vi.mock('../modals/ZReportModal', async () => {
  const { LiquidGlassModal } = await import('../ui/pos-glass-components');
  return {
    default: ({ isOpen, onClose }: { isOpen: boolean; onClose: () => void }) => isOpen
      ? <LiquidGlassModal isOpen onClose={onClose} title="Z report"><button onClick={model.zAction}>run Z</button></LiquidGlassModal>
      : null,
  };
});
vi.mock('../modals/UpgradePromptModal', () => ({ default: () => null }));
vi.mock('../modals/ExpenseModal', () => ({ ExpenseModal: () => null }));
vi.mock('../../pages/MenuManagementPage', () => ({ default: () => null }));
vi.mock('../../pages/UsersPage', () => ({ default: () => null }));
vi.mock('../../pages/ReportsPage', () => ({ default: () => null }));
vi.mock('../../pages/AnalyticsPage', () => ({ default: () => null }));
vi.mock('../../pages/OrdersPage', () => ({ default: () => null }));
vi.mock('../../pages/DeliveryZonesPage', () => ({ default: () => null }));
vi.mock('../../pages/CouponsPage', () => ({ default: () => null }));
vi.mock('../../pages/LoyaltyPage', () => ({ default: () => null }));
vi.mock('../../pages/GiftCardsPage', () => ({ default: () => null }));
vi.mock('../../pages/SuppliersPage', () => ({ default: () => null }));
vi.mock('../../pages/InventoryPage', () => ({ default: () => null }));
vi.mock('../../pages/KitchenDisplayPage', () => ({ default: () => null }));
vi.mock('../../pages/CustomerDisplayPage', () => ({ default: () => null }));
vi.mock('../../pages/KioskManagementPage', () => ({ default: () => null }));
vi.mock('../../pages/IntegrationsPage', () => ({ default: () => null }));
vi.mock('../../../lib', () => ({
  onEvent: vi.fn(),
  offEvent: vi.fn(),
  getBridge: () => ({
    sync: { getNetworkStatus: vi.fn().mockResolvedValue({ isOnline: true }) },
    branchData: { getBundleStatus: vi.fn().mockResolvedValue({ success: false }) },
  }),
}));
vi.mock('../../lib/secure-session-cache', () => ({
  clearSecureSession: vi.fn(),
  getSecureSessionSync: () => null,
}));
vi.mock('../../services/offline-page-capabilities', () => ({ getOfflinePageBanner: () => null }));

import { RefactoredMainLayout } from '../RefactoredMainLayout';

const renderRegister = () => render(
  <GlobalCashierGate onLogout={() => {}} onOpenSettings={() => {}}>
    <RefactoredMainLayout />
  </GlobalCashierGate>,
);

async function pressSidebarZ() {
  fireEvent.click(screen.getByRole('button', { name: 'navigation.zReport' }));
  await act(async () => {});
  return screen.findByRole('dialog', { name: 'Z report' });
}

beforeEach(() => {
  model.blocked = true;
  model.pendingZ = false;
  model.zAction.mockClear();
});
afterEach(() => cleanup());

describe('sidebar Z entry (founder rule R6)', () => {
  it.each([false, true])('opens a usable Z modal while the cashier day is locked, never the check-in (pending Z=%s)', async (pendingZ) => {
    model.pendingZ = pendingZ;
    renderRegister();
    expect(screen.getByRole('alert')).toHaveTextContent('cashierGate.title');

    const zDialog = await pressSidebarZ();
    expect(zDialog).toBeVisible();
    expect(zDialog.closest('[data-cashier-recovery="true"]')).not.toBeNull();
    expect(screen.getAllByRole('dialog', { name: 'Z report' })).toHaveLength(1);
    expect(screen.queryByRole('dialog', { name: 'cashier check-in' })).toBeNull();

    // The gate's event fence lets the recovery Z modal work.
    fireEvent.click(screen.getByText('run Z'));
    expect(model.zAction).toHaveBeenCalledOnce();
  });

  it('opens the layout Z modal while a cashier day is open, never the check-in', async () => {
    model.blocked = false;
    renderRegister();

    const zDialog = await pressSidebarZ();
    expect(zDialog).toBeVisible();
    expect(screen.getAllByRole('dialog', { name: 'Z report' })).toHaveLength(1);
    expect(screen.queryByRole('dialog', { name: 'cashier check-in' })).toBeNull();
    fireEvent.click(screen.getByText('run Z'));
    expect(model.zAction).toHaveBeenCalledOnce();
  });
});
