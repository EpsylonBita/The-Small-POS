import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  integrationMounts: 0,
  integrationUnmounts: 0,
  loadedPages: [] as string[],
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
    <>
      <button type="button" onClick={() => onViewChange('plugin_integrations')}>Plugins</button>
      <button type="button" onClick={() => onViewChange('customers')}>Customers</button>
      <button type="button" onClick={() => onViewChange('tables')}>Tables</button>
    </>
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
vi.mock('../../pages/UsersPage', () => {
  mocks.loadedPages.push('customers')
  return { default: () => <div>Customer directory</div> }
})
vi.mock('../../pages/ReportsPage', () => ({ default: () => null }))
vi.mock('../../pages/AnalyticsPage', () => {
  mocks.loadedPages.push('analytics')
  return { default: () => null }
})
vi.mock('../../pages/OrdersPage', () => ({ default: () => null }))
vi.mock('../../pages/DeliveryZonesPage', () => ({ default: () => null }))
vi.mock('../../pages/CouponsPage', () => ({ default: () => null }))
vi.mock('../../pages/LoyaltyPage', () => ({ default: () => null }))
vi.mock('../../pages/SuppliersPage', () => ({ default: () => null }))
vi.mock('../../pages/InventoryPage', () => ({ default: () => null }))
vi.mock('../../pages/KitchenDisplayPage', () => ({ default: () => null }))
vi.mock('../../pages/CustomerDisplayPage', () => ({ default: () => null }))
vi.mock('../../pages/KioskManagementPage', () => ({ default: () => null }))
vi.mock('../../pages/verticals/restaurant/TablesView', () => {
  mocks.loadedPages.push('tables')
  return { TablesView: () => <div>Restaurant tables</div> }
})
vi.mock('../../pages/verticals/hotel/RoomsView', () => {
  mocks.loadedPages.push('rooms')
  return { RoomsView: () => null }
})

vi.mock('../../pages/IntegrationsPage', () => {
  mocks.loadedPages.push('integrations')
  return {
    default: () => {
      React.useEffect(() => {
        mocks.integrationMounts += 1
        return () => {
          mocks.integrationUnmounts += 1
        }
      }, [])
      return <div>Integrations stateful view</div>
    },
  }
})

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

describe('Integrations view stability', () => {
  afterEach(cleanup)
  beforeEach(() => {
    mocks.integrationMounts = 0
    mocks.integrationUnmounts = 0
  })

  it('loads optional pages only on navigation and keeps customer loading inside the layout', async () => {
    render(<RefactoredMainLayout />)

    expect(mocks.loadedPages).toEqual([])
    expect(screen.getByText('Dashboard')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Customers' }))
    expect(screen.getByRole('button', { name: 'Plugins' })).toBeInTheDocument()
    await screen.findByText('Customer directory')
    expect(mocks.loadedPages).toEqual(['customers'])
    fireEvent.click(screen.getByRole('button', { name: 'Tables' }))
    await screen.findByText('Restaurant tables')
    expect(mocks.loadedPages).toEqual(['customers', 'tables'])
  })

  it('preserves the mounted Integrations page across unrelated parent renders', async () => {
    const view = render(<RefactoredMainLayout className="before-sync" />)

    fireEvent.click(screen.getByRole('button', { name: 'Plugins' }))
    const integrationView = await screen.findByText('Integrations stateful view')
    // DOM visibility can precede the lazy page's passive mount effect.
    await waitFor(() => {
      expect(mocks.integrationMounts).toBe(1)
      expect(mocks.integrationUnmounts).toBe(0)
    })

    view.rerender(<RefactoredMainLayout className="after-background-sync" />)

    expect(screen.getByText('Integrations stateful view')).toBe(integrationView)
    await waitFor(() => {
      expect(mocks.integrationMounts).toBe(1)
      expect(mocks.integrationUnmounts).toBe(0)
    })
  })
})
