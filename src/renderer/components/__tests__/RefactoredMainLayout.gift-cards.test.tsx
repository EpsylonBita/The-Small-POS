import React from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { isModuleComingSoon, isModuleImplemented } from '../../../shared/constants/pos-modules'

const mocks = vi.hoisted(() => ({
  deniedViews: new Set<string>(),
}))

vi.mock('framer-motion', () => ({
  AnimatePresence: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))

vi.mock('../dashboards/BusinessCategoryDashboard', () => ({
  BusinessCategoryDashboard: () => <div>Dashboard</div>,
}))

vi.mock('../../contexts/navigation-context', () => ({
  NavigationProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))

vi.mock('../NavigationSidebar', () => ({
  default: ({ onViewChange }: { onViewChange: (view: string) => void }) => (
    <button type="button" onClick={() => onViewChange('gift_cards')}>Gift Cards</button>
  ),
}))

vi.mock('../ThemeSwitcher', () => ({
  ThemeSwitcher: () => null,
}))

vi.mock('../ui/ContentContainer', () => ({
  default: ({ children }: { children: React.ReactNode }) => <main>{children}</main>,
}))

vi.mock('../ui/PageLoadMotion', () => ({
  default: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}))

vi.mock('../../contexts/theme-context', () => ({
  useTheme: () => ({ resolvedTheme: 'light' }),
}))

vi.mock('../../contexts/i18n-context', () => ({
  useI18n: () => ({ t: (key: string) => key }),
}))

vi.mock('../../contexts/shift-context', () => ({
  useShift: () => ({ staff: null, isShiftActive: true }),
}))

vi.mock('../../contexts/module-context', () => ({
  getModuleAccessStatic: () => ({ isLocked: false }),
  useModuleAccess: () => ({ isLocked: false, requiredPlan: undefined }),
  useModules: () => ({
    enabledModules: [],
    isModuleEnabled: () => false,
    lockedModules: [],
  }),
}))

vi.mock('../../utils/module-view-access', () => ({
  isViewAccessDenied: (...args: unknown[]) =>
    args.some((arg) => typeof arg === 'string' && mocks.deniedViews.has(arg)),
}))

vi.mock('../modals/ZReportModal', () => ({ default: () => null }))
vi.mock('../modals/UpgradePromptModal', () => ({ default: () => null }))
vi.mock('../ShiftManager', () => ({
  ShiftManager: React.forwardRef(() => null),
}))
vi.mock('../../hooks/useEndOfDayStatus', () => ({
  useEndOfDayStatus: () => ({
    endOfDayStatus: {},
    isPendingLocalSubmit: false,
  }),
}))

vi.mock('../../pages/MenuManagementPage', () => ({ default: () => null }))
vi.mock('../../pages/UsersPage', () => ({ default: () => null }))
vi.mock('../../pages/ReportsPage', () => ({ default: () => null }))
vi.mock('../../pages/AnalyticsPage', () => ({ default: () => null }))
vi.mock('../../pages/OrdersPage', () => ({ default: () => null }))
vi.mock('../../pages/DeliveryZonesPage', () => ({ default: () => null }))
vi.mock('../../pages/CouponsPage', () => ({ default: () => null }))
vi.mock('../../pages/LoyaltyPage', () => ({ default: () => null }))
vi.mock('../../pages/GiftCardsPage', () => ({ default: () => <div>Gift cards management</div> }))
vi.mock('../../pages/SuppliersPage', () => ({ default: () => null }))
vi.mock('../../pages/InventoryPage', () => ({ default: () => null }))
vi.mock('../../pages/KitchenDisplayPage', () => ({ default: () => null }))
vi.mock('../../pages/CustomerDisplayPage', () => ({ default: () => null }))
vi.mock('../../pages/KioskManagementPage', () => ({ default: () => null }))
vi.mock('../../pages/IntegrationsPage', () => ({ default: () => null }))

vi.mock('../../../lib', () => ({
  onEvent: vi.fn(),
  offEvent: vi.fn(),
  getBridge: () => ({
    sync: {
      getNetworkStatus: vi.fn().mockResolvedValue({ isOnline: true }),
    },
    branchData: {
      getBundleStatus: vi.fn().mockResolvedValue({ success: false }),
    },
  }),
}))

vi.mock('../../lib/secure-session-cache', () => ({
  clearSecureSession: vi.fn(),
  getSecureSessionSync: () => null,
}))

vi.mock('../../services/offline-page-capabilities', () => ({
  getOfflinePageBanner: () => null,
}))

vi.mock('../modals/ExpenseModal', () => ({
  ExpenseModal: () => null,
}))

import { RefactoredMainLayout } from '../RefactoredMainLayout'

describe('Gift Cards view dispatch', () => {
  afterEach(() => {
    cleanup()
    mocks.deniedViews.clear()
  })

  it('registers gift_cards as an implemented module instead of coming soon', () => {
    expect(isModuleImplemented('gift_cards')).toBe(true)
    expect(isModuleComingSoon('gift_cards')).toBe(false)
  })

  it('does not open the page when module access denies the view', async () => {
    mocks.deniedViews.add('gift_cards')
    render(<RefactoredMainLayout />)

    fireEvent.click(screen.getByRole('button', { name: 'Gift Cards' }))
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    expect(screen.queryByText('Gift cards management')).not.toBeInTheDocument()
    expect(screen.getByText('Dashboard')).toBeInTheDocument()
  })

  it('dispatches the gift_cards view to GiftCardsPage', async () => {
    render(<RefactoredMainLayout />)

    fireEvent.click(screen.getByRole('button', { name: 'Gift Cards' }))

    expect(await screen.findByText('Gift cards management')).toBeInTheDocument()
    expect(screen.queryByText('Module Not Available')).not.toBeInTheDocument()
  })
})
