import { act, renderHook, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { useResolvedWoltApproval } from '../useResolvedWoltApproval'

const waiting = { id: 'wolt-one', plugin: 'wolt', status: 'pending' }
const resolved = { ...waiting, status: 'confirmed' }

describe('approval panel after another terminal decides a Wolt order', () => {
  it('closes after the local database confirms the exact order left the queue', async () => {
    const read = vi.fn().mockResolvedValue(resolved)
    const close = vi.fn()
    renderHook(() => useResolvedWoltApproval(waiting, [resolved], [], read, close))
    await waitFor(() => expect(close).toHaveBeenCalledTimes(1))
    expect(read).toHaveBeenCalledWith(waiting.id)
  })

  it('keeps pending orders, empty snapshots, view-only panels and other platforms untouched', () => {
    const read = vi.fn()
    const close = vi.fn()
    renderHook(() => {
      useResolvedWoltApproval(waiting, [resolved], [waiting], read, close)
      useResolvedWoltApproval(waiting, [], [], read, close)
      useResolvedWoltApproval(null, [resolved], [], read, close)
      useResolvedWoltApproval({ ...waiting, id: 'other' }, [resolved], [], read, close)
      useResolvedWoltApproval({ ...waiting, ...{plugin: 'box'} }, [resolved], [], read, close)
    })
    expect(read).not.toHaveBeenCalled()
    expect(close).not.toHaveBeenCalled()
  })

  it('retains the panel if a refreshed queue disagrees with storage or another alert opens', async () => {
    let resolve!: (row: typeof resolved) => void
    const read = vi.fn().mockResolvedValueOnce(waiting)
      .mockImplementationOnce(() => new Promise(done => { resolve = done }))
    const close = vi.fn()
    const { rerender } = renderHook(({orders, pending}) => useResolvedWoltApproval(waiting, orders, pending, read, close),
      { initialProps: { orders: [resolved], pending: [] as typeof waiting[] } })
    await act(async () => {})
    expect(close).not.toHaveBeenCalled()
    rerender({ orders: [{ ...resolved }], pending: [] })
    rerender({ orders: [waiting], pending: [waiting] })
    await act(async () => { resolve(resolved) })
    expect(close).not.toHaveBeenCalled()
  })
})
