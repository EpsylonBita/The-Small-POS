import React from 'react'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  integrationMounts: 0,
  integrationUnmounts: 0,
}))

vi.mock('framer-motion', () => ({
  AnimatePresence: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))

vi.mock('../dashboards', () => ({
  BusinessCategoryDashboard: () => <div>Dashboard</div>,
}))

vi.mock('../../contexts/navigation-context', () => ({
  NavigationProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))

vi.mock('../NavigationSidebar', () => ({
  default: ({ onViewChange }: { onViewChange: (view: string) => void }) => (
    <button type="button" onClick={() => onViewChange('plugin_integrations')}>
      Plugins
    </button>
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

vi.mock('../../contexts/shift-context', () => ({
  useShift: () => ({ staff: null, isShiftActive: true }),
}))

vi.mock('../../contexts/module-context', () => ({
  getModuleAccessStatic: () => ({ isLocked: false }),
  useModuleAccess: () => ({ isLocked: false, requiredPlan: undefined }),
  useModules: () => ({
    enabledModules: [],
    lockedModules: [],
  }),
}))

vi.mock('../../utils/module-view-access', () => ({
  isViewAccessDenied: () => false,
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
vi.mock('../../pages/SuppliersPage', () => ({ default: () => null }))
vi.mock('../../pages/InventoryPage', () => ({ default: () => null }))
vi.mock('../../pages/KitchenDisplayPage', () => ({ default: () => null }))
vi.mock('../../pages/CustomerDisplayPage', () => ({ default: () => null }))
vi.mock('../../pages/KioskManagementPage', () => ({ default: () => null }))

vi.mock('../../pages/IntegrationsPage', () => ({
  default: () => {
    React.useEffect(() => {
      mocks.integrationMounts += 1
      return () => {
        mocks.integrationUnmounts += 1
      }
    }, [])
    return <div>Integrations stateful view</div>
  },
}))

vi.mock('../../../lib', () => ({
  getBridge: () => ({
    branchData: {
      getBundleStatus: vi.fn().mockResolvedValue({ success: false }),
    },
  }),
}))

vi.mock('../../lib/secure-session-cache', () => ({
  clearSecureSession: vi.fn(),
}))

vi.mock('../../services/offline-page-capabilities', () => ({
  getOfflinePageBanner: () => null,
}))

vi.mock('../modals/ExpenseModal', () => ({
  ExpenseModal: () => null,
}))

import { RefactoredMainLayout } from '../RefactoredMainLayout'

describe('Integrations view stability', () => {
  beforeEach(() => {
    mocks.integrationMounts = 0
    mocks.integrationUnmounts = 0
  })

  it('preserves the mounted Integrations page across unrelated parent renders', async () => {
    const view = render(<RefactoredMainLayout className="before-sync" />)

    fireEvent.click(screen.getByRole('button', { name: 'Plugins' }))
    await screen.findByText('Integrations stateful view')
    expect(mocks.integrationMounts).toBe(1)
    expect(mocks.integrationUnmounts).toBe(0)

    view.rerender(<RefactoredMainLayout className="after-background-sync" />)

    await waitFor(() => {
      expect(mocks.integrationMounts).toBe(1)
      expect(mocks.integrationUnmounts).toBe(0)
    })
  })
})
