import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { liquidGlassModalTone } from '../../../styles/designSystem'

const mocks = vi.hoisted(() => ({
  scanNetwork: vi.fn(),
  scanBluetooth: vi.fn(),
  discover: vi.fn(),
  recommendProfile: vi.fn(),
  usePrintQueue: vi.fn(),
}))

vi.mock('../../../../lib', () => {
  const bridge = {
    printer: {
      scanNetwork: mocks.scanNetwork,
      scanBluetooth: mocks.scanBluetooth,
      discover: mocks.discover,
      recommendProfile: mocks.recommendProfile,
      testDraft: vi.fn(),
      add: vi.fn(),
      update: vi.fn(),
    },
    settings: { updateLocal: vi.fn() },
  }
  return { getBridge: () => bridge }
})

vi.mock('../../../hooks/usePrintQueue', () => ({
  usePrintQueue: mocks.usePrintQueue,
}))

vi.mock('react-hot-toast', () => ({
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }),
}))

vi.mock('react-i18next', () => {
  const t = (key: string, fallbackOrOptions?: string | Record<string, unknown>) => {
    if (typeof fallbackOrOptions === 'string') return fallbackOrOptions
    const fallback = fallbackOrOptions?.defaultValue
    return typeof fallback === 'string' ? fallback : key
  }
  return { useTranslation: () => ({ t }) }
})

import PrinterSetupWizard from '../PrinterSetupWizard'

const queue = {
  jobs: [],
  queuePaused: false,
  pausedPrinterProfileIds: [],
  counts: { active: 0, failed: 0, stale: 0, history: 0 },
  pagination: { offset: 0, limit: 100, total: 0, hasMore: false },
  loading: false,
  stale: false,
  error: null,
  refresh: vi.fn(),
  cancelJob: vi.fn(),
  cancelAllJobs: vi.fn(),
  pauseQueue: vi.fn(),
  resumeQueue: vi.fn(),
  retryJob: vi.fn(),
  reprintJob: vi.fn(),
}

describe('printer setup semantic modal tones', () => {
  it.each(['neutral', 'success', 'warning', 'danger'] as const)(
    'gives the %s tone an explicit readable light surface and dark variant',
    (tone) => {
      const classes = liquidGlassModalTone(tone)
      expect(classes).toMatch(/(?:^|\s)bg-(?!white\/|black\/)[^\s]+/)
      expect(classes).toMatch(/(?:^|\s)border-[^\s]+/)
      expect(classes).toMatch(/(?:^|\s)text-[^\s]+/)
      expect(classes).toMatch(/(?:^|\s)dark:bg-[^\s]+/)
      expect(classes).toMatch(/(?:^|\s)dark:border-[^\s]+/)
      expect(classes).toMatch(/(?:^|\s)dark:text-[^\s]+/)
    },
  )
})

describe('PrinterSetupWizard accessibility and theme consumption', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.scanNetwork.mockResolvedValue([{
      name: 'Accessible Printer',
      type: 'system',
      address: 'Accessible Printer',
      source: 'windows',
      isConfigured: false,
    }])
    mocks.scanBluetooth.mockResolvedValue([])
    mocks.discover.mockResolvedValue([])
    mocks.recommendProfile.mockResolvedValue({
      detectedBrand: 'Star',
      confidence: 90,
      reasons: [],
      recommended: {
        printerType: 'system',
        paperSize: '80mm',
        characterSet: 'PC737_GREEK',
        receiptTemplate: 'classic',
        connectionDetails: { type: 'system', systemName: 'Accessible Printer' },
      },
    })
    mocks.usePrintQueue.mockReturnValue(queue)
  })

  afterEach(() => cleanup())

  it('uses an ordered step list, current step, pressed candidate state, and 44px controls', async () => {
    render(<PrinterSetupWizard
      existingPrinters={[]}
      onCancel={vi.fn()}
      onSaved={vi.fn()}
      onOpenExpert={vi.fn()}
      logoSettingsLoaded
      logoConfigured={false}
      onOpenLogoSettings={vi.fn()}
    />)

    const stepList = screen.getByRole('list')
    expect(stepList.tagName).toBe('OL')
    expect(stepList.querySelectorAll(':scope > li')).toHaveLength(4)
    expect(screen.getByRole('button', { name: 'detect' })).toHaveAttribute('aria-current', 'step')
    const candidate = await screen.findByRole('button', { name: /Accessible Printer/ })
    expect(candidate).toHaveAttribute('aria-pressed', 'true')
    expect(candidate).toHaveClass('min-h-[44px]')

    fireEvent.click(screen.getByRole('button', { name: 'Next' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'verify' }))
      .toHaveAttribute('aria-current', 'step'))
    for (const button of screen.getAllByRole('button')) {
      if (/^(Send|Cancel|Back|Next|Expert|Open logo)/i.test(button.textContent ?? '')) {
        expect(button.className).toContain('min-h-[44px]')
      }
    }
  })

  it('renders shared light/dark semantic tones and no dark-only wizard card surfaces', async () => {
    const view = render(<PrinterSetupWizard
      existingPrinters={[]}
      onCancel={vi.fn()}
      onSaved={vi.fn()}
      onOpenExpert={vi.fn()}
      logoSettingsLoaded
      logoConfigured={false}
      onOpenLogoSettings={vi.fn()}
    />)
    await screen.findByText('Accessible Printer')
    fireEvent.click(screen.getByRole('button', { name: 'Next' }))
    await screen.findByRole('heading', { name: 'Step 2: Verify Compatibility' })

    const markup = view.container.innerHTML
    expect(markup).toContain('bg-slate-50')
    expect(markup).toContain('dark:bg-slate-900/60')
    expect(markup).not.toMatch(/(?:border-white\/10\s+bg-white\/5|bg-white\/5\s+border-white\/10)/)
  })

  it('programmatically labels selects and readability choices and gives every assignment row a 44px target', async () => {
    render(<PrinterSetupWizard
      existingPrinters={[]}
      onCancel={vi.fn()}
      onSaved={vi.fn()}
      onOpenExpert={vi.fn()}
      logoSettingsLoaded
      logoConfigured={false}
      onOpenLogoSettings={vi.fn()}
    />)
    await screen.findByText('Accessible Printer')
    fireEvent.click(screen.getByRole('button', { name: 'verify' }))
    expect(screen.getByRole('combobox', { name: 'Paper Size' })).toBeVisible()

    fireEvent.click(screen.getByRole('button', { name: 'style' }))
    expect(screen.getByRole('combobox', { name: 'Receipt Template' })).toBeVisible()
    const readability = screen.getByRole('radiogroup', { name: 'Readability' })
    const choices = within(readability).getAllByRole('radio')
    expect(choices).toHaveLength(3)
    const small = within(readability).getByRole('radio', { name: 'Small' })
    const normal = within(readability).getByRole('radio', { name: 'Normal' })
    const large = within(readability).getByRole('radio', { name: 'Large' })
    expect(normal).toHaveAttribute('aria-checked', 'true')
    expect(normal).toHaveAttribute('tabindex', '0')
    expect(small).toHaveAttribute('tabindex', '-1')
    expect(large).toHaveAttribute('tabindex', '-1')

    normal.focus()
    fireEvent.keyDown(normal, { key: 'ArrowRight' })
    expect(large).toHaveAttribute('aria-checked', 'true')
    expect(large).toHaveFocus()
    expect(large).toHaveAttribute('tabindex', '0')

    fireEvent.keyDown(large, { key: 'ArrowRight' })
    expect(small).toHaveAttribute('aria-checked', 'true')
    expect(small).toHaveFocus()

    fireEvent.keyDown(small, { key: 'End' })
    expect(large).toHaveAttribute('aria-checked', 'true')
    expect(large).toHaveFocus()

    fireEvent.click(screen.getByRole('button', { name: 'save' }))
    for (const checkbox of screen.getAllByRole('checkbox')) {
      expect(checkbox.closest('label')).toHaveClass('min-h-[44px]')
    }
  })
})
