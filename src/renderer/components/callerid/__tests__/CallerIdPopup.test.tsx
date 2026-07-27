import { render } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  custom: vi.fn(),
  dismiss: vi.fn(),
}))

vi.mock('react-hot-toast', () => ({
  toast: {
    custom: mocks.custom,
    dismiss: mocks.dismiss,
  },
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, fallback: string) => fallback,
  }),
}))

import { showCallerIdToast } from '../CallerIdPopup'

describe('CallerIdPopup display evidence', () => {
  beforeEach(() => {
    mocks.custom.mockClear()
    mocks.dismiss.mockClear()
  })

  it('fires displayed only after the actual toast card commits', () => {
    const onDisplayed = vi.fn()

    showCallerIdToast(
      {
        callerNumber: '+302101234567',
        sipCallId: '20000000-0000-4000-8000-000000000007',
        timestamp: '2026-07-27T10:00:30.000Z',
      },
      {
        onSearchCustomer: vi.fn(),
        onDisplayed,
      },
    )

    expect(onDisplayed).not.toHaveBeenCalled()
    const renderer = mocks.custom.mock.calls[0]?.[0]
    render(renderer({ visible: true }))
    expect(onDisplayed).toHaveBeenCalledTimes(1)
  })
})
