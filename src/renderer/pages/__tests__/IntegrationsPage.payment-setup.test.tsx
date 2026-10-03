import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
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


const setup = (state = 'pending_verification') => ({
  integration_mode: state === 'not_configured' ? null : 'native_tim',
  configuration_state: state,
  transport_ready: false,
  setup_href: '/dashboard/plugins',
  reason_code: state === 'not_configured' ? 'CONFIGURATION_REQUIRED'
    : state === 'partner_setup_required' ? 'TWINT_PARTNER_SETUP_REQUIRED'
    : 'WORLDLINE_TIM_VERIFICATION_REQUIRED',
})
const item = (provider: string, paymentSetup: unknown = setup()) => ({
  plugin_id: provider, provider, branch_id: 'branch-1',
  name: provider === 'twint' ? 'TWINT' : 'Worldline Terminals',
  category: 'delivery', is_purchased: true,
  // Stored generic plugin activation must never imply a verified transport.
  status: 'connected', is_active: true, is_enabled: true,
  read_only_admin_setup: false, requires_partner_credentials: true,
  payment_setup: paymentSetup,
})
const serve = (items: unknown[]) => mocks.posApiGet.mockResolvedValue({ success: true, data: { branch_id: 'branch-1', integrations: items } })
const expectReadOnly = () => {
  expect(screen.queryByRole('switch')).not.toBeInTheDocument()
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  expect(screen.queryByLabelText('API Key')).not.toBeInTheDocument()
  expect(mocks.posApiPost).not.toHaveBeenCalled()
}

describe('Payment provider onboarding stays read-only before verified transport', () => {
  beforeEach(() => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(true)
    localStorage.clear()
    localStorage.setItem('admin_dashboard_url', 'https://admin.example/')
    mocks.openExternalUrl.mockReset().mockResolvedValue(true)
    mocks.posApiPost.mockReset()
    mocks.posApiGet.mockReset()
  })
  afterEach(cleanup)

  it.each(['twint', 'worldline_terminals'])('shows %s pending with a scoped dashboard setup action', async provider => {
    serve([item(provider)])
    render(<IntegrationsPage />)
    const name = provider === 'twint' ? 'TWINT' : 'Worldline Terminals'
    const heading = await screen.findByRole('heading', { name })
    const card = within(heading.parentElement as HTMLElement)
    expect(card.getByText('Awaiting verification')).toBeInTheDocument()
    expect(card.queryByText('Connected')).not.toBeInTheDocument()
    expect(card.getByText('The configuration is saved. Payments will be available after the connection is verified.')).toBeInTheDocument()
    expect(card.queryByText('Set up in the Admin Dashboard. The connection becomes active with the first order received.')).not.toBeInTheDocument()
    expect(screen.getByText('Payment Gateways')).toBeInTheDocument()
    expectReadOnly()
    fireEvent.click(screen.getByRole('button', { name: 'Open Admin Dashboard' }))
    await waitFor(() => expect(mocks.openExternalUrl).toHaveBeenCalledWith(
      `https://admin.example/plugins?plugin=${provider}&branch_id=branch-1&organization_id=org-1`,
    ))
    expectReadOnly()
  })

  it.each(['twint', 'worldline_terminals'])('shows unconfigured %s without enabling it', async provider => {
    serve([item(provider, setup('not_configured'))])
    render(<IntegrationsPage />)
    await screen.findByText(provider === 'twint' ? 'TWINT' : 'Worldline Terminals')
    expect(screen.getAllByText('Setup required').length).toBeGreaterThan(0)
    expect(screen.getByText('Set up this payment connection in the Admin Dashboard. Payments are not available yet.')).toBeInTheDocument()
    expectReadOnly()
  })

  it('shows direct TWINT partner onboarding without generic credential form', async () => {
    serve([item('twint', { ...setup('partner_setup_required'), integration_mode: 'direct_qr' })])
    render(<IntegrationsPage />)
    await screen.findByText('TWINT')
    expect(screen.getAllByText('Partner setup required').length).toBeGreaterThan(0)
    expect(screen.getByText('Provider onboarding is required before this connection can receive payments. Continue in the Admin Dashboard.')).toBeInTheDocument()
    expectReadOnly()
  })

  it.each([
    ['missing', undefined],
    ['array', []],
    ['missing transport', { ...setup(), transport_ready: undefined }],
    ['string transport', { ...setup(), transport_ready: 'false' }],
    ['claimed ready', { ...setup(), transport_ready: true }],
    ['invalid state', { ...setup(), configuration_state: 'connected' }],
    ['invalid href', { ...setup(), setup_href: 'https://untrusted.example' }],
  ])('does not promote generic connected when readiness is %s', async (_name, paymentSetup) => {
    // Avoid the item helper's default when testing omitted readiness.
    serve([{ ...item('twint'), payment_setup: paymentSetup }])
    render(<IntegrationsPage />)
    const heading = await screen.findByRole('heading', { name: 'TWINT' })
    const card = within(heading.parentElement as HTMLElement)
    expect(card.getByText('Status unavailable')).toBeInTheDocument()
    expect(card.queryByText('Connected')).not.toBeInTheDocument()
    expect(card.getByText('Payment readiness could not be confirmed. Open the Admin Dashboard to check the setup.')).toBeInTheDocument()
    expectReadOnly()
  })

  it('hides an unpurchased payment provider', async () => {
    serve([{ ...item('twint'), is_purchased: false }])
    render(<IntegrationsPage />)
    await waitFor(() => expect(mocks.posApiGet).toHaveBeenCalled())
    expect(screen.queryByRole('heading', { name: 'TWINT' })).not.toBeInTheDocument()
  })
})
