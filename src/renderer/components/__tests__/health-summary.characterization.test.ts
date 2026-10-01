import { describe, expect, it, vi } from 'vitest'

import { DESKTOP_HEALTH_SUMMARY_CASES } from '../../../../../shared/pos/health/__fixtures__/desktop-health-summary-cases'

vi.mock('../OrderSyncRouteIndicator', () => ({ OrderSyncRouteIndicator: () => null }))
vi.mock('../FinancialSyncPanel', () => ({ FinancialSyncPanel: () => null }))
vi.mock('../support/HealthSupportEntryPoint', () => ({ HealthSupportEntryPoint: () => null }))
vi.mock('../recovery/RecoveryCenterPanel', () => ({ RecoveryCenterPanel: () => null }))

import { buildSimpleHealthSummary } from '../SyncStatusIndicator'

/**
 * The Health summary the operator sees, pinned case by case before it moves
 * to shared/pos/health (the shared test runs the same fixture through the
 * port). A case failing here means the desktop's behaviour changed.
 */
describe('desktop Health summary characterization', () => {
  it.each(DESKTOP_HEALTH_SUMMARY_CASES.map((testCase) => [testCase.name, testCase] as const))(
    '%s',
    (_name, testCase) => {
      const summary = buildSimpleHealthSummary(testCase.input as never)
      const { orders, internet, sync, printer, support } = summary.serviceStatuses
      expect({
        state: summary.state,
        canContinueOrders: summary.canContinueOrders,
        guidance: summary.guidance,
        recommendedActions: summary.recommendedActions,
        problem: summary.problem,
        serviceStatuses: { orders, internet, sync, printer, support },
      }).toEqual(testCase.expected)
    },
  )
})
