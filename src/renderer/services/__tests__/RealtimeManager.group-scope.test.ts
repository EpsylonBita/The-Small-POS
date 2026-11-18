import { describe, expect, it, vi } from 'vitest'
import { DesktopRealtimeManager } from '../RealtimeManager'

describe('group and store realtime boundaries', () => {
  it('invalidates shared data only for its group and keeps orders store filtered', async () => {
    const listeners = new Map<string, (payload: any) => void>()
    const filters = new Map<string, string>()
    const client = {
      channel: vi.fn((_name: string) => {
        const channel = {
          on: vi.fn((_event, config, listener) => {
            listeners.set(config.table, listener)
            filters.set(config.table, config.filter)
            return channel
          }),
          subscribe: vi.fn().mockReturnThis(),
        }
        return channel
      }),
      removeChannel: vi.fn(),
    }
    const onSharedDataChange = vi.fn()
    const onOrderChange = vi.fn()
    const manager = new DesktopRealtimeManager({
      supabaseUrl: 'https://realtime.invalid', supabaseKey: 'public',
      organizationId: 'org', branchId: 'store', terminalId: 'till', groupKey: 'first',
      onSharedDataChange, onOrderChange, onConfigChange: vi.fn(), onModuleChange: vi.fn(), client: client as any,
    })
    await manager.connect()
    expect(client.channel.mock.calls.every(call => String(call[0]).includes('first-store-till'))).toBe(true)
    expect(filters.get('orders')).toBe('branch_id=eq.store')
    expect(filters.get('customers')).toBe('organization_id=eq.org')
    listeners.get('customers')!({new: {group_id: 'second'}})
    expect(onSharedDataChange).not.toHaveBeenCalled()
    listeners.get('customers')!({new: {group_id: 'first'}})
    expect(onSharedDataChange).toHaveBeenCalledTimes(1)
    listeners.get('customers')!({eventType: 'DELETE', old: {id: 'deleted'}})
    expect(onSharedDataChange).toHaveBeenCalledTimes(2)
    listeners.get('orders')!({new: {branch_id: 'other-store'}})
    expect(onOrderChange).not.toHaveBeenCalled()
    manager.disconnect()
    listeners.get('customers')!({new: {group_id: 'first'}})
    expect(onSharedDataChange).toHaveBeenCalledTimes(2)
  })
})
