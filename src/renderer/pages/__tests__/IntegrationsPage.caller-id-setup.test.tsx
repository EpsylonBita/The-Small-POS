import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  getSetting: vi.fn((_section: string, key: string) => {
    if (key === 'branch_id') return 'branch-1'
    if (key === 'organization_id') return 'org-1'
    return null
  }),
  openExternalUrl: vi.fn(),
  posApiGet: vi.fn(),
  posApiPost: vi.fn(),
  callerIdGetStatus: vi.fn(),
}))

// One stable component per tag. A new function on every `motion.*` access
// would be a new component type on every render, so React would remount the
// card subtree and a button a test already holds could be detached before the
// click lands (seen as a flaky openExternalUrl "0 calls" under CI load).
vi.mock('framer-motion', () => {
  const components = new Map<string, React.FC<React.HTMLAttributes<HTMLElement>>>()
  return {
    motion: new Proxy(
      {},
      {
        get: (_target, tag: string) => {
          let component = components.get(tag)
          if (!component) {
            component = ({ children, ...props }: React.HTMLAttributes<HTMLElement>) => {
              const Component = tag as keyof React.JSX.IntrinsicElements
              return <Component {...props}>{children}</Component>
            }
            components.set(tag, component)
          }
          return component
        },
      },
    ),
  }
})

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, fallback: string) => fallback,
  }),
}))

vi.mock('../../contexts/theme-context', () => ({
  useTheme: () => ({ resolvedTheme: 'light' }),
}))

vi.mock('../../utils/format', () => ({
  formatTime: (value: string) => value,
}))

vi.mock('../../hooks/useAcquiredModules', () => ({
  MODULE_IDS: {
    DELIVERY: 'delivery',
    ROOMS: 'rooms',
    PRODUCT_CATALOG: 'product_catalog',
    STAFF_SCHEDULE: 'staff_schedule',
  },
  useAcquiredModules: () => ({
    isLoading: false,
    refetch: vi.fn(),
  }),
}))

vi.mock('../../components/ui/pos-glass-components', () => ({
  LiquidGlassModal: ({
    children,
    isOpen,
    title,
  }: {
    children: React.ReactNode
    isOpen: boolean
    title: React.ReactNode
  }) => (isOpen ? <div role="dialog" aria-label={String(title)}>{children}</div> : null),
  POSGlassButton: ({
    children,
    loading: _loading,
    ...props
  }: React.ButtonHTMLAttributes<HTMLButtonElement> & { loading?: boolean }) => (
    <button {...props}>{children}</button>
  ),
  POSGlassInput: ({
    label,
    ...props
  }: React.InputHTMLAttributes<HTMLInputElement> & { label: string }) => (
    <label>
      {label}
      <input {...props} />
    </label>
  ),
}))

vi.mock('../../utils/api-helpers', () => ({
  posApiGet: mocks.posApiGet,
  posApiPost: mocks.posApiPost,
}))

vi.mock('../../utils/external-url', () => ({
  openExternalUrl: mocks.openExternalUrl,
}))

vi.mock('../../hooks/useTerminalSettings', () => ({
  useTerminalSettings: () => ({
    getSetting: mocks.getSetting,
  }),
}))

vi.mock('../../services/offline-page-capabilities', () => ({
  getOfflineActionState: () => ({ disabled: false, message: null }),
}))

vi.mock('../../utils/plugin-icons', () => ({
  getPluginLogo: () => null,
}))

vi.mock('../../components/ui/page-motion', () => ({
  pageMotionContainer: {},
  pageMotionItem: {},
}))

vi.mock('../../../lib', () => ({
  getBridge: () => ({
    ecr: {
      getDevices: vi.fn().mockResolvedValue([]),
      updateDevice: vi.fn(),
      disconnectDevice: vi.fn(),
    },
    callerid: {
      getStatus: mocks.callerIdGetStatus,
    },
  }),
}))

vi.mock('../../services/terminal-credentials', () => ({
  getCachedTerminalCredentials: () => null,
}))

import IntegrationsPage from '../IntegrationsPage'

const respondByEndpoint = (integrations: Record<string, unknown>[]) =>
  mocks.posApiGet.mockImplementation(async (endpoint: string) => {
    if (endpoint === '/api/pos/caller-id/config') {
      // This terminal has no Caller ID line.
      return { success: true, data: { enabled: true, sourceLines: [], receivingLines: [] } }
    }
    if (endpoint === '/pos/integrations') {
      return { success: true, data: { branch_id: 'branch-1', integrations } }
    }
    return { success: false, status: 404, error: 'not found' }
  })

describe('Caller ID setup entry point', () => {
  afterEach(() => {
    cleanup()
  })

  beforeEach(() => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(true)
    localStorage.clear()
    localStorage.setItem('admin_dashboard_url', 'https://admin.example/')
    mocks.openExternalUrl.mockReset()
    mocks.openExternalUrl.mockResolvedValue(true)
    mocks.posApiPost.mockReset()
    mocks.posApiGet.mockReset()
    mocks.callerIdGetStatus.mockReset()
    mocks.callerIdGetStatus.mockResolvedValue({ status: 'stopped', registered: false, callsDetected: 0 })
    respondByEndpoint([
      {
        plugin_id: 'caller_id',
        provider: 'caller_id',
        name: 'Caller ID (VoIP/SIP)',
        category: 'communications',
        is_purchased: true,
        is_enabled: true,
        status: 'inactive',
      },
    ])
  })

  // Deliberately updated (2026-09, terminal-owned Caller ID card): the "Set up"
  // label used to follow the server's billing-owned `status: 'inactive'`. It now
  // follows this terminal's own assignment — no line here → "Set up" — and the
  // generic "Off" label no longer renders on this admin-managed card.
  it('shows a read-only status with an explicit Admin setup action instead of a fake toggle or credentials', async () => {
    render(<IntegrationsPage />)

    await screen.findByText('Caller ID (VoIP/SIP)')
    expect(screen.queryByRole('switch')).not.toBeInTheDocument()
    // Wait until both terminal observations (assignment + listener) have
    // settled, then look the button up and click it in the same tick.
    await waitFor(() => {
      expect(screen.getByTestId('caller-id-card-state')).toHaveTextContent('Not assigned to this terminal')
      expect(screen.getByTestId('admin-managed-side-status')).toHaveTextContent('Not assigned')
      expect(mocks.callerIdGetStatus).toHaveBeenCalled()
    })
    fireEvent.click(screen.getByRole('button', { name: 'Set up Caller ID in Admin Dashboard' }))

    await waitFor(() => {
      expect(mocks.openExternalUrl).toHaveBeenCalledWith(
        'https://admin.example/plugins?plugin=caller_id&branch_id=branch-1&organization_id=org-1',
      )
    })
    expect(screen.queryByText('Off')).not.toBeInTheDocument()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('API Key')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('API Secret')).not.toBeInTheDocument()
  })

  it('opens the dedicated Customer Messaging workspace without exposing credentials', async () => {
    respondByEndpoint([
      {
        plugin_id: 'customer_messaging',
        provider: 'customer_messaging',
        name: 'Customer Messaging (Private Beta)',
        category: 'communications',
        is_purchased: true,
        status: 'inactive',
      },
    ])

    render(<IntegrationsPage />)

    await screen.findByText('Customer Messaging (Private Beta)')
    expect(screen.queryByRole('switch')).not.toBeInTheDocument()
    // Admin-managed card: the side label shows the resolved state, not a generic On/Off.
    await waitFor(() => expect(screen.getByTestId('admin-managed-side-status')).toHaveTextContent('Not Connected'))
    expect(screen.queryByText('Off')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Open Admin Dashboard' }))

    await waitFor(() => {
      expect(mocks.openExternalUrl).toHaveBeenCalledWith(
        'https://admin.example/plugins?workspace=customer-messaging&branch_id=branch-1&organization_id=org-1',
      )
    })
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('API Key')).not.toBeInTheDocument()
    // Caller ID is not purchased here, so its assignment is never requested.
    expect(mocks.posApiGet).not.toHaveBeenCalledWith('/api/pos/caller-id/config')
  })
})
