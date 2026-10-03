import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Plugin licences are per branch. The server derives the branch from the
// authenticated terminal and echoes it as `branch_id`; the till shows a plugin
// only when that echo names exactly this terminal's branch and the row carries
// an explicit `is_purchased: true`. Configured/active status is never a licence,
// and a form opened for one terminal identity never submits for another.

const mocks = vi.hoisted(() => ({
  identity: {} as Record<string, string | null>,
  getSetting: vi.fn(),
  openExternalUrl: vi.fn(),
  posApiGet: vi.fn(),
  posApiPost: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
  lastSaveClick: null as null | (() => unknown),
}))

vi.mock('react-hot-toast', () => ({
  toast: Object.assign(vi.fn(), { success: mocks.toastSuccess, error: mocks.toastError }),
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
  }: React.ButtonHTMLAttributes<HTMLButtonElement> & { loading?: boolean }) => {
    // Keep the last rendered Save handler so a test can replay a click that
    // was already dispatched to the form before the identity changed.
    if (children === 'Save') mocks.lastSaveClick = props.onClick as () => unknown
    return <button {...props}>{children}</button>
  },
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

const MYDATA_MISSING = { success: false, status: 404, error: 'MyData not configured' }

const serveList = (data: Record<string, unknown>) => {
  mocks.posApiGet.mockImplementation(async (path: string) => {
    if (path === '/pos/integrations') return { success: true, data }
    if (path === '/pos/mydata/config') return MYDATA_MISSING
    return { success: true, data: {} }
  })
}

// One purchasable credential-form plugin per branch, named after its branch.
const crmFor = (branchId: string, overrides: RemoteItem = {}): RemoteItem => ({
  plugin_id: 'acme_crm',
  provider: 'acme_crm',
  name: `CRM ${branchId}`,
  category: 'other',
  is_purchased: true,
  status: 'inactive',
  read_only_admin_setup: false,
  branch_id: branchId,
  ...overrides,
})

// Serves the list of whichever branch the terminal belongs to at request time.
const serveCurrentBranch = (row: (branchId: string) => RemoteItem = crmFor, myData: unknown = MYDATA_MISSING) => {
  mocks.posApiGet.mockImplementation(async (path: string) => {
    const branchId = mocks.identity.branch_id as string
    if (path === '/pos/integrations') {
      return { success: true, data: { branch_id: branchId, integrations: [row(branchId)] } }
    }
    if (path === '/pos/mydata/config') return myData
    return { success: true, data: {} }
  })
}

const expectNothingPurchased = async () => {
  await screen.findByText('Error loading plugins')
  expect(screen.queryByRole('switch')).not.toBeInTheDocument()
  expect(screen.queryByRole('button', { name: 'Open Admin Dashboard' })).not.toBeInTheDocument()
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  expect(mocks.openExternalUrl).not.toHaveBeenCalled()
  expect(mocks.posApiPost).not.toHaveBeenCalled()
}

const switchIdentityTo = (branchId: string, rerender: (ui: React.ReactElement) => void) => {
  mocks.identity.branch_id = branchId
  rerender(<IntegrationsPage />)
}

const listRequests = () =>
  mocks.posApiGet.mock.calls.filter(([path]) => path === '/pos/integrations').length

// A connected card for each branch, and the exact request that disables it,
// for the generic plugin path and for MyData.
const DISABLE = {
  plugin: {
    row: (branchId: string) => crmFor(branchId, { status: 'connected' }),
    myData: MYDATA_MISSING,
    request: ['/pos/integrations', { plugin_id: 'acme_crm', status: 'inactive' }],
  },
  MyData: {
    row: (branchId: string): RemoteItem => ({
      plugin_id: 'mydata',
      provider: 'mydata',
      name: 'MyData',
      category: 'government',
      is_purchased: true,
      status: 'connected',
      read_only_admin_setup: false,
      branch_id: branchId,
    }),
    myData: { success: true, data: { config: { mode: 'provider', status: 'connected' }, provider_status: { is_enabled: true } } },
    request: ['/pos/mydata/config', { status: 'inactive' }],
  },
}

describe('IntegrationsPage branch-scoped plugin licences', () => {
  beforeEach(() => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(true)
    localStorage.clear()
    localStorage.setItem('admin_dashboard_url', 'https://admin.example/')
    mocks.identity = {
      organization_id: 'org-1',
      branch_id: 'branch-1',
      terminal_id: 'terminal-1',
      admin_dashboard_url: 'https://admin.example/',
    }
    mocks.getSetting.mockReset()
    mocks.getSetting.mockImplementation((_section: string, key: string) => mocks.identity[key] ?? null)
    mocks.openExternalUrl.mockReset()
    mocks.openExternalUrl.mockResolvedValue(true)
    mocks.posApiGet.mockReset()
    mocks.posApiPost.mockReset()
    mocks.toastSuccess.mockReset()
    mocks.toastError.mockReset()
    mocks.lastSaveClick = null
  })

  afterEach(() => {
    cleanup()
  })

  it('shows nothing purchased when the response names another branch', async () => {
    serveList({
      branch_id: 'branch-2',
      integrations: [
        crmFor('branch-2', { name: 'Foreign CRM', status: 'connected' }),
        { plugin_id: 'box', provider: 'box', name: 'BOX', is_purchased: true, status: 'pending', read_only_admin_setup: true, branch_id: 'branch-2' },
      ],
    })
    render(<IntegrationsPage />)

    await expectNothingPurchased()
    expect(screen.queryByText('Foreign CRM')).not.toBeInTheDocument()
    expect(screen.queryByText('BOX')).not.toBeInTheDocument()
  })

  it('rejects the whole list when one row names another branch', async () => {
    serveList({
      branch_id: 'branch-1',
      integrations: [
        crmFor('branch-1', { name: 'Own CRM' }),
        crmFor('branch-2', { plugin_id: 'glovo', provider: 'glovo', name: 'Foreign Glovo' }),
      ],
    })
    render(<IntegrationsPage />)

    await expectNothingPurchased()
    expect(screen.queryByText('Own CRM')).not.toBeInTheDocument()
    expect(screen.queryByText('Foreign Glovo')).not.toBeInTheDocument()
  })

  it('shows nothing purchased when the response omits branch_id', async () => {
    serveList({
      integrations: [crmFor('branch-1', { name: 'Unscoped CRM', branch_id: undefined, status: 'connected' })],
    })
    render(<IntegrationsPage />)

    await expectNothingPurchased()
    expect(screen.queryByText('Unscoped CRM')).not.toBeInTheDocument()
  })

  it('never counts configured, active or enabled status as a purchase', async () => {
    serveList({
      branch_id: 'branch-1',
      integrations: [
        { plugin_id: 'glovo', provider: 'glovo', name: 'Configured Glovo', status: 'connected', is_active: true, is_enabled: true, branch_id: 'branch-1' },
        { plugin_id: 'wolt', provider: 'wolt', name: 'Unpaid Wolt', is_purchased: false, status: 'connected', is_active: true, branch_id: 'branch-1' },
        crmFor('branch-1', { name: 'Licensed CRM' }),
      ],
    })
    render(<IntegrationsPage />)

    // The framer-motion mock remounts on every render, so re-query after waiting.
    await screen.findByText('Licensed CRM')
    expect(screen.getByText('Licensed CRM')).toBeInTheDocument()
    expect(screen.queryByText('Configured Glovo')).not.toBeInTheDocument()
    expect(screen.queryByText('Unpaid Wolt')).not.toBeInTheDocument()
    expect(screen.queryByText('Error loading plugins')).not.toBeInTheDocument()
  })

  it('opens the admin link for the verified branch only', async () => {
    serveList({
      branch_id: 'branch-1',
      integrations: [{ plugin_id: 'box', provider: 'box', name: 'BOX', is_purchased: true, status: 'pending', read_only_admin_setup: true }],
    })
    render(<IntegrationsPage />)

    await screen.findByText('BOX')
    fireEvent.click(screen.getByRole('button', { name: 'Open Admin Dashboard' }))
    await waitFor(() => {
      expect(mocks.openExternalUrl).toHaveBeenCalledWith(
        'https://admin.example/plugins?plugin=box&branch_id=branch-1&organization_id=org-1',
      )
    })
  })

  it('closes an open plugin form on identity change and never submits it for the new branch', async () => {
    serveCurrentBranch()
    const { rerender } = render(<IntegrationsPage />)

    await screen.findByText('CRM branch-1')
    fireEvent.click(screen.getByRole('switch'))
    await screen.findByRole('dialog', { name: 'CRM branch-1 Configuration' })
    fireEvent.change(screen.getByLabelText('API Key'), { target: { value: 'secret-for-branch-1' } })
    const staleSave = mocks.lastSaveClick
    expect(staleSave).toBeTypeOf('function')

    switchIdentityTo('branch-2', rerender)

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    await screen.findByText('CRM branch-2')
    expect(screen.queryByText('CRM branch-1')).not.toBeInTheDocument()

    // A Save click already dispatched to the branch-1 form is dropped.
    await act(async () => { await staleSave?.() })
    expect(mocks.posApiPost).not.toHaveBeenCalled()

    // Reopening under branch-2 starts from an empty form.
    fireEvent.click(screen.getByRole('switch'))
    await screen.findByRole('dialog', { name: 'CRM branch-2 Configuration' })
    expect(screen.getByLabelText('API Key')).toHaveValue('')
    expect(JSON.stringify(mocks.posApiPost.mock.calls)).not.toContain('secret-for-branch-1')
  })

  it('ignores a save response that returns after the identity changed', async () => {
    serveCurrentBranch()
    let finishSave: (value: unknown) => void = () => undefined
    mocks.posApiPost.mockImplementation(() => new Promise((resolve) => { finishSave = resolve }))
    const { rerender } = render(<IntegrationsPage />)

    await screen.findByText('CRM branch-1')
    fireEvent.click(screen.getByRole('switch'))
    await screen.findByRole('dialog', { name: 'CRM branch-1 Configuration' })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(mocks.posApiPost).toHaveBeenCalledTimes(1))

    switchIdentityTo('branch-2', rerender)
    await screen.findByText('CRM branch-2')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()

    await act(async () => { finishSave({ success: true, data: {} }) })

    expect(screen.getByRole('switch')).toHaveAttribute('aria-checked', 'false')
    expect(mocks.toastSuccess).not.toHaveBeenCalled()
    expect(mocks.toastError).not.toHaveBeenCalled()
  })

  it.each([
    { kind: 'plugin' as const, outcome: 'succeeds', reply: { success: true, data: {} } },
    { kind: 'plugin' as const, outcome: 'fails', reply: { success: false, error: 'Rejected for branch-1' } },
    { kind: 'MyData' as const, outcome: 'succeeds', reply: { success: true, data: {} } },
    { kind: 'MyData' as const, outcome: 'fails', reply: { success: false, error: 'Rejected for branch-1' } },
  ])('ignores a $kind disable that $outcome after the identity changed', async ({ kind, reply }) => {
    const disable = DISABLE[kind]
    serveCurrentBranch(disable.row, disable.myData)
    let finishDisable: (value: unknown) => void = () => undefined
    mocks.posApiPost.mockImplementation(() => new Promise((resolve) => { finishDisable = resolve }))
    const { rerender } = render(<IntegrationsPage />)

    await waitFor(() => expect(screen.getByRole('switch')).toHaveAttribute('aria-checked', 'true'))
    fireEvent.click(screen.getByRole('switch'))
    await waitFor(() => expect(mocks.posApiPost).toHaveBeenCalledTimes(1))
    expect(mocks.posApiPost).toHaveBeenCalledWith(...disable.request)

    // The terminal moves to branch-2 while the branch-1 disable is in flight.
    const listsBeforeSwitch = listRequests()
    switchIdentityTo('branch-2', rerender)
    await waitFor(() => expect(listRequests()).toBeGreaterThan(listsBeforeSwitch))
    await waitFor(() => expect(screen.getByRole('switch')).toHaveAttribute('aria-checked', 'true'))
    const listsBeforeReply = listRequests()

    await act(async () => {
      finishDisable(reply)
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    // The reply belongs to branch-1: no toast, no refresh, and branch-2's card stays connected.
    expect(mocks.toastSuccess).not.toHaveBeenCalled()
    expect(mocks.toastError).not.toHaveBeenCalled()
    expect(listRequests()).toBe(listsBeforeReply)
    expect(screen.getAllByRole('switch')).toHaveLength(1)
    expect(screen.getByRole('switch')).toHaveAttribute('aria-checked', 'true')
    expect(mocks.posApiPost).toHaveBeenCalledTimes(1)
  })

  it('closes an open plugin form when a refresh for the same identity fails branch verification', async () => {
    serveCurrentBranch()
    render(<IntegrationsPage />)

    await screen.findByText('CRM branch-1')
    fireEvent.click(screen.getByRole('switch'))
    await screen.findByRole('dialog', { name: 'CRM branch-1 Configuration' })
    fireEvent.change(screen.getByLabelText('API Key'), { target: { value: 'secret-for-branch-1' } })
    const staleSave = mocks.lastSaveClick
    expect(staleSave).toBeTypeOf('function')

    // Same terminal identity, but the refreshed list names another branch.
    serveList({ branch_id: 'branch-9', integrations: [crmFor('branch-9')] })
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }))

    await screen.findByText('Error loading plugins')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(screen.queryByRole('switch')).not.toBeInTheDocument()

    // A Save click already dispatched to the closed form is dropped.
    await act(async () => { await staleSave?.() })
    expect(mocks.posApiPost).not.toHaveBeenCalled()
  })

  it.each([
    { outcome: 'succeeds', reply: { success: true, data: { terminals: [{ id: 'old-terminal', name: 'Old branch terminal' }] } } },
    { outcome: 'fails', reply: { success: false, error: 'Old branch terminal lookup failed' } },
  ])('ignores a terminal lookup that $outcome after the identity changed', async ({ reply }) => {
    serveCurrentBranch()
    const serve = mocks.posApiGet.getMockImplementation()!
    let finishOldLookup: (value: unknown) => void = () => undefined
    mocks.posApiGet.mockImplementation((path: string) => {
      if (path === '/pos/terminals?branchId=branch-1') {
        return new Promise((resolve) => { finishOldLookup = resolve })
      }
      if (path === '/pos/terminals?branchId=branch-2') {
        return Promise.resolve({ success: true, data: { terminals: [{ id: 'new-terminal', name: 'New branch terminal' }] } })
      }
      return serve(path)
    })
    const { rerender } = render(<IntegrationsPage />)
    await screen.findByText('CRM branch-1')
    fireEvent.click(screen.getByRole('switch'))
    await screen.findByRole('dialog', { name: 'CRM branch-1 Configuration' })
    await waitFor(() => expect(mocks.posApiGet).toHaveBeenCalledWith('/pos/terminals?branchId=branch-1'))

    switchIdentityTo('branch-2', rerender)
    await screen.findByText('CRM branch-2')
    fireEvent.click(screen.getByRole('switch'))
    await screen.findByRole('dialog', { name: 'CRM branch-2 Configuration' })
    await screen.findByRole('option', { name: 'New branch terminal' })

    await act(async () => { finishOldLookup(reply) })
    expect(screen.getByRole('option', { name: 'New branch terminal' })).toBeInTheDocument()
    expect(screen.queryByRole('option', { name: 'Old branch terminal' })).not.toBeInTheDocument()
    expect(screen.queryByText('Old branch terminal lookup failed')).not.toBeInTheDocument()
  })

  it('discards an in-flight list from the previous identity', async () => {
    let finishFirst: (value: unknown) => void = () => undefined
    let listCalls = 0
    mocks.posApiGet.mockImplementation((path: string) => {
      if (path === '/pos/mydata/config') return Promise.resolve(MYDATA_MISSING)
      if (path !== '/pos/integrations') return Promise.resolve({ success: true, data: {} })
      listCalls += 1
      if (listCalls === 1) return new Promise((resolve) => { finishFirst = resolve })
      return Promise.resolve({
        success: true,
        data: { branch_id: 'branch-2', integrations: [crmFor('branch-2', { name: 'New branch plugin' })] },
      })
    })
    const { rerender } = render(<IntegrationsPage />)
    await waitFor(() => expect(listCalls).toBe(1))

    switchIdentityTo('branch-2', rerender)
    await act(async () => {
      finishFirst({
        success: true,
        data: { branch_id: 'branch-1', integrations: [crmFor('branch-1', { name: 'Old branch plugin' })] },
      })
    })

    await screen.findByText('New branch plugin')
    expect(screen.getByText('New branch plugin')).toBeInTheDocument()
    expect(screen.queryByText('Old branch plugin')).not.toBeInTheDocument()
  })
})
