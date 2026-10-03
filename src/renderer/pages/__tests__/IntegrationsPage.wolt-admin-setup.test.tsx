import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Wolt is OAuth-onboarded through Connect Wolt in the web Admin Dashboard
// (port of #210): the merchant authorizes with the Wolt account and never types
// an API key or secret. The till therefore never collects Wolt credentials --
// its card is a read-only status view (pending / connected / last error) with a
// single "Open Admin Dashboard" action, and it never opens the credential modal.
//
// The server marks Wolt `read_only_admin_setup: true`
// (admin-dashboard/src/lib/plugins/admin-dashboard-setup-plugins.ts); the page
// honours that flag and keeps 'wolt' in its local id set as the fallback for
// older servers that still report Wolt as POS-configurable.

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

const woltItem = (overrides: RemoteItem = {}): RemoteItem => ({
  plugin_id: 'wolt',
  provider: 'wolt',
  name: 'Wolt',
  category: 'delivery',
  is_purchased: true,
  status: 'pending',
  requires_partner_credentials: false,
  read_only_admin_setup: true,
  last_error: null,
  ...overrides,
})

const WOLT_ADMIN_MANAGED_LINE =
  "Wolt is connected in the Admin Dashboard with your Wolt account; there's no API key to enter on the POS. This screen only shows its status."

const ADMIN_WOLT_URL =
  'https://admin.example/plugins?plugin=wolt&branch_id=branch-1&organization_id=org-1'

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

describe('Wolt card is Admin-Dashboard-managed on the till', () => {
  beforeEach(() => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(true)
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
      data: { branch_id: 'branch-1', integrations: items },
    })
  }

  it('routes a pending Wolt card to the Admin Dashboard and never opens the credential modal', async () => {
    serve([woltItem()])
    render(<IntegrationsPage />)

    await screen.findByText('Wolt')
    const card = cardInfo('Wolt')
    expect(card.getByText('Pending')).toBeInTheDocument()
    // Round 3 item DR7: Wolt's own wording (Android's
    // integrations.wolt.adminManagedSetup), never the generic "active with
    // the first order received" line of the other admin-managed plugins.
    expect(card.getByText(WOLT_ADMIN_MANAGED_LINE)).toBeInTheDocument()
    expect(
      card.queryByText(
        'Set up in the Admin Dashboard. The connection becomes active with the first order received.',
      ),
    ).not.toBeInTheDocument()
    expectNoCredentialSurface()

    fireEvent.click(screen.getByRole('button', { name: 'Open Admin Dashboard' }))

    await waitFor(() => {
      expect(mocks.openExternalUrl).toHaveBeenCalledWith(ADMIN_WOLT_URL)
    })
    expectNoCredentialSurface()
    expect(mocks.posApiPost).not.toHaveBeenCalled()
  })

  it('shows connected state plus the server-reported last error read-only', async () => {
    serve([woltItem({ status: 'connected', last_error: 'Wolt token rotation could not be saved' })])
    render(<IntegrationsPage />)

    await screen.findByText('Wolt')
    const card = cardInfo('Wolt')
    expect(card.getByText('Connected')).toBeInTheDocument()
    expect(card.getByText(WOLT_ADMIN_MANAGED_LINE)).toBeInTheDocument()
    expect(card.getByText('Last error: Wolt token rotation could not be saved')).toBeInTheDocument()
    expectNoCredentialSurface()
    expect(screen.getByRole('button', { name: 'Open Admin Dashboard' })).toBeInTheDocument()
  })

  it('still treats Wolt as admin-managed when an older server reports it POS-configurable', async () => {
    // A server from before Wolt joined admin-dashboard-setup-plugins sends no
    // flag (or false): the local fallback set keeps the credential form away.
    for (const readOnlyAdminSetup of [undefined, false]) {
      serve([woltItem({ read_only_admin_setup: readOnlyAdminSetup, status: 'inactive' })])
      render(<IntegrationsPage />)

      await screen.findByText('Wolt')
      expectNoCredentialSurface()
      fireEvent.click(screen.getByRole('button', { name: 'Open Admin Dashboard' }))
      await waitFor(() => {
        expect(mocks.openExternalUrl).toHaveBeenCalledWith(ADMIN_WOLT_URL)
      })
      expect(mocks.posApiPost).not.toHaveBeenCalled()
      cleanup()
      mocks.openExternalUrl.mockClear()
    }
  })
})
