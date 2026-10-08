import React from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TerminalDiscoveryModal } from '../TerminalDiscoveryModal'

vi.mock('react-i18next', () => {
  const t = (key: string, fallback?: unknown) => typeof fallback === 'string'
    ? fallback : (fallback as { defaultValue?: string } | undefined)?.defaultValue ?? key
  return { useTranslation: () => ({ t }) }
})
vi.mock('../../ui/pos-glass-components', () => ({
  LiquidGlassModal: ({ isOpen, title, children }: any) => isOpen
    ? <div role="dialog" aria-label={title}>{children}</div> : null,
}))
afterEach(cleanup)

const candidate = (name: string, manufacturer?: string) => ({
  name, deviceType: 'payment_terminal', connectionType: 'network' as const,
  connectionDetails: { type: 'network', ip: '192.168.1.169', port: 9101 },
  manufacturer, isConfigured: false, isSupported: true,
})

// Founder rule 08/10/2026: an RBS / ELIO register is never added as a card terminal.
describe('terminal discovery device type', () => {
  it('points an RBS / ELIO candidate to Cash Register setup and never selects it as a card terminal', async () => {
    const onSelect = vi.fn()
    const onOpenCashRegisterSetup = vi.fn()
    const discoverDevices = vi.fn().mockResolvedValue({
      devices: [candidate('Network Terminal (192.168.1.169:9101)', 'RBS'), candidate('Ingenico Move 5000', 'Ingenico')],
    })
    render(<TerminalDiscoveryModal isOpen onClose={vi.fn()} onSelect={onSelect}
      discoverDevices={discoverDevices} onOpenCashRegisterSetup={onOpenCashRegisterSetup} />)
    await screen.findByText('Ingenico Move 5000')
    expect(screen.getByText(/not a card terminal/)).toBeVisible()
    fireEvent.click(screen.getByText('Network Terminal (192.168.1.169:9101)'))
    expect(onSelect).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Configure Cash Register' }))
    expect(onOpenCashRegisterSetup).toHaveBeenCalledOnce()
    expect(onSelect).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Add' }))
    expect(onSelect).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ name: 'Ingenico Move 5000' }))
  })

  it('hands a manual add over with no device type, so the form requires a choice', async () => {
    const onSelect = vi.fn()
    render(<TerminalDiscoveryModal isOpen onClose={vi.fn()} onSelect={onSelect}
      discoverDevices={vi.fn().mockResolvedValue({ devices: [] })} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Add Terminal Manually' }))
    expect(onSelect).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ deviceType: '' }))
  })
})
