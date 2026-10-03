/**
 * Terminal-owned Caller ID card on the POS plugins page.
 *
 * Incident (2026-09): the card said «Μη συνδεδεμένο» + «Ανενεργό» and 0/1
 * connected while incoming-call popups worked on the source terminal, because
 * the card read the billing-owned branch_plugin_configs status from
 * GET /pos/integrations. The card now resolves this terminal's own state from
 * /api/pos/caller-id/config (once per visit or manual refresh) and the local
 * listener status (polled over IPC).
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  getSetting: vi.fn((_section: string, key: string) => {
    if (key === 'branch_id') return 'branch-1'
    if (key === 'organization_id') return 'org-1'
    if (key === 'terminal_id') return 'terminal-1'
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
    t: (_key: string, fallback: string, options?: Record<string, unknown>) =>
      typeof fallback === 'string'
        ? fallback.replace(/\{\{(\w+)\}\}/g, (_match, name: string) => String(options?.[name] ?? ''))
        : _key,
  }),
}))

vi.mock('../../contexts/theme-context', () => ({
  useTheme: () => ({ resolvedTheme: 'light' }),
}))

vi.mock('../../utils/format', () => ({
  formatTime: () => '14:05',
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
    refetch: vi.fn().mockResolvedValue(undefined),
  }),
}))

vi.mock('../../components/ui/pos-glass-components', () => ({
  LiquidGlassModal: ({ children, isOpen }: { children: React.ReactNode; isOpen: boolean }) =>
    (isOpen ? <div role="dialog">{children}</div> : null),
  POSGlassButton: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button {...props}>{children}</button>
  ),
  POSGlassInput: (props: React.InputHTMLAttributes<HTMLInputElement>) => <input {...props} />,
}))

vi.mock('react-hot-toast', () => ({
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }),
}))

vi.mock('../../utils/api-helpers', () => ({
  posApiGet: mocks.posApiGet,
  posApiPost: mocks.posApiPost,
}))

vi.mock('../../utils/external-url', () => ({
  openExternalUrl: mocks.openExternalUrl,
}))

vi.mock('../../hooks/useTerminalSettings', () => ({
  useTerminalSettings: () => ({ getSetting: mocks.getSetting }),
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
    callerid: { getStatus: mocks.callerIdGetStatus },
  }),
}))

vi.mock('../../services/terminal-credentials', () => ({
  getCachedTerminalCredentials: () => null,
}))

import IntegrationsPage, {
  CALLER_ID_CARD_STATUS,
  buildCallerIdCardView,
  resolveCallerIdCardState,
  type CallerIdCardInput,
  type CallerIdServerHints,
} from '../IntegrationsPage'
import type { CallerIdServerConfig, CallerIdServerSourceLine, CallerIdStatus } from '../../services/CallerIdService'

// --------------------------------------------------------------------------
// Fixtures (synthetic; no customer data)
// --------------------------------------------------------------------------

const CONFIG_ENDPOINT = '/api/pos/caller-id/config'

const sourceLine: CallerIdServerSourceLine = {
  id: 'line-1',
  name: 'Shop line',
  adapterType: 'grandstream_fxo',
  sourceId: 'source-1',
  deviceProfileKey: 'grandstream_ht813_fxo',
  connectorFamily: 'analog_fxo',
  sourceChannel: 'fxo1',
  isReceivingTarget: true,
  trustedDeviceIp: '192.0.2.10',
  listenPort: 5514,
}

const sourceConfigPayload = {
  enabled: true,
  minimumClientVersion: '1.4.100',
  ipTrustSourcePolicy: 'founder_pilot',
  sourceLines: [{
    id: sourceLine.id,
    name: sourceLine.name,
    adapterType: sourceLine.adapterType,
    sourceId: sourceLine.sourceId,
    deviceProfileKey: sourceLine.deviceProfileKey,
    connectorFamily: sourceLine.connectorFamily,
    sourceChannel: sourceLine.sourceChannel,
    isReceivingTarget: true,
    config: { trustedDeviceIp: '192.0.2.10', listenPort: 5514 },
  }],
  receivingLines: [{ id: 'line-1', name: 'Shop line' }],
}
const emptyConfigPayload = { enabled: true, sourceLines: [], receivingLines: [] }
const receiverOnlyConfigPayload = { enabled: true, sourceLines: [], receivingLines: [{ id: 'line-1', name: 'Shop line' }] }

// The billing marker for caller_id is absent in production, so the server says
// 'inactive' / is_active=false even where Caller ID works.
const callerIdIntegration = (overrides: Record<string, unknown> = {}) => ({
  plugin_id: 'caller_id',
  provider: 'caller_id',
  name: 'Caller ID (VoIP/SIP)',
  category: 'communications',
  is_purchased: true,
  is_enabled: true,
  is_active: false,
  status: 'inactive',
  last_error: 'BILLING_SUBSCRIPTION_UNAVAILABLE',
  ...overrides,
})

const listening = (extra: Partial<CallerIdStatus> = {}) => ({
  status: 'listening',
  registered: false,
  callsDetected: 0,
  ...extra,
})

let configPayload: unknown = emptyConfigPayload
let configFails = false
let integrationsPayload: Record<string, unknown>[] = [callerIdIntegration()]

const configCalls = () => mocks.posApiGet.mock.calls.filter(([endpoint]) => endpoint === CONFIG_ENDPOINT).length

const renderPage = async () => {
  render(<IntegrationsPage />)
  await screen.findByText('Caller ID (VoIP/SIP)')
}

const cardState = () => screen.getByTestId('caller-id-card-state')

// --------------------------------------------------------------------------
// Pure resolver
// --------------------------------------------------------------------------

const hints = (overrides: Partial<CallerIdServerHints> = {}): CallerIdServerHints => ({
  orgEnabled: true,
  configuredLineCount: null,
  thisTerminalIsSource: null,
  ...overrides,
})

const config = (sourceLines: CallerIdServerSourceLine[], receivingLines: CallerIdServerConfig['receivingLines'] = []): CallerIdServerConfig => ({
  enabled: true,
  minimumClientVersion: '',
  ipTrustSourcePolicy: 'founder_pilot',
  sourceLines,
  receivingLines,
})

const status = (value: CallerIdStatus['status'], extra: Partial<CallerIdStatus> = {}): CallerIdStatus => ({
  status: value,
  registered: false,
  callsDetected: 0,
  ...extra,
})

const input = (overrides: Partial<CallerIdCardInput>): CallerIdCardInput => ({
  hints: hints(),
  config: { phase: 'ok', value: config([]) },
  listener: { phase: 'ok', value: status('stopped') },
  ...overrides,
})

describe('resolveCallerIdCardState', () => {
  it('listening here wins over any assignment or server status', () => {
    expect(resolveCallerIdCardState(input({ listener: { phase: 'ok', value: status('listening') } }))).toBe('listening_here')
    // Even while the assignment cannot be loaded (offline): the listener is local truth.
    expect(resolveCallerIdCardState(input({
      config: { phase: 'failed', value: null },
      listener: { phase: 'ok', value: status('listening') },
    }))).toBe('listening_here')
  })

  it('a source line without a running listener is configured but not listening', () => {
    expect(resolveCallerIdCardState(input({
      config: { phase: 'ok', value: config([sourceLine]) },
      listener: { phase: 'ok', value: status('stopped') },
    }))).toBe('configured_not_listening')
    expect(resolveCallerIdCardState(input({
      config: { phase: 'ok', value: config([sourceLine]) },
      listener: { phase: 'ok', value: status('registering') },
    }))).toBe('configured_not_listening')
  })

  it('reports a listener error for a bind failure or a real listener failure on a source terminal', () => {
    expect(resolveCallerIdCardState(input({
      config: { phase: 'failed', value: null },
      listener: { phase: 'ok', value: status('error', { reason: 'port_in_use' }) },
    }))).toBe('listener_error')
    // 401/403/426 from the native re-check stop the workers (grandstream_fxo.rs
    // configuration_error_requires_worker_shutdown); timeout and invalid_config
    // are local listener failures.
    for (const reason of ['auth_failed', 'unsupported_provider', 'timeout', 'invalid_config', 'unknown'] as const) {
      expect(resolveCallerIdCardState(input({
        config: { phase: 'ok', value: config([sourceLine]) },
        listener: { phase: 'ok', value: status('error', { reason }) },
      })), reason).toBe('listener_error')
    }
    expect(resolveCallerIdCardState(input({
      config: { phase: 'ok', value: config([sourceLine]) },
      listener: { phase: 'ok', value: status('error') },
    }))).toBe('listener_error')
  })

  it('a network failure of the server re-check on a source terminal is "not verified", not a listener error', () => {
    // The Rust side re-applies the cached lease and then reports error/network_error
    // over 'listening': the workers may still show calls.
    expect(resolveCallerIdCardState(input({
      config: { phase: 'ok', value: config([sourceLine]) },
      listener: { phase: 'ok', value: status('error', { reason: 'network_error' }) },
    }))).toBe('not_verified')
    expect(CALLER_ID_CARD_STATUS.not_verified).toBe('pending')
  })

  it('a server-check error on a terminal without a line is not a listener error', () => {
    expect(resolveCallerIdCardState(input({
      config: { phase: 'ok', value: config([]) },
      listener: { phase: 'ok', value: status('error', { reason: 'network_error' }) },
    }))).toBe('not_assigned')
  })

  it('says the line runs on another terminal for a receiver-only terminal or from the server block', () => {
    expect(resolveCallerIdCardState(input({
      config: { phase: 'ok', value: config([], [{ id: 'line-1', name: 'Shop line' }]) },
    }))).toBe('other_terminal')
    expect(resolveCallerIdCardState(input({
      hints: hints({ configuredLineCount: 1, thisTerminalIsSource: false }),
    }))).toBe('other_terminal')
    expect(resolveCallerIdCardState(input({
      hints: hints({ configuredLineCount: 1, thisTerminalIsSource: false }),
      config: { phase: 'ok', value: config([], [{ id: 'line-1', name: 'Shop line' }]) },
    }))).toBe('other_terminal')
  })

  it('a source terminal per the server block whose line /config does not project has an incomplete line setup', () => {
    // Deliberately changed (review 2026-09-29): this used to resolve to 'not_assigned'
    // with a "Set up" link, although the admin had already assigned the line.
    expect(resolveCallerIdCardState(input({
      hints: hints({ configuredLineCount: 1, thisTerminalIsSource: true }),
    }))).toBe('line_setup_incomplete')
    // The block never turns a terminal the server calls "source" into "other terminal".
    expect(resolveCallerIdCardState(input({
      hints: hints({ configuredLineCount: 1, thisTerminalIsSource: true }),
      config: { phase: 'ok', value: config([], [{ id: 'line-1', name: 'Shop line' }]) },
    }))).toBe('line_setup_incomplete')
    // A projected source line wins: the listener decides.
    expect(resolveCallerIdCardState(input({
      hints: hints({ configuredLineCount: 1, thisTerminalIsSource: true }),
      config: { phase: 'ok', value: config([sourceLine]) },
      listener: { phase: 'ok', value: status('stopped') },
    }))).toBe('configured_not_listening')
    expect(CALLER_ID_CARD_STATUS.line_setup_incomplete).toBe('pending')
  })

  it('is not assigned when this terminal has no line', () => {
    expect(resolveCallerIdCardState(input({}))).toBe('not_assigned')
    expect(resolveCallerIdCardState(input({
      hints: hints({ configuredLineCount: 0, thisTerminalIsSource: false }),
    }))).toBe('not_assigned')
  })

  it('is switched off when the organization turned Caller ID off, without needing the assignment', () => {
    // Deliberately changed (review 2026-09-29): this used to resolve to 'not_assigned'.
    expect(resolveCallerIdCardState(input({
      hints: hints({ orgEnabled: false }),
      config: { phase: 'idle', value: null },
    }))).toBe('switched_off')
    expect(resolveCallerIdCardState(input({
      hints: hints({ orgEnabled: false }),
      config: { phase: 'failed', value: null },
      listener: { phase: 'failed', value: null },
    }))).toBe('switched_off')
    // Local listener truth still wins while a cached lease keeps it running.
    expect(resolveCallerIdCardState(input({
      hints: hints({ orgEnabled: false }),
      listener: { phase: 'ok', value: status('listening') },
    }))).toBe('listening_here')
    expect(CALLER_ID_CARD_STATUS.switched_off).toBe('disconnected')
  })

  it('never claims connected or disconnected when an observation failed', () => {
    expect(resolveCallerIdCardState(input({
      config: { phase: 'failed', value: null },
      listener: { phase: 'ok', value: status('stopped') },
    }))).toBe('unknown')
    expect(resolveCallerIdCardState(input({
      config: { phase: 'ok', value: config([sourceLine]) },
      listener: { phase: 'failed', value: null },
    }))).toBe('unknown')
    expect(CALLER_ID_CARD_STATUS.unknown).toBe('unknown')
  })

  it('is checking until the first observations arrive', () => {
    expect(resolveCallerIdCardState(input({ config: { phase: 'loading', value: null } }))).toBe('checking')
    expect(resolveCallerIdCardState(input({
      config: { phase: 'ok', value: config([sourceLine]) },
      listener: { phase: 'idle', value: null },
    }))).toBe('checking')
    expect(CALLER_ID_CARD_STATUS.checking).toBe('unknown')
  })

  it('maps only listening to connected and keeps the last known state only for unknown', () => {
    expect(CALLER_ID_CARD_STATUS).toEqual({
      checking: 'unknown',
      listening_here: 'connected',
      not_verified: 'pending',
      configured_not_listening: 'pending',
      listener_error: 'pending',
      line_setup_incomplete: 'pending',
      other_terminal: 'disconnected',
      switched_off: 'disconnected',
      not_assigned: 'disconnected',
      unknown: 'unknown',
    })
    const unknownView = buildCallerIdCardView(input({ config: { phase: 'failed', value: null } }), 'listening_here')
    expect(unknownView).toMatchObject({ state: 'unknown', lastKnown: 'listening_here' })
    const freshView = buildCallerIdCardView(input({}), 'listening_here')
    expect(freshView).toMatchObject({ state: 'not_assigned', lastKnown: null })
    expect(buildCallerIdCardView(input({ config: { phase: 'ok', value: config([sourceLine]) } }), null).deviceLabel)
      .toBe('Grandstream HT813')
  })
})

// --------------------------------------------------------------------------
// Rendered card
// --------------------------------------------------------------------------

describe('Caller ID card on the plugins page', () => {
  afterEach(() => {
    cleanup()
    vi.useRealTimers()
  })

  beforeEach(() => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(true)
    localStorage.clear()
    localStorage.setItem('admin_dashboard_url', 'https://admin.example/')
    configPayload = emptyConfigPayload
    configFails = false
    integrationsPayload = [callerIdIntegration()]
    mocks.openExternalUrl.mockReset()
    mocks.openExternalUrl.mockResolvedValue(true)
    mocks.posApiPost.mockReset()
    mocks.callerIdGetStatus.mockReset()
    mocks.callerIdGetStatus.mockResolvedValue({ status: 'stopped', registered: false, callsDetected: 0 })
    mocks.posApiGet.mockReset()
    mocks.posApiGet.mockImplementation(async (endpoint: string) => {
      if (endpoint === CONFIG_ENDPOINT) {
        return configFails
          ? { success: false, status: 0, error: 'Network error' }
          : { success: true, data: configPayload }
      }
      if (endpoint === '/pos/integrations') {
        return { success: true, data: { branch_id: 'branch-1', integrations: integrationsPayload } }
      }
      return { success: false, status: 404, error: 'not found' }
    })
  })

  it('regression: shows "Active on this terminal" and counts 1/1 while the server billing status says inactive', async () => {
    configPayload = sourceConfigPayload
    mocks.callerIdGetStatus.mockResolvedValue(listening({ callsDetected: 3, lastCallAt: '2026-09-29T11:05:00Z' }))

    await renderPage()

    // Before the fix this read "0/1 connected", "Not Connected" and "Off".
    await waitFor(() => expect(screen.getByText(/\d\/1 connected/)).toHaveTextContent('1/1 connected'))
    expect(screen.queryByText('Not Connected')).not.toBeInTheDocument()
    expect(screen.queryByText('Off')).not.toBeInTheDocument()
    expect(cardState()).toHaveTextContent('Active on this terminal')
    expect(screen.getByText('Listening for calls from Grandstream HT813')).toBeInTheDocument()
    expect(screen.getByText('Last call: 14:05')).toBeInTheDocument()
    expect(screen.getByTestId('admin-managed-side-status')).toHaveTextContent('Listening')
    // The billing-owned status and its last_error never reach the card.
    expect(screen.queryByText(/BILLING_SUBSCRIPTION_UNAVAILABLE/)).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Manage Caller ID in Admin Dashboard' })).toBeInTheDocument()
    expect(screen.queryByRole('switch')).not.toBeInTheDocument()
  })

  it('without a last-call time shows the calls of this session, or none yet', async () => {
    configPayload = sourceConfigPayload
    mocks.callerIdGetStatus.mockResolvedValue(listening({ callsDetected: 0 }))

    await renderPage()

    await screen.findByText('No calls since the POS started')
    cleanup()

    mocks.callerIdGetStatus.mockResolvedValue(listening({ callsDetected: 2 }))
    await renderPage()
    await screen.findByText('Calls since the POS started: 2')
  })

  it('configured but not listening is amber, not counted, and points to the Caller ID settings', async () => {
    configPayload = sourceConfigPayload
    mocks.callerIdGetStatus.mockResolvedValue({ status: 'stopped', registered: false, callsDetected: 0 })

    await renderPage()

    await waitFor(() => expect(cardState()).toHaveTextContent('Configured — not listening'))
    expect(screen.getByTestId('caller-id-card-details')).toHaveTextContent('Check Settings → Devices → Caller ID.')
    expect(screen.getByText('0/1 connected')).toBeInTheDocument()
    expect(screen.getByTestId('admin-managed-side-status')).toHaveTextContent('Not listening')
    expect(screen.getByRole('button', { name: 'Manage Caller ID in Admin Dashboard' })).toBeInTheDocument()
  })

  it('shows a listener error with a plain reason', async () => {
    configPayload = sourceConfigPayload
    mocks.callerIdGetStatus.mockResolvedValue({
      status: 'error',
      reason: 'port_in_use',
      error: 'A Caller ID listen port is already in use',
      registered: false,
      callsDetected: 0,
    })

    await renderPage()

    await waitFor(() => expect(cardState()).toHaveTextContent('Listener error'))
    expect(screen.getByText('Another program is using the Caller ID port on this terminal.')).toBeInTheDocument()
    expect(screen.getByTestId('caller-id-card-details')).toHaveTextContent('Check Settings → Devices → Caller ID.')
    expect(screen.getByTestId('admin-managed-side-status')).toHaveTextContent('Error')
  })

  // Deliberately changed (review 2026-09-29): a network failure of the native
  // server re-check used to read "Listener error" although the cached lease can
  // keep the listener running and popups working (grandstream_fxo.rs
  // run_activation_check re-applies the lease, then reports network_error).
  it('a failed server check on a source terminal is "not verified", not a listener error', async () => {
    configPayload = sourceConfigPayload
    mocks.callerIdGetStatus.mockResolvedValue({ status: 'error', reason: 'network_error', registered: false, callsDetected: 0 })

    await renderPage()

    await waitFor(() => expect(cardState()).toHaveTextContent('Not verified with the server'))
    expect(screen.getByTestId('caller-id-card-details')).toHaveTextContent(
      'This terminal could not confirm its Caller ID setup with the server. Calls may keep appearing for a while from the last confirmed setup, and the check retries automatically.',
    )
    expect(screen.queryByText('Listener error')).not.toBeInTheDocument()
    expect(screen.getByTestId('admin-managed-side-status')).toHaveTextContent('Not verified')
    // Pending: neither connected nor disconnected.
    expect(screen.getByText('0/1 connected')).toBeInTheDocument()
    const stats = (label: string) => within(screen.getByText(label).parentElement as HTMLElement).getByText(/^\d+$/)
    expect(stats('Pending')).toHaveTextContent('1')
    expect(stats('Disconnected')).toHaveTextContent('0')
    expect(screen.getByRole('button', { name: 'Manage Caller ID in Admin Dashboard' })).toBeInTheDocument()
  })

  it('a server refusal on a source terminal is a listener error that points to the Admin Dashboard', async () => {
    configPayload = sourceConfigPayload
    mocks.callerIdGetStatus.mockResolvedValue({ status: 'error', reason: 'auth_failed', registered: false, callsDetected: 0 })

    await renderPage()

    await waitFor(() => expect(cardState()).toHaveTextContent('Listener error'))
    expect(screen.getByTestId('caller-id-card-details')).toHaveTextContent(
      'The server did not allow Caller ID on this terminal, so it stopped listening. Check Caller ID in the Admin Dashboard.',
    )
    // The fix is not in the local settings, so the card does not point there.
    expect(screen.getByTestId('caller-id-card-details')).not.toHaveTextContent('Check Settings')
  })

  it('a line the server assigns to this terminal but /config cannot run says the line setup is incomplete', async () => {
    integrationsPayload = [callerIdIntegration({
      caller_id: { status_owner: 'terminal', configured_line_count: 1, this_terminal_is_source: true, this_terminal_receives: true },
    })]

    await renderPage()

    await waitFor(() => expect(cardState()).toHaveTextContent('Phone line setup incomplete'))
    expect(screen.getByTestId('caller-id-card-details')).toHaveTextContent(
      "This terminal is the source of a phone line, but the line's setup is incomplete, so it is not listening. Check the phone line in the Admin Dashboard.",
    )
    expect(screen.getByTestId('admin-managed-side-status')).toHaveTextContent('Incomplete')
    expect(screen.getByRole('button', { name: 'Manage Caller ID in Admin Dashboard' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Set up Caller ID in Admin Dashboard' })).not.toBeInTheDocument()
  })

  it('a receiver-only terminal says Caller ID runs on another terminal', async () => {
    configPayload = receiverOnlyConfigPayload

    await renderPage()

    await waitFor(() => expect(cardState()).toHaveTextContent('Runs on another terminal'))
    expect(screen.getByText('Incoming calls are shown on the terminal the phone line is connected to.')).toBeInTheDocument()
    expect(screen.getByText('0/1 connected')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Manage Caller ID in Admin Dashboard' })).toBeInTheDocument()
  })

  it('uses the server caller_id block to say the line runs on another terminal', async () => {
    integrationsPayload = [callerIdIntegration({
      caller_id: { status_owner: 'terminal', configured_line_count: 1, this_terminal_is_source: false, this_terminal_receives: false },
    })]

    await renderPage()

    await waitFor(() => expect(cardState()).toHaveTextContent('Runs on another terminal'))
  })

  it('not assigned offers the Admin setup link', async () => {
    await renderPage()

    await waitFor(() => {
      expect(cardState()).toHaveTextContent('Not assigned to this terminal')
      expect(mocks.callerIdGetStatus).toHaveBeenCalled()
    })
    expect(screen.getByText(
      'To show incoming calls here, assign this terminal to a phone line in the Admin Dashboard.',
    )).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Set up Caller ID in Admin Dashboard' }))
    await waitFor(() => {
      expect(mocks.openExternalUrl).toHaveBeenCalledWith(
        'https://admin.example/plugins?plugin=caller_id&branch_id=branch-1&organization_id=org-1',
      )
    })
  })

  // Deliberately changed (review 2026-09-29): this used to say "Not assigned to
  // this terminal" with a "Set up" link, but /api/pos/caller-id/config requires
  // the organization switch, so assigning a line could not help.
  it('an organization with Caller ID switched off says so and never requests the assignment', async () => {
    integrationsPayload = [callerIdIntegration({ is_enabled: false })]

    await renderPage()

    await waitFor(() => expect(cardState()).toHaveTextContent('Switched off for this business'))
    expect(screen.getByTestId('caller-id-card-details')).toHaveTextContent(
      'Caller ID is switched off for this business. Turn it on in the Admin Dashboard.',
    )
    expect(screen.getByTestId('admin-managed-side-status')).toHaveTextContent('Switched off')
    expect(screen.queryByText('Not assigned to this terminal')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Set up Caller ID in Admin Dashboard' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Manage Caller ID in Admin Dashboard' })).toBeInTheDocument()
    expect(configCalls()).toBe(0)
  })

  it('unknown when the bridge and the assignment both fail: neither connected nor disconnected', async () => {
    configFails = true
    mocks.callerIdGetStatus.mockRejectedValue(new Error('bridge unavailable'))

    await renderPage()

    await waitFor(() => expect(cardState()).toHaveTextContent('Status unavailable'))
    expect(screen.getByText(
      'Could not read the Caller ID status on this terminal. Tap refresh to try again.',
    )).toBeInTheDocument()
    expect(screen.getByText('0/1 connected')).toBeInTheDocument()
    const stats = (label: string) => within(screen.getByText(label).parentElement as HTMLElement).getByText(/^\d+$/)
    expect(stats('Connected')).toHaveTextContent('0')
    expect(stats('Disconnected')).toHaveTextContent('0')
    expect(stats('Pending')).toHaveTextContent('0')
    expect(screen.getByRole('button', { name: 'Open Caller ID in Admin Dashboard' })).toBeInTheDocument()
  })

  it('keeps the last known state as stale when a refresh fails', async () => {
    configPayload = sourceConfigPayload
    mocks.callerIdGetStatus.mockResolvedValue(listening())

    await renderPage()
    await waitFor(() => expect(cardState()).toHaveTextContent('Active on this terminal'))

    mocks.callerIdGetStatus.mockRejectedValue(new Error('bridge unavailable'))
    configFails = true
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }))

    await waitFor(() => expect(cardState()).toHaveTextContent('Status unavailable'))
    expect(screen.getByText(
      'Last known: Active on this terminal. The status could not be refreshed.',
    )).toBeInTheDocument()
    expect(screen.getByText('0/1 connected')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Manage Caller ID in Admin Dashboard' })).toBeInTheDocument()
  })

  it('loads the assignment once per visit, polls only the local listener, and reloads on a manual refresh', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    configPayload = sourceConfigPayload
    mocks.callerIdGetStatus.mockResolvedValue(listening())

    await renderPage()
    await waitFor(() => expect(cardState()).toHaveTextContent('Active on this terminal'))
    expect(configCalls()).toBe(1)
    const integrationsCallsBefore = mocks.posApiGet.mock.calls.filter(([endpoint]) => endpoint === '/pos/integrations').length
    const listenerCallsBefore = mocks.callerIdGetStatus.mock.calls.length

    // Past the 30 s plugins poll and several 5 s listener polls.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(31_000)
    })

    expect(mocks.posApiGet.mock.calls.filter(([endpoint]) => endpoint === '/pos/integrations').length)
      .toBeGreaterThan(integrationsCallsBefore)
    expect(mocks.callerIdGetStatus.mock.calls.length).toBeGreaterThanOrEqual(listenerCallsBefore + 5)
    expect(configCalls()).toBe(1)

    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }))
    await waitFor(() => expect(configCalls()).toBe(2))
  })

  it('does not poll the listener when Caller ID is not purchased', async () => {
    integrationsPayload = [{
      plugin_id: 'customer_messaging',
      provider: 'customer_messaging',
      name: 'Customer Messaging (Private Beta)',
      category: 'communications',
      is_purchased: true,
      status: 'inactive',
    }]

    render(<IntegrationsPage />)
    await screen.findByText('Customer Messaging (Private Beta)')

    expect(mocks.callerIdGetStatus).not.toHaveBeenCalled()
    expect(configCalls()).toBe(0)
  })
})
