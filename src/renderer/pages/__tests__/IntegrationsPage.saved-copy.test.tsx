import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Desktop 1.4.124 (fix 8). Symptom: with the office unreachable, the
// Integrations page showed the plugin list this till had saved as if it were
// current — a Wolt licence that had lapsed still said "Connected", and a
// manual refresh answered "Plugins refreshed". Root cause: the bridge's
// saved-copy marker was dropped by posApiFetch, so the page could not tell.
// A saved copy is now shown as that copy: an amber banner with the time it was
// saved, every card's status unknown (no switch, no payment-readiness or
// myDATA claim), and no "refreshed" toast.

const mocks = vi.hoisted(() => ({
  getSetting: vi.fn((_section: string, key: string) => {
    if (key === 'branch_id') return 'branch-1'
    if (key === 'organization_id') return 'org-1'
    return null
  }),
  posApiGet: vi.fn(),
  posApiPost: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
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
    t: (_key: string, fallback: string, options?: Record<string, unknown>) =>
      typeof fallback === 'string'
        ? fallback.replace(/\{\{(\w+)\}\}/g, (_match, name: string) => String(options?.[name] ?? ''))
        : _key,
  }),
}))

vi.mock('react-hot-toast', () => ({
  toast: Object.assign(vi.fn(), { success: mocks.toastSuccess, error: mocks.toastError }),
}))

vi.mock('../../contexts/theme-context', () => ({
  useTheme: () => ({ resolvedTheme: 'light' }),
}))

vi.mock('../../utils/format', () => ({
  formatTime: (value: Date | string) => new Date(value).toISOString(),
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
  LiquidGlassModal: ({ children, isOpen, title }: { children: React.ReactNode; isOpen: boolean; title: React.ReactNode }) =>
    (isOpen ? <div role="dialog" aria-label={String(title)}>{children}</div> : null),
  POSGlassButton: ({ children, loading: _loading, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { loading?: boolean }) => (
    <button {...props}>{children}</button>
  ),
  POSGlassInput: ({ label, ...props }: React.InputHTMLAttributes<HTMLInputElement> & { label: string }) => (
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
  openExternalUrl: vi.fn(),
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

// Synthetic data only.
const SAVED_AT = '2026-10-05T09:30:00.000Z'
const items = [
  {
    plugin_id: 'wolt', provider: 'wolt', name: 'Wolt', category: 'delivery', branch_id: 'branch-1',
    is_purchased: true, is_enabled: true, status: 'connected', read_only_admin_setup: true,
  },
  {
    plugin_id: 'google_analytics', provider: 'google_analytics', name: 'Google Analytics', branch_id: 'branch-1',
    is_purchased: true, is_active: true, is_enabled: true, status: 'connected', requires_partner_credentials: false,
  },
  {
    plugin_id: 'worldline_terminals', provider: 'worldline_terminals', name: 'Worldline', branch_id: 'branch-1',
    is_purchased: true, is_enabled: true, status: 'connected',
    payment_setup: {
      transport_ready: false, setup_href: '/dashboard/plugins', configuration_state: 'pending_verification',
      integration_mode: 'worldline_terminal', reason_code: 'WORLDLINE_TIM_VERIFICATION_REQUIRED',
    },
  },
  {
    plugin_id: 'mydata', provider: 'mydata', name: 'myDATA', branch_id: 'branch-1',
    is_purchased: true, is_active: false, is_enabled: true, status: 'inactive',
  },
]
const list = { branch_id: 'branch-1', integrations: items }
const savedCopy = { success: true, status: 200, source: 'cache', stale: true, cachedAt: SAVED_AT, data: list }
const current = { success: true, status: 200, source: 'remote', stale: false, data: list }

const BANNER_TITLE = 'Saved copy — not up to date'
const NOT_REPORTING = 'Not set up yet — receipts are NOT being sent to AADE. Finish setup in your Admin Dashboard.'

const cardInfo = (name: string) => {
  const heading = screen.getByRole('heading', { name })
  return within(heading.parentElement as HTMLElement)
}
// The whole card row: the info block plus its actions column (the switch).
const cardRow = (name: string) => {
  const heading = screen.getByRole('heading', { name })
  return within(heading.parentElement?.parentElement as HTMLElement)
}
const statValue = (label: string) => screen.getByText(label, { selector: 'p' }).previousElementSibling?.textContent

let integrationsAnswer: unknown
beforeEach(() => {
  vi.spyOn(document, 'hasFocus').mockReturnValue(true)
  localStorage.clear()
  mocks.posApiGet.mockReset()
  mocks.posApiPost.mockReset()
  mocks.toastSuccess.mockReset()
  mocks.toastError.mockReset()
  integrationsAnswer = savedCopy
  mocks.posApiGet.mockImplementation(async (path: string) => path.includes('mydata')
    ? { success: false, status: 0, error: 'This action requires an online connection.' }
    : integrationsAnswer)
})
afterEach(() => {
  cleanup()
})

describe('Integrations page: the saved copy of the plugin list', () => {
  it('shows a saved copy as that copy, never as current', async () => {
    render(<IntegrationsPage />)

    const banner = await screen.findByTestId('integrations-saved-copy')
    expect(within(banner).getByText(BANNER_TITLE)).toBeInTheDocument()
    expect(banner).toHaveTextContent(SAVED_AT)

    for (const name of ['Wolt', 'Google Analytics', 'Worldline', 'myDATA']) {
      const card = cardInfo(name)
      expect(card.getByText('Status unknown')).toBeInTheDocument()
      expect(card.queryByText('Connected')).not.toBeInTheDocument()
      expect(card.queryByText('Not Connected')).not.toBeInTheDocument()
    }
    // No payment-readiness or myDATA reporting claim from the copy.
    expect(screen.queryByText('Awaiting verification')).not.toBeInTheDocument()
    expect(screen.queryByText(NOT_REPORTING)).not.toBeInTheDocument()
    // The switch of a till-configured plugin cannot be used on a copy.
    const toggles = screen.getAllByRole('switch')
    expect(toggles.length).toBeGreaterThan(0)
    for (const toggle of toggles) {
      expect(toggle).toBeDisabled()
      expect(toggle).toHaveAttribute('aria-checked', 'false')
    }
    expect(cardRow('Google Analytics').getByText('Unknown')).toBeInTheDocument()
    expect(statValue('Connected')).toBe('0')
  })

  it('a manual refresh that only gets the saved copy again does not say it refreshed', async () => {
    render(<IntegrationsPage />)
    await screen.findByTestId('integrations-saved-copy')

    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }))

    await waitFor(() => expect(mocks.toastError).toHaveBeenCalledWith('Failed to refresh plugins'))
    expect(mocks.toastSuccess).not.toHaveBeenCalledWith('Plugins refreshed')
    expect(screen.getByTestId('integrations-saved-copy')).toBeInTheDocument()
  })

  it('the office answer replaces the copy and its statuses come back', async () => {
    render(<IntegrationsPage />)
    await screen.findByTestId('integrations-saved-copy')

    integrationsAnswer = current
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }))

    await waitFor(() => expect(mocks.toastSuccess).toHaveBeenCalledWith('Plugins refreshed'))
    expect(screen.queryByTestId('integrations-saved-copy')).not.toBeInTheDocument()
    expect(cardInfo('Wolt').getByText('Connected')).toBeInTheDocument()
    expect(cardInfo('Google Analytics').queryByText('Status unknown')).not.toBeInTheDocument()
    expect(cardRow('Google Analytics').getByRole('switch')).not.toBeDisabled()
    expect(cardRow('Google Analytics').getByRole('switch')).toHaveAttribute('aria-checked', 'true')
    expect(cardInfo('Worldline').getByText('Awaiting verification')).toBeInTheDocument()
  })

  it('an answer without the marker is current (older bridge or browser)', async () => {
    integrationsAnswer = { success: true, data: list }
    render(<IntegrationsPage />)

    await screen.findByText('Wolt')
    expect(cardInfo('Wolt').getByText('Connected')).toBeInTheDocument()
    expect(screen.queryByTestId('integrations-saved-copy')).not.toBeInTheDocument()
  })
})
