import { describe, expect, it } from 'vitest'
import en from '../../../../locales/en.json'
import el from '../../../../locales/el.json'
import de from '../../../../locales/de.json'
import fr from '../../../../locales/fr.json'
import italian from '../../../../locales/it.json'

const requiredRepairKeys = [
  'title',
  'subtitle',
  'searchLabel',
  'searchPlaceholder',
  'filters.status',
  'filters.priority',
  'filters.due',
  'filters.sync',
  'tabs.overview',
  'tabs.diagnosis',
  'tabs.partsLabour',
  'tabs.estimateApproval',
  'tabs.timeline',
  'tabs.photos',
  'tabs.payments',
  'tabs.communication',
  'status.received',
  'status.diagnosing',
  'status.waiting_customer_approval',
  'status.approved',
  'status.waiting_parts',
  'status.repairing',
  'status.quality_check',
  'status.ready',
  'status.delivered',
  'status.cancelled',
  'status.unrepairable',
  'priority.low',
  'priority.normal',
  'priority.high',
  'priority.urgent',
  'intake.standard',
  'intake.quickService',
  'intake.anonymous',
  'intake.customerSearch',
  'intake.searchCustomers',
  'intake.newDevice',
  'intake.saveDevice',
  'sync.synced',
  'sync.pending',
  'sync.conflict',
  'sync.needs_refetch',
  'messages.readyQueued',
  'messages.noNotificationSent',
  'messages.offline',
  'messages.onlineActionRequired',
  'messages.finalDiagnosisOnline',
  'messages.photoUnavailable',
  'messages.attachmentOpenFailed',
  'messages.secureIdUnavailable',
  'messages.assignmentUnavailable',
  'actions.operations',
  'actions.changeStatus',
  'actions.assignToMe',
  'actions.unassign',
  'actions.transitionReason',
  'actions.remainConsumed',
  'actions.finalizeDiagnosis',
  'actions.consumePart',
  'actions.reversePart',
  'actions.reversalReason',
  'actions.lineName',
  'actions.sku',
  'actions.createEstimate',
  'actions.openAttachment',
  'fields.assigned',
  'locked.communication',
  'locked.money',
  'locked.catalog',
  'locked.attachmentOpen',
  'locked.printing',
  'locked.approvalTransition',
  'locked.assignment',
  'locked.stockReversal',
  'a11y.resultsUpdated',
  'a11y.currentRepair',
] as const

function readKey(value: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((current, segment) => {
    if (!current || typeof current !== 'object') return undefined
    return (current as Record<string, unknown>)[segment]
  }, value)
}

describe.each([
  ['en', en],
  ['el', el],
  ['de', de],
  ['fr', fr],
  ['it', italian],
])('%s repair locale', (_locale, bundle) => {
  it.each(requiredRepairKeys)('defines repairs.%s as visible copy', (key) => {
    const value = readKey((bundle as Record<string, unknown>).repairs, key)
    expect(typeof value).toBe('string')
    expect((value as string).trim().length).toBeGreaterThan(0)
  })
})
