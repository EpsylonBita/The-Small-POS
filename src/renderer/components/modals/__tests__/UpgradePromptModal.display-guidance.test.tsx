import React from 'react'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import UpgradePromptModal from '../UpgradePromptModal'
import { localeBundles } from '../../../../locales/bundles'
import type { PublicLaunchCatalogDTO } from '../../../../shared/types/launchCatalog'

const mocks = vi.hoisted(() => ({ api: vi.fn(), context: vi.fn(), open: vi.fn() }))
const ORG = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const context = { organizationId: ORG, key: 'current-context', adminUrl: 'https://admin.test' }
function catalog(): PublicLaunchCatalogDTO {
  return { available: true, currency: 'EUR', version: 'test', reason: null,
    base: { id: 'starter', planName: 'starter', displayName: 'Starter', monthly: 10, annual: 120,
      includedModuleIds: ['menu', 'orders'], builtInScreens: ['dashboard'], includedResources: { branches: 1, posTerminals: 1 }, staffLimit: null, action: 'checkout' },
    modules: ['kitchen_display','customer_display','inventory'].map(module_id => ({ module_id, display_name: module_id,
      description: '', icon: null, monthly: 3, annual: 36, includes: [], included_in: [], required_module_ids: [],
      action: 'checkout', release: { available: true }, hardwareIncluded: false })),
  }
}
function translate(key: string, options?: Record<string, unknown>) {
  const value = key.split('.').reduce<unknown>((part, segment) => (part as Record<string, unknown>)?.[segment], localeBundles.en)
  return String(value || options?.defaultValue || key).replace(/\{\{(\w+)\}\}/g, (_, name) => String(options?.[name] ?? name))
}
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: translate, i18n: { language: 'en' } }) }))
vi.mock('../../../contexts/i18n-context', () => ({ useI18n: () => ({ t: translate }) }))
vi.mock('../../../contexts/theme-context', () => ({ useTheme: () => ({ resolvedTheme: 'light' }) }))
vi.mock('../../../hooks/useBlockerRegistration', () => ({ useBlockerRegistration: () => undefined }))
vi.mock('../../../utils/api-helpers', () => ({ posApiFetch: mocks.api }))
vi.mock('../../../utils/external-url', () => ({ openExternalUrl: mocks.open }))
vi.mock('../../../services/launchPurchaseEntry', () => ({ readLaunchPurchaseContext: mocks.context }))
vi.mock('../../../../lib', () => ({ onEvent: vi.fn(), offEvent: vi.fn() }))
vi.mock('../../../../shared/services/moduleMetadataFallback', () => ({ getFallbackModuleMetadata: (id: string) => ({ name: id, description: 'Module description' }) }))
let sheet: HTMLStyleElement
beforeEach(() => {
  vi.clearAllMocks()
  mocks.api.mockResolvedValue({ success: true, data: catalog() })
  mocks.context.mockResolvedValue(context)
  mocks.open.mockResolvedValue(true)
  sheet = document.createElement('style')
  sheet.textContent = readFileSync(resolve(process.cwd(), 'src/renderer/styles/glassmorphism.css'), 'utf8')
  document.head.appendChild(sheet)
})
afterEach(() => { cleanup(); sheet.remove() })
const openButton = () => screen.findByRole('button', { name: 'View purchase' })
const clickOpen = async () => { fireEvent.click(await openButton()); await waitFor(() => expect(mocks.open).toHaveBeenCalledTimes(1)) }

describe('actual desktop purchase entry', () => {
  it.each([['kitchen_display','kitchen_display'],['customer_display','customer_display'],['kitchen-display','kitchen_display'],['customer-display','customer_display']])('keeps %s equipment guidance before purchase', async (moduleId, canonical) => {
    render(<UpgradePromptModal moduleId={moduleId} isOpen onClose={vi.fn()} requiredPlan="Enterprise" />)
    const guidance = screen.getByRole('region', { name: 'Before you buy' })
    expect(within(guidance).getByText(/Sharing a Wi-Fi network alone/)).toBeVisible()
    expect(within(guidance).getByText(/not every Android POS/)).toBeVisible()
    expect(within(guidance).getByText(/main POS screen plus two different/)).toBeVisible()
    expect(within(guidance).getByText(canonical === 'kitchen_display' ? /HDMI video alone does not provide touch/ : /does not require a touchscreen/)).toBeVisible()
    const button = await openButton()
    expect(guidance.compareDocumentPosition(button) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(screen.queryByText('Enterprise')).toBeNull()
    expect(screen.queryByText('Unlimited usage and storage')).toBeNull()
    await clickOpen()
    expect(new URL(mocks.open.mock.calls[0][0]).searchParams.get('purchase')).toBe(canonical)
    expect(mocks.api.mock.calls.every((call: unknown[]) => (call[1] as RequestInit).method === 'GET')).toBe(true)
  })
  it.each(['menu','orders'])('shows the one Starter price while preserving %s in the browser hint', async moduleId => {
    render(<UpgradePromptModal moduleId={moduleId} isOpen onClose={vi.fn()} />)
    expect(await screen.findByText('€10.00 / Month')).toBeVisible()
    expect(screen.getByText('Includes 1 branch(es) and 1 terminal(s).')).toBeVisible()
    expect(screen.getByText('Staff included without a per-person fee.')).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: 'Year' }))
    expect(screen.getByText('€120.00 / Year')).toBeVisible()
    await clickOpen()
    const url = new URL(mocks.open.mock.calls[0][0])
    expect(Object.fromEntries(url.searchParams)).toMatchObject({ purchase: moduleId, organization_id: ORG, billing: 'annual', source: 'pos_tauri', context: 'locked_module' })
  })
  it('shows the returned included owner without inventing a child charge', async () => {
    const dto = catalog()
    dto.modules = [...dto.modules, { ...dto.modules[0], module_id: 'suppliers', action: 'included', monthly: 0, annual: 0, included_in: ['inventory'] }]
    mocks.api.mockResolvedValue({ success: true, data: dto })
    render(<UpgradePromptModal moduleId="suppliers" isOpen onClose={vi.fn()} />)
    expect(await screen.findByText('€3.00 / Month')).toBeVisible()
    expect(screen.getByText('Also included with: inventory')).toBeVisible()
  })
  it.each(['offline','invalid currency','missing identity'])('offers no invented price or purchase while %s', async failure => {
    if (failure === 'offline') mocks.api.mockResolvedValue({ success: false })
    if (failure === 'invalid currency') mocks.api.mockResolvedValue({ success: true, data: { ...catalog(), currency: null } })
    if (failure === 'missing identity') mocks.context.mockResolvedValue({ ...context, organizationId: '' })
    render(<UpgradePromptModal moduleId="menu" isOpen onClose={vi.fn()} />)
    expect(await screen.findByText('Prices are unavailable. Reconnect and retry.')).toBeVisible()
    expect(screen.queryByRole('button', { name: 'View purchase' })).toBeNull()
    expect(mocks.open).not.toHaveBeenCalled()
  })
  it.each(['ai_assistant','plugin_integrations'])('does not sell excluded %s', async moduleId => {
    render(<UpgradePromptModal moduleId={moduleId} isOpen onClose={vi.fn()} />)
    expect(screen.queryByRole('button', { name: 'View purchase' })).toBeNull()
    expect(mocks.api).not.toHaveBeenCalled()
  })
  it('makes a failed browser launch retryable without reporting purchase success', async () => {
    mocks.open.mockResolvedValueOnce(false)
    const onClose = vi.fn()
    render(<UpgradePromptModal moduleId="menu" isOpen onClose={onClose} />)
    await clickOpen()
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not open the purchase page')
    fireEvent.click(await openButton())
    await waitFor(() => expect(mocks.open).toHaveBeenCalledTimes(2))
    expect(onClose).not.toHaveBeenCalled()
  })
  it.each(['close','module','organization'])('suppresses a held open after %s changes', async change => {
    const view = render(<UpgradePromptModal moduleId="menu" isOpen onClose={vi.fn()} />)
    await openButton()
    let finish!: (value: typeof context) => void
    mocks.context.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    fireEvent.click(await openButton())
    if (change === 'close') fireEvent.click(screen.getByRole('button', { name: translate('common.actions.close') }))
    if (change === 'module') view.rerender(<UpgradePromptModal moduleId="orders" isOpen onClose={vi.fn()} />)
    await act(async () => { finish(change === 'organization' ? { ...context, key: 'other', organizationId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' } : context) })
    expect(mocks.open).not.toHaveBeenCalled()
  })
  it('keeps a closed modal unmounted without reading the catalog', () => {
    render(<UpgradePromptModal moduleId="menu" isOpen={false} onClose={vi.fn()} />)
    expect(screen.queryByRole('dialog')).toBeNull(); expect(mocks.api).not.toHaveBeenCalled()
  })
})
