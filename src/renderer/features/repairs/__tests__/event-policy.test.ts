import { describe, expect, it } from 'vitest'

import { shouldRefetchForRepairCacheReason } from '../event-policy'

describe('repair cache event refetch policy', () => {
  it('does not feed authoritative read events back into the same read commands', () => {
    expect(shouldRefetchForRepairCacheReason('authoritative_list')).toBe(false)
    expect(shouldRefetchForRepairCacheReason('authoritative_workspace')).toBe(false)
  })

  it('refetches only the bounded mutation reasons', () => {
    expect(shouldRefetchForRepairCacheReason('authoritative_command')).toBe(true)
    expect(shouldRefetchForRepairCacheReason('offline_command_queued')).toBe(true)
    expect(shouldRefetchForRepairCacheReason('attachment_queued')).toBe(true)
    expect(shouldRefetchForRepairCacheReason('conflict_resolved')).toBe(true)
    expect(shouldRefetchForRepairCacheReason('sync_reconciled')).toBe(false)
  })
})
