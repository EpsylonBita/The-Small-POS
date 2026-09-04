import { describe, expect, expectTypeOf, it } from 'vitest'

import {
  REPAIR_ATTACHMENT_RETENTION_STATES,
  REPAIR_CUSTOMER_NOTIFICATION_STATES,
  REPAIR_SYNC_STATES,
  type RepairApprovalSnapshot,
  type RepairCommand,
} from '../contracts'

describe('frozen repair renderer contracts', () => {
  it('keeps the exact native sync-state vocabulary', () => {
    expect(REPAIR_SYNC_STATES).toEqual([
      'synced',
      'queued',
      'conflict',
      'needs_refetch',
    ])
  })

  it('keeps the exact native notification-state vocabulary', () => {
    expect(REPAIR_CUSTOMER_NOTIFICATION_STATES).toEqual([
      'queued_after_sync',
      'server_event_pending',
      'not_requested',
    ])
  })

  it('keeps every attachment retention state accepted by the database', () => {
    expect(REPAIR_ATTACHMENT_RETENTION_STATES).toEqual([
      'active',
      'legal_hold',
      'pending_deletion',
      'deleted',
    ])
  })

  it('narrows approval decisions to the canonical server vocabulary', () => {
    type ApprovalCommand = Extract<RepairCommand, { command: 'record_approval' }>

    expectTypeOf<RepairApprovalSnapshot['decision']>()
      .toEqualTypeOf<'accepted' | 'rejected'>()
    expectTypeOf<ApprovalCommand['payload']['decision']>()
      .toEqualTypeOf<'accepted' | 'rejected'>()
  })
})
