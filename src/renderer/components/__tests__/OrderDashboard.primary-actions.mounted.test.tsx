import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import * as OrderDashboardModule from '../OrderDashboard'

vi.mock('../../contexts/i18n-context', () => ({
  useI18n: () => ({ t: (key: string) => key }),
}))

afterEach(() => cleanup())

type LauncherProps = {
  canOpen: boolean
  onOpen: () => void
}

function getLauncher(): React.ComponentType<LauncherProps> | undefined {
  return (OrderDashboardModule as unknown as {
    OrderPrimaryActionLauncher?: React.ComponentType<LauncherProps>
  }).OrderPrimaryActionLauncher
}

// The (+) is a plain trigger for the unified "new work" picker: the cards
// (delivery, pickup, table, room, appointment, repair, quick service) are
// resolved by resolveNewWorkCards and rendered by the dashboard modal. The
// former intermediate «Νέο» chooser is gone (founder, 05/09/2026).
describe('OrderDashboard (+) launcher', () => {
  it('opens the picker directly when something can be started', () => {
    const Launcher = getLauncher()
    expect(Launcher).toBeDefined()
    if (!Launcher) return
    const onOpen = vi.fn()

    render(<Launcher canOpen onOpen={onOpen} />)
    fireEvent.click(screen.getByTestId('tauri-primary-action-trigger'))

    expect(onOpen).toHaveBeenCalledTimes(1)
    // No chooser of its own: nothing but the trigger is rendered.
    expect(screen.queryByTestId('tauri-primary-action-new_sale')).toBeNull()
  })

  it('is disabled when nothing is launchable (sales-only store without a shift)', () => {
    const Launcher = getLauncher()
    expect(Launcher).toBeDefined()
    if (!Launcher) return
    const onOpen = vi.fn()

    render(<Launcher canOpen={false} onOpen={onOpen} />)
    const trigger = screen.getByTestId('tauri-primary-action-trigger')

    expect(trigger).toBeDisabled()
    fireEvent.click(trigger)
    expect(onOpen).not.toHaveBeenCalled()
  })
})
