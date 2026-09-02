import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// BOX (BOX by COSMOTE food delivery) has no self-service partner portal: the
// merchant is onboarded by The Small through the web Admin Dashboard, exactly
// like efood. The till therefore never collects BOX credentials -- its card is a
// read-only status view (pending / connected / last error) with a single
// "Open Admin Dashboard" action, and it never opens the credential modal.
//
// The server marks such plugins with `read_only_admin_setup: true`; the page
// honours that flag data-driven and keeps a local id set as the fallback for
// older servers that do not send it yet.

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

type RemoteItem = Record<string, unknown>

const boxItem = (overrides: RemoteItem = {}): RemoteItem => ({
  plugin_id: 'box',
  provider: 'box',
  name: 'BOX',
  category: 'delivery',
  is_purchased: true,
  status: 'pending',
  requires_partner_credentials: false,
  read_only_admin_setup: true,
  last_error: null,
  ...overrides,
})

const ADMIN_BOX_URL =
  'https://admin.example/plugins?plugin=box&branch_id=branch-1&organization_id=org-1'

// The page header repeats "Connected"/"Pending" in its stats tiles, so status
// text is asserted inside the card's info block (the heading's parent).
const cardInfo = (name: string) => {
  const heading = screen.getByRole('heading', { name })
  return within(heading.parentElement as HTMLElement)
}

const expectNoCredentialSurface = () => {
  expect(screen.queryByRole('switch')).not.toBeInTheDocument()
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  expect(screen.queryByLabelText('API Key')).not.toBeInTheDocument()
  expect(screen.queryByLabelText('API Secret')).not.toBeInTheDocument()
  expect(screen.queryByText('Partner credentials required')).not.toBeInTheDocument()
}

describe('BOX card is Admin-Dashboard-managed on the till', () => {
  beforeEach(() => {
    localStorage.clear()
    localStorage.setItem('admin_dashboard_url', 'https://admin.example/')
    mocks.openExternalUrl.mockReset()
    mocks.openExternalUrl.mockResolvedValue(true)
    mocks.posApiPost.mockReset()
    mocks.posApiGet.mockReset()
  })

  // RTL auto-cleanup is off in this vitest setup: unmount explicitly so the
  // previous render's cards never leak into the next assertion.
  afterEach(() => {
    cleanup()
  })

  const serve = (items: RemoteItem[]) => {
    mocks.posApiGet.mockResolvedValue({
      success: true,
      data: { integrations: items },
    })
  }

  it('routes a pending BOX card to the Admin Dashboard and never opens the credential modal', async () => {
    serve([boxItem()])
    render(<IntegrationsPage />)

    await screen.findByText('BOX')
    const card = cardInfo('BOX')
    expect(card.getByText('Pending')).toBeInTheDocument()
    expect(
      card.getByText(
        'Set up in the Admin Dashboard. The connection becomes active with the first order received.',
      ),
    ).toBeInTheDocument()
    expectNoCredentialSurface()

    fireEvent.click(screen.getByRole('button', { name: 'Open Admin Dashboard' }))

    await waitFor(() => {
      expect(mocks.openExternalUrl).toHaveBeenCalledWith(ADMIN_BOX_URL)
    })
    expectNoCredentialSurface()
    expect(mocks.posApiPost).not.toHaveBeenCalled()
  })

  it('shows connected state plus the server-reported last error read-only', async () => {
    serve([boxItem({ status: 'connected', last_error: 'Webhook signature mismatch' })])
    render(<IntegrationsPage />)

    await screen.findByText('BOX')
    const card = cardInfo('BOX')
    expect(card.getByText('Connected')).toBeInTheDocument()
    expect(card.getByText('Last error: Webhook signature mismatch')).toBeInTheDocument()
    expectNoCredentialSurface()
    expect(screen.getByRole('button', { name: 'Open Admin Dashboard' })).toBeInTheDocument()
  })

  it('still treats BOX as admin-managed when an older server omits read_only_admin_setup', async () => {
    // Stale catalog metadata may even claim partner credentials: the admin
    // affordance must win over the amber lock.
    serve([
      boxItem({
        read_only_admin_setup: undefined,
        requires_partner_credentials: true,
        status: 'inactive',
      }),
    ])
    render(<IntegrationsPage />)

    await screen.findByText('BOX')
    expectNoCredentialSurface()
    fireEvent.click(screen.getByRole('button', { name: 'Open Admin Dashboard' }))
    await waitFor(() => {
      expect(mocks.openExternalUrl).toHaveBeenCalledWith(ADMIN_BOX_URL)
    })
  })

  it('honours read_only_admin_setup from the server for any plugin (data-driven, not id-listed)', async () => {
    serve([
      {
        plugin_id: 'wolt',
        provider: 'wolt',
        name: 'Wolt',
        category: 'delivery',
        is_purchased: true,
        status: 'connected',
        read_only_admin_setup: true,
      },
    ])
    render(<IntegrationsPage />)

    await screen.findByText('Wolt')
    expect(screen.queryByRole('switch')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Open Admin Dashboard' }))
    await waitFor(() => {
      expect(mocks.openExternalUrl).toHaveBeenCalledWith(
        'https://admin.example/plugins?plugin=wolt&branch_id=branch-1&organization_id=org-1',
      )
    })
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('keeps the credential toggle for a plugin the server does not mark admin-managed', async () => {
    serve([
      {
        plugin_id: 'glovo',
        provider: 'glovo',
        name: 'Glovo',
        category: 'delivery',
        is_purchased: true,
        status: 'inactive',
        read_only_admin_setup: false,
      },
    ])
    render(<IntegrationsPage />)

    await screen.findByText('Glovo')
    expect(screen.getByRole('switch')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Open Admin Dashboard' })).not.toBeInTheDocument()
  })
})
