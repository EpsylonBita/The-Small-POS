import React, { useState } from 'react'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { posApiGet, posApiPost } = vi.hoisted(() => ({
  posApiGet: vi.fn(),
  posApiPost: vi.fn(),
}))
vi.mock('../../../utils/api-helpers', () => ({ posApiGet, posApiPost }))

const translate = (
  key: string,
  defaultValueOrOptions?: string | { defaultValue?: string; [k: string]: unknown },
) => {
  if (typeof defaultValueOrOptions === 'string') return defaultValueOrOptions
  const template = defaultValueOrOptions?.defaultValue ?? key
  if (typeof template !== 'string' || !defaultValueOrOptions) return template
  return template.replace(/\{\{(\w+)\}\}/g, (_, name) =>
    String((defaultValueOrOptions as Record<string, unknown>)[name] ?? ''),
  )
}
vi.mock('react-i18next', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-i18next')>()
  return { ...actual, useTranslation: () => ({ t: translate }) }
})

import { EfoodWeeklyScheduleEditor } from '../EfoodWeeklyScheduleEditor'
import { EFOOD_WEEK_DAYS, type EfoodDaySchedule } from '../../../services/efoodWeeklySchedule'

function closedWeek(overrides: Partial<Record<string, string[]>> = {}): EfoodDaySchedule[] {
  return EFOOD_WEEK_DAYS.map((day) => ({ day, times: overrides[day] ?? [] }))
}

function scheduleResponse(days: EfoodDaySchedule[], checked_at: string | null = '2026-09-14T00:00:00Z') {
  return { success: true, data: { success: true, schedule: { days, checked_at } } }
}

async function flush() {
  await act(async () => Promise.resolve())
}

// Mirrors how PlatformsSection owns pending-submission and open/closed state
// for the real editor: lifted state so it survives the editor unmounting.
function Harness({
  initialOnline = true,
  parentActionPending = false,
}: { initialOnline?: boolean; parentActionPending?: boolean } = {}) {
  const [pending, setPending] = useState<EfoodDaySchedule[] | null>(null)
  const [open, setOpen] = useState(true)
  const [online, setOnline] = useState(initialOnline)
  return (
    <div>
      <button onClick={() => setOpen((o) => !o)}>toggle-open</button>
      <button onClick={() => setOnline((o) => !o)}>toggle-online</button>
      {open && (
        <EfoodWeeklyScheduleEditor
          onClose={() => setOpen(false)}
          parentActionPending={parentActionPending}
          isOnline={online}
          pendingSubmission={pending}
          onPendingSubmissionChange={setPending}
        />
      )}
    </div>
  )
}

describe('EfoodWeeklyScheduleEditor', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    Object.defineProperty(window.navigator, 'onLine', { value: true, configurable: true })
  })
  afterEach(cleanup)

  it('loads the live schedule and shows all seven days with split hours and closed days', async () => {
    posApiGet.mockResolvedValue(scheduleResponse(closedWeek({ monday: ['08:00-12:00', '13:00-16:00'] })))
    render(<Harness />)
    await screen.findByTestId('efood-day-monday')

    const monday = screen.getByTestId('efood-day-monday')
    expect(within(monday).getAllByPlaceholderText('HH:mm')).toHaveLength(4)
    expect(within(monday).getByDisplayValue('08:00')).toBeInTheDocument()
    expect(within(monday).getByDisplayValue('16:00')).toBeInTheDocument()

    const sunday = screen.getByTestId('efood-day-sunday')
    expect(within(sunday).getByRole('checkbox')).toBeChecked()
  })

  it('never defaults to an all-closed week on a failed initial load', async () => {
    posApiGet.mockResolvedValue({ success: false, error: 'network down' })
    render(<Harness />)
    await screen.findByText('Could not load efood hours')
    expect(screen.queryByTestId('efood-day-monday')).not.toBeInTheDocument()
  })

  it('never throws on a malformed upstream response and shows an error instead of a blank week', async () => {
    posApiGet.mockResolvedValue({
      success: true,
      data: { success: true, schedule: { days: [null, { day: 'monday' }, 42], checked_at: null } },
    })
    render(<Harness />)
    await screen.findByText('Could not load efood hours')
  })

  it('does not dispatch a load while opened offline', async () => {
    render(<Harness initialOnline={false} />)
    await flush()
    expect(posApiGet).not.toHaveBeenCalled()
    expect(screen.getByText('Reconnect to load or edit efood hours.')).toBeInTheDocument()
    expect(screen.queryByText('Send to efood')).not.toBeInTheDocument()
  })

  it('toggling closed clears hours, and all-day sets 00:00-23:59', async () => {
    posApiGet.mockResolvedValue(scheduleResponse(closedWeek({ tuesday: ['08:00-16:00'] })))
    render(<Harness />)
    const tuesday = await screen.findByTestId('efood-day-tuesday')

    fireEvent.click(within(tuesday).getByRole('checkbox'))
    expect(within(tuesday).queryByPlaceholderText('HH:mm')).not.toBeInTheDocument()

    fireEvent.click(within(tuesday).getByRole('checkbox'))
    fireEvent.click(within(tuesday).getByText('All day (00:00–23:59)'))
    expect(within(tuesday).getByDisplayValue('00:00')).toBeInTheDocument()
    expect(within(tuesday).getByDisplayValue('23:59')).toBeInTheDocument()
  })

  it('shows a validation error for an overlapping interval and blocks save', async () => {
    posApiGet.mockResolvedValue(scheduleResponse(closedWeek({ monday: ['08:00-14:00'] })))
    render(<Harness />)
    const monday = await screen.findByTestId('efood-day-monday')

    fireEvent.click(within(monday).getByText('Add hours'))
    const froms = within(monday).getAllByLabelText('From')
    const tos = within(monday).getAllByLabelText('To')
    fireEvent.change(froms[1], { target: { value: '13:00' } })
    fireEvent.change(tos[1], { target: { value: '18:00' } })

    await screen.findByText(/times must be HH:mm/)
    expect(screen.getByRole('button', { name: 'Send to efood' })).toBeDisabled()
    expect(posApiPost).not.toHaveBeenCalled()
  })

  it('an incomplete added interval keeps the draft dirty and is never dropped by a refresh', async () => {
    posApiGet.mockResolvedValueOnce(scheduleResponse(closedWeek({ monday: ['08:00-16:00'] })))
    render(<Harness />)
    const monday = await screen.findByTestId('efood-day-monday')

    fireEvent.click(within(monday).getByText('Add hours'))
    fireEvent.change(within(monday).getAllByLabelText('From')[1], { target: { value: '17:00' } })
    // "To" left blank: an invalid, in-progress interval.

    posApiGet.mockResolvedValueOnce(scheduleResponse(closedWeek({ monday: ['08:00-16:00'] })))
    fireEvent.click(screen.getByText('Refresh'))
    await flush()

    await screen.findByText('A newer schedule was loaded from efood. Reload to see it, or keep editing.')
    expect(within(screen.getByTestId('efood-day-monday')).getByDisplayValue('17:00')).toBeInTheDocument()
  })

  it('posts the exact 7-day body and shows the pending-confirmation banner on 202', async () => {
    posApiGet.mockResolvedValue(scheduleResponse(closedWeek({ monday: ['08:00-16:00'] })))
    let resolvePost: (value: unknown) => void = () => {}
    posApiPost.mockReturnValue(new Promise((resolve) => { resolvePost = resolve }))

    render(<Harness />)
    await screen.findByTestId('efood-day-monday')

    fireEvent.click(screen.getByText('Send to efood'))
    await flush()
    expect(posApiPost).toHaveBeenCalledWith('/pos/platforms/efood/schedule', {
      days: closedWeek({ monday: ['08:00-16:00'] }),
    })
    // Duplicate click while in flight must not fire a second POST.
    fireEvent.click(screen.getByText('Send to efood'))
    expect(posApiPost).toHaveBeenCalledTimes(1)

    resolvePost({
      success: true,
      data: { success: true, status: 'submitted', schedule: { days: closedWeek({ monday: ['08:00-16:00'] }), checked_at: null } },
    })
    await flush()
    await screen.findByText('Waiting for efood to apply changes; refresh in a few minutes.')
    expect(screen.getByRole('button', { name: 'Send to efood' })).toBeDisabled()
  })

  it('confirms the change once a refresh reads back the matching schedule', async () => {
    posApiGet.mockResolvedValueOnce(scheduleResponse(closedWeek({ monday: ['08:00-16:00'] })))
    posApiPost.mockResolvedValueOnce({
      success: true,
      data: { success: true, status: 'submitted', schedule: { days: closedWeek({ monday: ['09:00-17:00'] }), checked_at: null } },
    })
    render(<Harness />)
    const monday = await screen.findByTestId('efood-day-monday')
    fireEvent.change(within(monday).getAllByLabelText('From')[0], { target: { value: '09:00' } })
    fireEvent.change(within(monday).getAllByLabelText('To')[0], { target: { value: '17:00' } })

    fireEvent.click(screen.getByText('Send to efood'))
    await flush()
    await screen.findByText('Waiting for efood to apply changes; refresh in a few minutes.')

    posApiGet.mockResolvedValueOnce(scheduleResponse(closedWeek({ monday: ['09:00-17:00'] })))
    fireEvent.click(screen.getByText('Refresh'))
    await flush()

    await screen.findByText('efood confirmed the new hours.')
    expect(screen.queryByText('Waiting for efood to apply changes; refresh in a few minutes.')).not.toBeInTheDocument()
    expect(screen.getByText('Send to efood')).not.toBeDisabled()
  })

  it('preserves the submitted draft when a refresh reads a mismatching (stale) schedule', async () => {
    posApiGet.mockResolvedValueOnce(scheduleResponse(closedWeek({ monday: ['08:00-16:00'] })))
    posApiPost.mockResolvedValueOnce({
      success: true,
      data: { success: true, status: 'submitted', schedule: { days: closedWeek({ monday: ['09:00-17:00'] }), checked_at: null } },
    })
    render(<Harness />)
    const monday = await screen.findByTestId('efood-day-monday')
    fireEvent.change(within(monday).getAllByLabelText('From')[0], { target: { value: '09:00' } })
    fireEvent.change(within(monday).getAllByLabelText('To')[0], { target: { value: '17:00' } })
    fireEvent.click(screen.getByText('Send to efood'))
    await flush()

    posApiGet.mockResolvedValueOnce(scheduleResponse(closedWeek({ monday: ['08:00-16:00'] })))
    fireEvent.click(screen.getByText('Refresh'))
    await flush()

    await screen.findByText('Waiting for efood to apply changes; refresh in a few minutes.')
    expect(within(screen.getByTestId('efood-day-monday')).getByDisplayValue('09:00')).toBeInTheDocument()
  })

  it('a submit in flight invalidates a slower concurrent read so it cannot clobber the new pending state', async () => {
    let resolveFirstGet: (value: unknown) => void = () => {}
    posApiGet.mockReturnValueOnce(new Promise((resolve) => { resolveFirstGet = resolve }))
    render(<Harness />)
    // Initial mount load is in flight (not yet resolved).

    posApiPost.mockResolvedValueOnce({
      success: true,
      data: { success: true, status: 'submitted', schedule: { days: closedWeek({ monday: ['09:00-17:00'] }), checked_at: null } },
    })

    // Resolve the very first (mount) GET now so we have a draft to edit and save.
    resolveFirstGet(scheduleResponse(closedWeek({ monday: ['08:00-16:00'] })))
    await flush()
    const monday = await screen.findByTestId('efood-day-monday')
    fireEvent.change(within(monday).getAllByLabelText('From')[0], { target: { value: '09:00' } })
    fireEvent.change(within(monday).getAllByLabelText('To')[0], { target: { value: '17:00' } })

    let resolveRefreshGet: (value: unknown) => void = () => {}
    posApiGet.mockReturnValueOnce(new Promise((resolve) => { resolveRefreshGet = resolve }))
    fireEvent.click(screen.getByText('Refresh'))
    await flush()

    // Submit starts while the refresh GET above is still in flight.
    fireEvent.click(screen.getByText('Send to efood'))
    await flush()

    // The slow refresh GET now resolves with the pre-edit schedule; it must
    // not be applied since the submit superseded it.
    resolveRefreshGet(scheduleResponse(closedWeek({ monday: ['08:00-16:00'] })))
    await flush()

    await screen.findByText('Waiting for efood to apply changes; refresh in a few minutes.')
    expect(within(screen.getByTestId('efood-day-monday')).getByDisplayValue('09:00')).toBeInTheDocument()
  })

  it('shows a safe message for a proved provider refusal', async () => {
    posApiGet.mockResolvedValue(scheduleResponse(closedWeek({ monday: ['08:00-16:00'] })))
    posApiPost.mockResolvedValue({ success: false, error: 'provider_forbidden (HTTP 502): upstream refusal' })
    render(<Harness />)
    await screen.findByTestId('efood-day-monday')
    fireEvent.click(screen.getByText('Send to efood'))
    await flush()

    await screen.findByText('efood has not permitted this change; contact support.')
    expect(screen.queryByText(/upstream refusal/)).not.toBeInTheDocument()
    // A clean, recognized failure is not an unknown outcome: retry stays available.
    expect(screen.getByText('Send to efood')).not.toBeDisabled()
  })

  it('treats a network failure as an unknown outcome and requires a refresh before retrying', async () => {
    posApiGet.mockResolvedValue(scheduleResponse(closedWeek({ monday: ['08:00-16:00'] })))
    posApiPost.mockRejectedValue(new Error('ECONNRESET raw provider failure'))
    render(<Harness />)
    await screen.findByTestId('efood-day-monday')
    fireEvent.click(screen.getByText('Send to efood'))
    await flush()

    await screen.findByText('Waiting for efood to apply changes; refresh in a few minutes.')
    expect(screen.queryByText(/ECONNRESET/)).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Send to efood' })).toBeDisabled()
  })

  it('keeps and clearly shows the pending result after closing and reopening the editor', async () => {
    posApiGet.mockResolvedValueOnce(scheduleResponse(closedWeek({ monday: ['08:00-16:00'] })))
    posApiPost.mockResolvedValueOnce({
      success: true,
      data: { success: true, status: 'submitted', schedule: { days: closedWeek({ monday: ['09:00-17:00'] }), checked_at: null } },
    })
    render(<Harness />)
    const monday = await screen.findByTestId('efood-day-monday')
    fireEvent.change(within(monday).getAllByLabelText('From')[0], { target: { value: '09:00' } })
    fireEvent.change(within(monday).getAllByLabelText('To')[0], { target: { value: '17:00' } })
    fireEvent.click(screen.getByText('Send to efood'))
    await flush()
    await screen.findByText('Waiting for efood to apply changes; refresh in a few minutes.')

    fireEvent.click(screen.getByLabelText('Close'))
    expect(screen.queryByTestId('efood-day-monday')).not.toBeInTheDocument()

    posApiGet.mockResolvedValueOnce(scheduleResponse(closedWeek({ monday: ['08:00-16:00'] })))
    fireEvent.click(screen.getByText('toggle-open'))
    await screen.findByText('Waiting for efood to apply changes; refresh in a few minutes.')
    const restoredMonday = await screen.findByTestId('efood-day-monday')
    expect(within(restoredMonday).getAllByLabelText('From')[0]).toHaveValue('09:00')
    expect(within(restoredMonday).getAllByLabelText('From')[0]).toBeDisabled()
  })

  it('disables saving and loading while offline', async () => {
    posApiGet.mockResolvedValue(scheduleResponse(closedWeek({ monday: ['08:00-16:00'] })))
    render(<Harness />)
    await screen.findByTestId('efood-day-monday')
    fireEvent.click(screen.getByText('toggle-online'))
    expect(screen.getByRole('button', { name: 'Send to efood' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Refresh' })).toBeDisabled()
  })

  it('allows explicit recovery from an unknown write only after reading the current schedule', async () => {
    posApiGet.mockResolvedValue(scheduleResponse(closedWeek({ monday: ['08:00-16:00'] })))
    posApiPost.mockRejectedValue(new Error('timeout'))
    render(<Harness />)
    const monday = await screen.findByTestId('efood-day-monday')
    fireEvent.change(within(monday).getAllByLabelText('From')[0], { target: { value: '09:00' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send to efood' }))
    await screen.findByText('Waiting for efood to apply changes; refresh in a few minutes.')
    expect(screen.queryByText('Discard my changes and reload')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }))
    fireEvent.click(await screen.findByText('Discard my changes and reload'))
    expect(screen.queryByText('Waiting for efood to apply changes; refresh in a few minutes.')).not.toBeInTheDocument()
    expect(within(screen.getByTestId('efood-day-monday')).getAllByLabelText('From')[0]).toHaveValue('08:00')
    expect(posApiPost).toHaveBeenCalledTimes(1)
  })

  it('disables save while the parent platform action is pending', async () => {
    posApiGet.mockResolvedValue(scheduleResponse(closedWeek({ monday: ['08:00-16:00'] })))
    render(<Harness parentActionPending />)
    await screen.findByTestId('efood-day-monday')
    expect(screen.getByRole('button', { name: 'Send to efood' })).toBeDisabled()
  })

  it('disables refresh while a save is in flight', async () => {
    posApiGet.mockResolvedValue(scheduleResponse(closedWeek({ monday: ['08:00-16:00'] })))
    posApiPost.mockReturnValue(new Promise(() => {}))
    render(<Harness />)
    await screen.findByTestId('efood-day-monday')
    fireEvent.click(screen.getByText('Send to efood'))
    await flush()
    expect(screen.getByRole('button', { name: 'Refresh' })).toBeDisabled()
  })
})
