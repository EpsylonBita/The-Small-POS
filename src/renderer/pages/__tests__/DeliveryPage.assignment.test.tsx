import React from 'react'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { DriverAssignmentModal } from '../DeliveryPage'

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string, fallback?: string) => fallback ?? key }) }))
vi.mock('../../utils/render-modal-portal', () => ({ renderModalPortal: (node: React.ReactNode) => node }))
vi.mock('../../../lib', () => ({ getBridge: vi.fn(), onEvent: vi.fn(), offEvent: vi.fn() }))
vi.mock('../../hooks/useTerminalSettings', () => ({ useTerminalSettings: () => ({}) }))
vi.mock('../../utils/format', () => ({ formatCurrency: (value: number) => String(value) }))
vi.mock('../../contexts/theme-context', () => ({ useTheme: () => ({ resolvedTheme: 'light' }) }))

describe('delivery page driver assignment', () => {
  it('retains the driver on refusal and ignores repeat submit/close while pending', async () => {
    let finish!: (value: boolean) => void
    const assign = vi.fn().mockImplementationOnce(() => new Promise(resolve => { finish = resolve })).mockResolvedValue(true)
    const close = vi.fn()
    render(<DriverAssignmentModal isOpen onClose={close} delivery={{ id: 'order-1', orderNumber: '001' } as any}
      drivers={[{ id: 'driver-1', name: 'Test Driver', status: { isAvailable: true, activeAssignments: 0 } } as any]}
      onAssign={assign} isDark={false} />)
    fireEvent.click(screen.getByText('Test Driver'))
    const submit = screen.getByRole('button', { name: 'Assign Selected Driver' })
    fireEvent.click(submit)
    fireEvent.click(submit)
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(assign).toHaveBeenCalledTimes(1)
    expect(close).not.toHaveBeenCalled()
    await act(async () => finish(false))
    expect(screen.getByRole('button', { name: /Test Driver/ }).getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(submit)
    await waitFor(() => expect(close).toHaveBeenCalledTimes(1))
    expect(assign).toHaveBeenLastCalledWith('order-1', 'driver-1')
  })
})
