import React from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WorkCardNoticeManager } from '../WorkCardNoticeManager'
const mocks = vi.hoisted(() => ({
  custom: vi.fn(), remove: vi.fn(), scope: '', main: true, enabled: true, count: 2,
  reader: vi.fn(),
}))
vi.mock('react-hot-toast', () => ({ toast: { custom: mocks.custom, remove: mocks.remove } }))
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string, options?: { count: number }) => `${key}:${options?.count ?? ''}` }) }))
vi.mock('../../../hooks/useFeatures', () => ({ useFeatures: () => ({ loading: false, isMainTerminal: mocks.main, isMobileWaiter: !mocks.main, parentTerminalId: mocks.main ? null : 'parent' }) }))
vi.mock('../../../hooks/useWorkCardStatus', () => ({ useWorkCardStatus: (...args: unknown[]) => {
  mocks.reader(...args)
  return { data: mocks.enabled ? { enabled: true, attention_count: mocks.count } : { enabled: false }, offline: false, scope: mocks.scope }
} }))
beforeEach(() => {
  vi.useFakeTimers(); mocks.scope = `scope-${Math.random()}`; mocks.main = true; mocks.enabled = true; mocks.count = 2
})
afterEach(() => { cleanup(); vi.clearAllTimers(); vi.useRealTimers() })
describe('Main work card notice', () => {
  it('shows a solid notice and dismisses it for one hour', () => {
    const manager = render(<WorkCardNoticeManager enabled />)
    expect(mocks.reader).toHaveBeenLastCalledWith(true, [], true)
    const notice = render(mocks.custom.mock.calls.at(-1)![0]())
    expect(screen.getByText('workCard.attention:2')).toBeTruthy()
    expect(screen.getByTestId('work-card-notice').className).toContain('bg-white')
    fireEvent.click(screen.getByText('workCard.dismiss:'))
    const before = mocks.custom.mock.calls.length
    act(() => vi.advanceTimersByTime(60 * 60_000 - 1))
    expect(mocks.custom).toHaveBeenCalledTimes(before)
    act(() => vi.advanceTimersByTime(1))
    expect(mocks.custom).toHaveBeenCalledTimes(before + 1)
    notice.unmount(); manager.unmount()
  })
  it('does not show on a phone, disabled branch, or zero attention count', () => {
    mocks.main = false
    const hook = render(<WorkCardNoticeManager enabled />)
    expect(mocks.reader).toHaveBeenLastCalledWith(false, [], true)
    expect(mocks.custom).not.toHaveBeenCalled()
    mocks.main = true; mocks.enabled = false
    hook.rerender(<WorkCardNoticeManager enabled />)
    expect(mocks.custom).not.toHaveBeenCalled()
    mocks.enabled = true; mocks.count = 0
    hook.rerender(<WorkCardNoticeManager enabled />)
    expect(mocks.custom).not.toHaveBeenCalled()
  })
})
