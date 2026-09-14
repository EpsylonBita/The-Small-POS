import React from 'react'
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  useCancellationNotices: vi.fn(),
  playSelectedPlatformSound: vi.fn(),
  playAppAudioTones: vi.fn(),
}))

vi.mock('../../../hooks/useCancellationNotices', () => ({
  useCancellationNotices: mocks.useCancellationNotices,
}))

vi.mock('../../../services/platformNotificationSound', () => ({
  playSelectedPlatformSound: mocks.playSelectedPlatformSound,
}))

vi.mock('../../../services/appAudio', () => ({
  playAppAudioTones: mocks.playAppAudioTones,
}))

vi.mock('react-i18next', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-i18next')>()
  const translation = {
    t: (key: string, fallback?: string | { defaultValue?: string }) =>
      typeof fallback === 'string' ? fallback : fallback?.defaultValue ?? key,
  }
  return { ...actual, useTranslation: () => translation }
})

import { CancellationNoticeManager } from '../CancellationNoticeManager'

vi.mock('../../../contexts/i18n-context', () => ({
  useI18n: () => ({ t: (key: string) => key }),
}))

const baseNotice = {
  id: 'n1',
  order_number: '#1001',
  platform: 'efood',
  external_order_id: null,
  cancelled_at: '2026-09-14T10:00:00.000Z',
}

function mockHook(overrides: Partial<ReturnType<typeof mocks.useCancellationNotices>> = {}) {
  const acknowledge = vi.fn()
  const retry = vi.fn()
  mocks.useCancellationNotices.mockReturnValue({
    current: baseNotice,
    queueLength: 1,
    acknowledging: false,
    acknowledgeFailed: false,
    persistPending: false,
    acknowledge,
    retry,
    ...overrides,
  })
  return { acknowledge, retry }
}

beforeEach(() => {
  vi.clearAllMocks()
  const stopSound = vi.fn()
  mocks.playSelectedPlatformSound.mockReturnValue(stopSound)
})

afterEach(() => {
  cleanup()
})

describe('CancellationNoticeManager', () => {
  it('renders nothing when disabled or there is no current notice', () => {
    mockHook({ current: null, queueLength: 0 })
    const { container } = render(<CancellationNoticeManager enabled />)
    expect(container.firstChild).toBeNull()
  })

  it('shows the notice as a blocking dialog that only dismisses via explicit acknowledge', () => {
    const { acknowledge } = mockHook()
    render(<CancellationNoticeManager enabled />)

    const dialog = screen.getByTestId('cancellation-notice-dialog').closest('[role="dialog"]')
    expect(dialog).toBeTruthy()

    // Escape must not dismiss.
    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    expect(screen.getByTestId('cancellation-notice-dialog')).toBeTruthy()
    expect(acknowledge).not.toHaveBeenCalled()

    // Only the explicit ack button calls acknowledge.
    act(() => {
      screen.getByTestId('cancellation-notice-ack').click()
    })
    expect(acknowledge).toHaveBeenCalledTimes(1)
  })

  it('shows the retry control and blocks acknowledgement while persistence is pending', () => {
    const { acknowledge, retry } = mockHook({ persistPending: true })
    render(<CancellationNoticeManager enabled />)

    expect(screen.queryByTestId('cancellation-notice-ack')).toBeNull()
    const retryButton = screen.getByTestId('cancellation-notice-retry')
    act(() => {
      retryButton.click()
    })
    expect(retry).toHaveBeenCalledTimes(1)
    expect(acknowledge).not.toHaveBeenCalled()
  })

  it('plays the attention sound once per notice becoming current, and stops it on unmount', () => {
    mockHook()
    const { unmount } = render(<CancellationNoticeManager enabled />)
    expect(mocks.playSelectedPlatformSound).toHaveBeenCalledTimes(1)

    unmount()
    const stopSound = mocks.playSelectedPlatformSound.mock.results[0].value as () => void
    expect(stopSound).toHaveBeenCalledTimes(1)
  })

  it('does not replay the sound while the same notice remains current across re-renders', () => {
    mockHook()
    const { rerender } = render(<CancellationNoticeManager enabled />)
    expect(mocks.playSelectedPlatformSound).toHaveBeenCalledTimes(1)

    mockHook({ acknowledging: true })
    rerender(<CancellationNoticeManager enabled />)
    expect(mocks.playSelectedPlatformSound).toHaveBeenCalledTimes(1)
  })

  it('hides the modal and stops sound when disabled while a notice was showing', () => {
    mockHook()
    const { rerender } = render(<CancellationNoticeManager enabled />)
    expect(mocks.playSelectedPlatformSound).toHaveBeenCalledTimes(1)
    const stopSound = mocks.playSelectedPlatformSound.mock.results[0].value as () => void

    mockHook({ current: null, queueLength: 0 })
    rerender(<CancellationNoticeManager enabled={false} />)

    expect(screen.queryByTestId('cancellation-notice-dialog')).toBeNull()
    expect(stopSound).toHaveBeenCalledTimes(1)
  })
})
