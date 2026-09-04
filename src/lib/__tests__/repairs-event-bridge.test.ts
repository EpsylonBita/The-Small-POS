import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  listen: vi.fn(),
  unlisten: vi.fn(),
  handlers: new Map<string, (event: { payload: unknown }) => void>(),
}))

vi.mock('@tauri-apps/api/event', () => ({
  listen: mocks.listen,
}))

vi.mock('../platform-detect', () => ({
  isTauri: () => true,
}))

import { offEvent, onEvent, stopEventBridge } from '../event-bridge'

describe('repairs native event bridge', () => {
  beforeEach(() => {
    mocks.handlers.clear()
    mocks.unlisten.mockReset()
    mocks.listen.mockReset()
    mocks.listen.mockImplementation(async (
      event: string,
      callback: (event: { payload: unknown }) => void,
    ) => {
      mocks.handlers.set(event, callback)
      return mocks.unlisten
    })
  })

  afterEach(() => {
    stopEventBridge()
  })

  it.each([
    'repairs:cache-changed',
    'repairs:conflict',
    'repairs:scope-reset',
    'barcode_scanned_serial',
  ])('identity-maps native %s without changing its payload', async (channel) => {
    const listener = vi.fn()
    const payload = { scopeToken: 'scope-a', marker: channel }

    onEvent(channel, listener)
    await vi.waitFor(() => {
      expect(mocks.listen).toHaveBeenCalledWith(channel, expect.any(Function))
    })

    mocks.handlers.get(channel)?.({ payload })
    expect(listener).toHaveBeenCalledWith(payload)

    offEvent(channel, listener)
    expect(mocks.unlisten).toHaveBeenCalledTimes(1)
  })
})
