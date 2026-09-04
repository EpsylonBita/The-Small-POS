import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  getSetting: vi.fn((_section: string, key: string) => {
    if (key === 'branch_id') return 'branch-1'
    if (key === 'organization_id') return 'org-1'
    return null
  }),
  openExternalUrl: vi.fn(),
  posApiGet: vi.fn(),
  posApiPost: vi.fn(),
}))

vi.mock('framer-motion', () => ({
  motion: new Proxy(
    {},
    {
      get: (_target, tag: string) =>
        ({ children, ...props }: React.HTMLAttributes<HTMLElement>) => {
          const Component = tag as keyof React.JSX.IntrinsicElements
          return <Component {...props}>{children}</Component>
        },
    },
  ),
}))

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
  }),
}))

vi.mock('../../services/terminal-credentials', () => ({
  getCachedTerminalCredentials: () => null,
}))

import IntegrationsPage from '../IntegrationsPage'

describe('Caller ID setup entry point', () => {
  beforeEach(() => {
    localStorage.clear()
    localStorage.setItem('admin_dashboard_url', 'https://admin.example/')
    mocks.openExternalUrl.mockReset()
    mocks.openExternalUrl.mockResolvedValue(true)
    mocks.posApiPost.mockReset()
    mocks.posApiGet.mockReset()
    mocks.posApiGet.mockResolvedValue({
      success: true,
      data: {
        integrations: [
          {
            plugin_id: 'caller_id',
            provider: 'caller_id',
            name: 'Caller ID (VoIP/SIP)',
            category: 'communications',
            is_purchased: true,
            status: 'inactive',
          },
        ],
      },
    })
  })

  it('shows a read-only status with an explicit Admin setup action instead of a fake toggle or credentials', async () => {
    render(<IntegrationsPage />)

    await screen.findByText('Caller ID (VoIP/SIP)')
    expect(screen.queryByRole('switch')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Set up Caller ID in Admin Dashboard' }))

    await waitFor(() => {
      expect(mocks.openExternalUrl).toHaveBeenCalledWith(
        'https://admin.example/plugins?plugin=caller_id&branch_id=branch-1&organization_id=org-1',
      )
    })
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('API Key')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('API Secret')).not.toBeInTheDocument()
  })

  it('opens the dedicated Customer Messaging workspace without exposing credentials', async () => {
    mocks.posApiGet.mockResolvedValue({
      success: true,
      data: {
        integrations: [
          {
            plugin_id: 'customer_messaging',
            provider: 'customer_messaging',
            name: 'Customer Messaging (Private Beta)',
            category: 'communications',
            is_purchased: true,
            status: 'inactive',
          },
        ],
      },
    })

    render(<IntegrationsPage />)

    await screen.findByText('Customer Messaging (Private Beta)')
    expect(screen.queryByRole('switch')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Open Admin Dashboard' }))

    await waitFor(() => {
      expect(mocks.openExternalUrl).toHaveBeenCalledWith(
        'https://admin.example/plugins?workspace=customer-messaging&branch_id=branch-1&organization_id=org-1',
      )
    })
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('API Key')).not.toBeInTheDocument()
  })
})
