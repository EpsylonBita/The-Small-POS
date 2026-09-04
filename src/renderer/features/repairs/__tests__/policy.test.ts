import { describe, expect, it } from 'vitest'

import type { RepairCommand } from '../contracts'
import {
  REPAIR_OFFLINE_COMMANDS,
  REPAIR_OFFLINE_TRANSITION_STATUSES,
  evaluateRepairMutationPolicy,
  isRepairCommandOfflineAllowed,
  validateRepairAttachmentPolicy,
  validateRepairIntakePolicy,
} from '../policy'

const CUSTOMER_ID = '11111111-1111-4111-8111-111111111111'
const DEVICE_ID = '22222222-2222-4222-8222-222222222222'

describe('repair offline policy', () => {
  it('publishes the exact bounded offline command and transition allowlists', () => {
    expect(REPAIR_OFFLINE_COMMANDS).toEqual([
      'create_intake',
      'add_note',
      'assign_repair',
      'update_diagnosis',
      'plan_line',
      'transition_status',
    ])
    expect(REPAIR_OFFLINE_TRANSITION_STATUSES).toEqual([
      'diagnosing',
      'waiting_customer_approval',
      'waiting_parts',
      'repairing',
      'quality_check',
      'ready',
    ])
  })

  it('allows only diagnosis drafts and the exact safe transition targets', () => {
    expect(isRepairCommandOfflineAllowed({
      command: 'update_diagnosis',
      payload: { diagnosis: 'Draft', draft: true },
    })).toBe(true)
    expect(isRepairCommandOfflineAllowed({
      command: 'update_diagnosis',
      payload: { diagnosis: 'Final', draft: false },
    })).toBe(false)

    for (const target_status of REPAIR_OFFLINE_TRANSITION_STATUSES) {
      expect(isRepairCommandOfflineAllowed({
        command: 'transition_status',
        payload: { target_status, reason: null, remain_consumed: false },
      })).toBe(true)
    }

    for (const target_status of ['received', 'approved', 'delivered', 'cancelled', 'unrepairable']) {
      expect(isRepairCommandOfflineAllowed({
        command: 'transition_status',
        payload: { target_status, reason: null, remain_consumed: false },
      } as RepairCommand)).toBe(false)
    }
  })

  it('fails closed for every online-only or unknown command', () => {
    for (const command of [
      'reopen_repair',
      'consume_nonstock_part',
      'reverse_nonstock_part',
      'consume_repair_part',
      'reverse_repair_part',
      'create_estimate',
      'record_approval',
      'transfer_branch',
      'collect_payment',
      '',
    ]) {
      expect(isRepairCommandOfflineAllowed({ command, payload: {} })).toBe(false)
    }
    expect(isRepairCommandOfflineAllowed(null)).toBe(false)
  })

  it('makes connectivity, capability and active-shift decisions fail closed', () => {
    const offlineSafe = {
      command: 'add_note',
      payload: { note: 'Checked', visibility: 'internal' },
    } satisfies RepairCommand
    const onlineOnly = {
      command: 'record_approval',
      payload: {
        approval_id: '33333333-3333-4333-8333-333333333333',
        estimate_id: null,
        decision: 'accepted',
        decision_source: 'in_person',
        reason: null,
      },
    } satisfies RepairCommand

    expect(evaluateRepairMutationPolicy({
      connectivity: 'unknown',
      command: offlineSafe,
      hasCapability: true,
      hasActiveShift: true,
    })).toEqual({ allowed: false, code: 'REPAIR_CONNECTIVITY_UNKNOWN' })
    expect(evaluateRepairMutationPolicy({
      connectivity: 'degraded' as never,
      command: offlineSafe,
      hasCapability: true,
      hasActiveShift: true,
    })).toEqual({ allowed: false, code: 'REPAIR_CONNECTIVITY_UNKNOWN' })
    expect(evaluateRepairMutationPolicy({
      connectivity: 'offline',
      command: onlineOnly,
      hasCapability: true,
      hasActiveShift: true,
    })).toEqual({ allowed: false, code: 'REPAIR_COMMAND_ONLINE_REQUIRED' })
    expect(evaluateRepairMutationPolicy({
      connectivity: 'offline',
      command: offlineSafe,
      hasCapability: true,
      hasActiveShift: true,
    })).toEqual({ allowed: true })
    expect(evaluateRepairMutationPolicy({
      connectivity: 'online',
      command: onlineOnly,
      hasCapability: false,
      hasActiveShift: true,
    })).toEqual({ allowed: false, code: 'REPAIR_CAPABILITY_REQUIRED' })
    expect(evaluateRepairMutationPolicy({
      connectivity: 'online',
      command: onlineOnly,
      hasCapability: true,
      hasActiveShift: undefined,
    })).toEqual({ allowed: false, code: 'REPAIR_ACTIVE_SHIFT_REQUIRED' })
    expect(evaluateRepairMutationPolicy({
      connectivity: 'online',
      command: onlineOnly,
      hasCapability: true,
      hasActiveShift: true,
    })).toEqual({ allowed: true })
    expect(evaluateRepairMutationPolicy({
      connectivity: 'online',
      command: { command: 'future_unknown', payload: {} },
      hasCapability: true,
      hasActiveShift: true,
    })).toEqual({ allowed: false, code: 'REPAIR_COMMAND_UNKNOWN' })
  })
})

describe('repair intake policy', () => {
  it('requires canonical customer and device for standard repairs', () => {
    expect(validateRepairIntakePolicy({
      intakeMode: 'standard',
      isAnonymous: false,
      customerId: CUSTOMER_ID,
      customerDeviceId: DEVICE_ID,
    }, null)).toEqual({ ok: true })

    expect(validateRepairIntakePolicy({
      intakeMode: 'standard',
      isAnonymous: false,
      customerId: CUSTOMER_ID,
      customerDeviceId: null,
    }, null)).toEqual({ ok: false, code: 'REPAIR_STANDARD_DEVICE_REQUIRED' })

    expect(validateRepairIntakePolicy({
      intakeMode: 'standard',
      isAnonymous: true,
      customerId: null,
      customerDeviceId: null,
    }, null)).toEqual({ ok: false, code: 'REPAIR_STANDARD_ANONYMOUS_FORBIDDEN' })
  })

  it('gates Quick Service on loaded settings and keeps anonymous references empty', () => {
    const anonymousQuickService = {
      intakeMode: 'quick_service' as const,
      isAnonymous: true,
      customerId: null,
      customerDeviceId: null,
    }

    expect(validateRepairIntakePolicy(anonymousQuickService, null)).toEqual({
      ok: false,
      code: 'REPAIR_SETTINGS_REQUIRED',
    })
    expect(validateRepairIntakePolicy(anonymousQuickService, { quickServiceEnabled: false })).toEqual({
      ok: false,
      code: 'REPAIR_QUICK_SERVICE_DISABLED',
    })
    expect(validateRepairIntakePolicy(anonymousQuickService, { quickServiceEnabled: true })).toEqual({ ok: true })
    expect(validateRepairIntakePolicy({
      ...anonymousQuickService,
      customerId: CUSTOMER_ID,
    }, { quickServiceEnabled: true })).toEqual({
      ok: false,
      code: 'REPAIR_ANONYMOUS_REFERENCES_FORBIDDEN',
    })
  })

  it('requires a canonical customer but allows an optional device for linked Quick Service', () => {
    expect(validateRepairIntakePolicy({
      intakeMode: 'quick_service',
      isAnonymous: false,
      customerId: CUSTOMER_ID,
      customerDeviceId: null,
    }, { quickServiceEnabled: true })).toEqual({ ok: true })
    expect(validateRepairIntakePolicy({
      intakeMode: 'quick_service',
      isAnonymous: false,
      customerId: null,
      customerDeviceId: DEVICE_ID,
    }, { quickServiceEnabled: true })).toEqual({
      ok: false,
      code: 'REPAIR_QUICK_SERVICE_CUSTOMER_REQUIRED',
    })
  })
})

describe('repair attachment policy', () => {
  const policy = {
    maxBytes: 5,
    allowedMimeTypes: ['image/jpeg', 'image/png'],
  }

  it('accepts only non-empty photos within the loaded settings policy', () => {
    expect(validateRepairAttachmentPolicy({ mimeType: 'image/jpeg', byteSize: 5 }, policy)).toEqual({ ok: true })
    expect(validateRepairAttachmentPolicy({ mimeType: 'image/jpeg', byteSize: 6 }, policy)).toEqual({
      ok: false,
      code: 'REPAIR_ATTACHMENT_TOO_LARGE',
    })
    expect(validateRepairAttachmentPolicy({ mimeType: 'image/gif', byteSize: 1 }, policy)).toEqual({
      ok: false,
      code: 'REPAIR_ATTACHMENT_MIME_NOT_ALLOWED',
    })
    expect(validateRepairAttachmentPolicy({ mimeType: 'image/jpeg', byteSize: 0 }, policy)).toEqual({
      ok: false,
      code: 'REPAIR_ATTACHMENT_EMPTY',
    })
  })

  it('fails closed until attachment settings are loaded', () => {
    expect(validateRepairAttachmentPolicy({ mimeType: 'image/jpeg', byteSize: 1 }, null)).toEqual({
      ok: false,
      code: 'REPAIR_ATTACHMENT_POLICY_REQUIRED',
    })
  })
})
