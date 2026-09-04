import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as OrderDashboardModule from '../OrderDashboard'
import { resolveTauriPrimaryActions } from '../../primary-actions'

vi.mock('../../contexts/i18n-context', () => ({
  useI18n: () => ({ t: (key: string) => key }),
}))

afterEach(() => cleanup())

type LauncherProps = {
  actions: ReturnType<typeof resolveTauriPrimaryActions>
  isShiftActive: boolean
  onNewSale: () => void
  onNewRepair: () => void
  onQuickService: () => void
  onNewAppointment: () => void
}

function getLauncher(): React.ComponentType<LauncherProps> | undefined {
  return (OrderDashboardModule as unknown as {
    OrderPrimaryActionLauncher?: React.ComponentType<LauncherProps>
  }).OrderPrimaryActionLauncher
}

describe('OrderDashboard mounted primary-action launcher', () => {
  it('opens appointments without a cash shift while keeping sale and repair intake actions disabled', () => {
    const Launcher = getLauncher()
    expect(Launcher).toBeDefined()
    if (!Launcher) return

    const onNewSale = vi.fn()
    const onNewRepair = vi.fn()
    const onQuickService = vi.fn()
    const onNewAppointment = vi.fn()
    render(
      <Launcher
        actions={resolveTauriPrimaryActions(['orders', 'appointments', 'repairs'], true)}
        isShiftActive={false}
        onNewSale={onNewSale}
        onNewRepair={onNewRepair}
        onQuickService={onQuickService}
        onNewAppointment={onNewAppointment}
      />,
    )

    fireEvent.click(screen.getByTestId('tauri-primary-action-trigger'))
    fireEvent.click(screen.getByTestId('tauri-primary-action-new_appointment'))

    expect(onNewAppointment).toHaveBeenCalledTimes(1)
    expect(onNewSale).not.toHaveBeenCalled()
    expect(onNewRepair).not.toHaveBeenCalled()
    expect(onQuickService).not.toHaveBeenCalled()
    for (const actionId of ['new_sale', 'new_repair', 'quick_service']) {
      const action = screen.getByTestId(`tauri-primary-action-${actionId}`)
      expect(action).toBeDisabled()
      expect(within(action).getByText('orders.startShiftFirst')).toBeVisible()
    }
  })

  it('routes repair and quick-service actions when a shift is active', () => {
    const Launcher = getLauncher()
    expect(Launcher).toBeDefined()
    if (!Launcher) return

    const onNewRepair = vi.fn()
    const onQuickService = vi.fn()
    render(
      <Launcher
        actions={resolveTauriPrimaryActions(['orders', 'appointments', 'repairs'], true)}
        isShiftActive
        onNewSale={vi.fn()}
        onNewRepair={onNewRepair}
        onQuickService={onQuickService}
        onNewAppointment={vi.fn()}
      />,
    )

    fireEvent.click(screen.getByTestId('tauri-primary-action-trigger'))
    fireEvent.click(screen.getByTestId('tauri-primary-action-new_repair'))
    expect(onNewRepair).toHaveBeenCalledTimes(1)

    fireEvent.click(screen.getByTestId('tauri-primary-action-trigger'))
    fireEvent.click(screen.getByTestId('tauri-primary-action-quick_service'))
    expect(onQuickService).toHaveBeenCalledTimes(1)
  })
})
