import React from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import i18next from 'i18next'
import { I18nextProvider } from 'react-i18next'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { UnsettledPaymentBlocker } from '../../../../lib/ipc-contracts'
import { localeBundles } from '../../../../locales/bundles'
import { UnsettledPaymentBlockersPanel } from '../UnsettledPaymentBlockersPanel'

const panelAndMissingPaymentKeys = [
  'modals.staffShift.paymentIntegrityTitle',
  'modals.staffShift.paymentIntegrityHelper',
  'modals.zReport.paymentIntegrityTitle',
  'modals.zReport.paymentIntegrityResolveHelper',
  'modals.staffShift.paymentRecordFailed',
  'modals.staffShift.paymentRepairRecorded',
  'modals.staffShift.cashierCloseRefused',
  'modals.staffShift.cashierCloseApprovalRequired',
  'modals.zReport.recordPaymentFailed',
  'modals.zReport.loadFailed',
  'modals.zReport.recordPaymentReloadFailed',
  'paymentIntegrity.blockersTitle',
  'paymentIntegrity.blockersHelper',
  'paymentIntegrity.blockerReasonFallback',
  'paymentIntegrity.blockerFixFallback',
  'paymentIntegrity.orderNumberFallback',
  'paymentIntegrity.blockerReasonFallbackWithoutNumber',
  'paymentIntegrity.multipleOrdersSummaryWithoutNumber',
  'paymentIntegrity.multipleOrdersSummary',
  'paymentIntegrity.methods.unknown',
  'paymentIntegrity.statuses.unknown',
  'paymentIntegrity.reasonLabel',
  'paymentIntegrity.fixLabel',
  'paymentIntegrity.totalLabel',
  'paymentIntegrity.settledLabel',
  'paymentIntegrity.outstandingLabel',
  'paymentIntegrity.recordFailureCurrency',
  'paymentIntegrity.recordFailureStale',
  'paymentIntegrity.recordFailureStaleCheckout',
  'paymentIntegrity.reasonCodes.no_persisted_payment',
  'paymentIntegrity.fixCodes.no_persisted_payment',
  'paymentIntegrity.reasonCodes.missing_local_payment_row',
  'paymentIntegrity.fixCodes.missing_local_payment_row',
]

const platformPaymentKeys = [
  'paymentIntegrity.reasonCodes.platform_settlement_missing',
  'paymentIntegrity.reasonCodes.platform_settlement_mismatch__platform_holds',
  'paymentIntegrity.reasonCodes.platform_settlement_mismatch__store_collects',
  'paymentIntegrity.reasonCodes.platform_settlement_mismatch__store_collects_platform_order',
  'paymentIntegrity.fixCodes.platform_settlement_missing',
  'paymentIntegrity.fixCodes.payments_need_review__platform_held',
]

const otherFindingKeys = [
  'paymentIntegrity.reasonCodes.table_cancellation_not_saved__refused',
  'paymentIntegrity.fixCodes.payments_need_review',
  'paymentIntegrity.reasonCodes.payments_need_review__reconciliation_required',
  'paymentIntegrity.reasonCodes.cancelled_order_claims_payment',
  'paymentIntegrity.fixCodes.cancelled_order_claims_payment',
  'paymentIntegrity.fixCodes.duplicate_payment',
  'paymentIntegrity.fixCodes.overpaid_order',
  'paymentIntegrity.reasonCodes.platform_settlement_mismatch',
  'paymentIntegrity.fixCodes.platform_settlement_mismatch',
  'paymentIntegrity.fixCodes.platform_settlement_mismatch__platform_holds',
  'paymentIntegrity.fixCodes.platform_settlement_mismatch__store_collects',
  'paymentIntegrity.fixCodes.platform_settlement_mismatch__store_collects_platform_order',
]

const technicalWording =
  /(?<![\p{L}\p{N}_])(?:payment rows?|rows?|ledgers?|mirrors?|servers?|sync|serveurs?)(?![\p{L}\p{N}_])|διακομιστ|συγχρονισμ|εγγραφή πληρωμής|synchron|sinkroniz|sincronizz/iu

const platformTechnicalWording = /settl(?:e|es|ed|ement)|εκκαθάρισ|εξοφλ|έσοδο πλατφόρμας|abrechn|plattformerlös|règlement|argent réglé|sald[ao]|shl(?:ye|yej|yer)|xhiro/iu

const placeholdersByKey: Record<string, string[]> = {
  'modals.staffShift.paymentRecordFailed': ['{{button}}'],
  'modals.staffShift.paymentRepairRecorded': ['{{method}}', '{{orderNumber}}'],
  'modals.zReport.recordPaymentFailed': ['{{button}}'],
  'paymentIntegrity.blockerReasonFallback': ['{{orderNumber}}'],
  'paymentIntegrity.multipleOrdersSummaryWithoutNumber': ['{{count}}', '{{reason}}'],
  'paymentIntegrity.multipleOrdersSummary': ['{{count}}', '{{orderNumber}}', '{{reason}}'],
  'paymentIntegrity.reasonCodes.no_persisted_payment': ['{{orderNumber}}'],
  'paymentIntegrity.reasonCodes.missing_local_payment_row': ['{{orderNumber}}'],
  'paymentIntegrity.reasonCodes.platform_settlement_mismatch': ['{{orderNumber}}'],
  'paymentIntegrity.reasonCodes.platform_settlement_missing': ['{{orderNumber}}', '{{totalAmount}}'],
  'paymentIntegrity.reasonCodes.platform_settlement_mismatch__platform_holds': ['{{drawerAmount}}', '{{orderNumber}}'],
  'paymentIntegrity.reasonCodes.platform_settlement_mismatch__store_collects': ['{{orderNumber}}', '{{platformSettledAmount}}'],
  'paymentIntegrity.reasonCodes.platform_settlement_mismatch__store_collects_platform_order': ['{{orderNumber}}', '{{platformSettledAmount}}'],
  'paymentIntegrity.reasonCodes.payments_need_review__reconciliation_required': [
    '{{orderNumber}}', '{{paymentAmount}}', '{{paymentMethod}}',
  ],
}

const lookup = (bundle: Record<string, unknown>, key: string): unknown =>
  key.split('.').reduce<unknown>(
    (value, part) =>
      value && typeof value === 'object' ? (value as Record<string, unknown>)[part] : undefined,
    bundle,
  )

const futureBlocker: UnsettledPaymentBlocker = {
  orderId: 'order-future-reason',
  orderNumber: 'A-0404',
  totalAmount: 13,
  settledAmount: 0,
  paymentStatus: 'pending',
  paymentMethod: 'cash',
  reasonCode: 'future_payment_reason',
  reasonText: 'Native payment row reason.',
  suggestedFix: 'Native ledger repair instruction.',
  severity: 'blocking',
}

describe.each(Object.entries(localeBundles))('Payment blocker wording in %s', (_locale, bundle) => {
  it.each([...panelAndMissingPaymentKeys, ...otherFindingKeys, ...platformPaymentKeys])('translates %s with the expected placeholders', (key) => {
    const value = lookup(bundle, key)
    expect(typeof value === 'string' && value.trim()).toBeTruthy()
    expect(value).not.toBe(key)
    expect((String(value).match(/\{\{[^{}]+\}\}/g) ?? []).sort()).toEqual(placeholdersByKey[key] ?? [])
  })

  it.each(panelAndMissingPaymentKeys)('uses staff wording for %s', (key) => {
    expect(String(lookup(bundle, key))).not.toMatch(technicalWording)
  })

  it.each(platformPaymentKeys)('uses everyday payment wording for %s', (key) => {
    const wording = String(lookup(bundle, key)).replace(/\{\{[^{}]+\}\}/g, '')
    expect(wording).not.toMatch(technicalWording)
    expect(wording).not.toMatch(platformTechnicalWording)
  })

  it('names the existing refresh control on both load failure messages', () => {
    const refresh = lookup(bundle, 'modals.zReport.refresh')
    expect(lookup(bundle, 'modals.zReport.loadFailed')).toContain(refresh)
    expect(lookup(bundle, 'modals.zReport.recordPaymentReloadFailed')).toContain(refresh)
  })

  it('uses plain words for the original payment and the Review totals, sources and missing payment', () => {
    for (const key of [
      'paymentIntegrity.statuses.waiting_parent',
      'modals.zReport.paymentCoverage',
      'modals.zReport.reconciliationUnclassifiedSources',
      'modals.zReport.reconciliationUnclassifiedSource',
      'modals.zReport.reconciliationReason.missing_local_payment_row',
    ]) {
      const value = lookup(bundle, key)
      expect(typeof value === 'string' && value.trim()).toBeTruthy()
      expect(value).not.toMatch(technicalWording)
    }
    expect(lookup(bundle, 'paymentIntegrity.statuses.waiting_parent')).not.toMatch(
      /γονικ|\bparent\b|übergeordnete|pagamento padre/iu,
    )
  })
})

describe('UnsettledPaymentBlockersPanel text for a new reason code', () => {
  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it.each([
    [
      'el',
      'Η πληρωμή της παραγγελίας A-0404 χρειάζεται έλεγχο.',
      'Ενημερώστε τον υπεύθυνο. Αν το πρόβλημα παραμένει, καλέστε την υποστήριξη.',
    ],
    [
      'de',
      'Die Zahlung für Bestellung A-0404 muss geprüft werden.',
      'Informieren Sie die Filialleitung. Wenn das Problem weiterhin besteht, wenden Sie sich an den Support.',
    ],
  ] as const)('shows both localized fallbacks and logs the blocker once in %s', async (lng, reason, fix) => {
    const blocker = futureBlocker
    const i18n = i18next.createInstance()
    await i18n.init({
      lng,
      fallbackLng: 'en',
      resources: {
        [lng]: { translation: localeBundles[lng] },
        en: { translation: localeBundles.en },
      },
      interpolation: { escapeValue: false },
    })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const warning = '[UnsettledPaymentBlockersPanel] Missing localized blocker wording:'

    const view = (blockers: UnsettledPaymentBlocker[]) => (
      <I18nextProvider i18n={i18n}>
        <UnsettledPaymentBlockersPanel blockers={blockers} />
      </I18nextProvider>
    )
    const { rerender } = render(view([blocker]))

    expect(screen.getByText(reason)).toBeInTheDocument()
    expect(screen.getByText(fix)).toBeInTheDocument()
    expect(document.body).not.toHaveTextContent(blocker.reasonText)
    expect(document.body).not.toHaveTextContent(blocker.suggestedFix)
    const warnings = () => warn.mock.calls.filter(([message]) => message === warning)
    expect(warnings()).toEqual([
      [warning, expect.objectContaining({
        orderId: blocker.orderId,
        reasonCode: blocker.reasonCode,
        reasonText: blocker.reasonText,
        suggestedFix: blocker.suggestedFix,
      })],
    ])
    rerender(view([{ ...blocker }]))
    expect(warnings()).toHaveLength(1)
    const changed = { ...blocker, reasonText: 'Updated native reason.' }
    rerender(view([changed]))
    expect(warnings()).toHaveLength(2)
    expect(warnings()[1]?.[1]).toMatchObject({ orderId: changed.orderId, reasonText: changed.reasonText })

    const other = { ...blocker, orderId: 'o2', orderNumber: 'A-0405' }
    rerender(view([changed, other]))
    expect(warnings()).toHaveLength(3)
    rerender(view([other]))
    expect(warnings()).toHaveLength(3)
    rerender(view([changed, other]))
    expect(warnings()).toHaveLength(4)
    expect(warnings()[3]?.[1]).toMatchObject({ orderId: changed.orderId, reasonText: changed.reasonText })
  })

  it.each(Object.keys(localeBundles) as (keyof typeof localeBundles)[])(
    'shows room, refund and generic badges without raw values in %s',
    async (lng) => {
      const bundle = localeBundles[lng]
      const i18n = i18next.createInstance()
      await i18n.init({ lng, resources: { [lng]: { translation: bundle } }, interpolation: { escapeValue: false } })
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const known = { ...futureBlocker, reasonCode: 'no_persisted_payment', paymentMethod: 'room_charge', paymentStatus: 'refunded' }
      const unknown = { ...known, orderId: 'order-unknown-labels', orderNumber: 'A-0405',
        paymentMethod: 'future_tender_code', paymentStatus: 'future_status_code' }
      const view = (unknownBlocker = unknown) => (
        <I18nextProvider i18n={i18n}>
          <UnsettledPaymentBlockersPanel blockers={[known, { ...unknownBlocker }]} />
        </I18nextProvider>
      )
      const { rerender } = render(view())

      for (const key of ['methods.room_charge', 'methods.unknown', 'statuses.refunded', 'statuses.unknown']) {
        expect(screen.getByText(String(lookup(bundle, `paymentIntegrity.${key}`)))).toBeInTheDocument()
      }
      expect(document.body.textContent).not.toMatch(/room_charge|\brefunded\b|future_tender_code|future_status_code/u)
      rerender(view())
      const warning = '[UnsettledPaymentBlockersPanel] Unrecognized payment detail:'
      const detailWarnings = () => warn.mock.calls.filter(([message]) => message === warning)
      expect(detailWarnings()).toEqual([
        [warning, {
          orderId: unknown.orderId, field: 'paymentMethod', value: unknown.paymentMethod,
        }],
        [warning, {
          orderId: unknown.orderId, field: 'paymentStatus', value: unknown.paymentStatus,
        }],
      ])
      rerender(view({ ...unknown, paymentMethod: 'other_tender' }))
      expect(detailWarnings().slice(2)).toEqual([
        [warning, { orderId: unknown.orderId, field: 'paymentMethod', value: 'other_tender' }],
      ])
    },
  )

  it('uses a localized heading and reason when the order number holds an internal ID', async () => {
    const i18n = i18next.createInstance()
    await i18n.init({ lng: 'el', resources: { el: { translation: localeBundles.el } }, interpolation: { escapeValue: false } })
    const blocker = { ...futureBlocker, orderNumber: futureBlocker.orderId, reasonCode: 'no_persisted_payment' }
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    render(
      <I18nextProvider i18n={i18n}>
        <UnsettledPaymentBlockersPanel blockers={[blocker]} />
      </I18nextProvider>,
    )
    expect(screen.getByText('Χωρίς αριθμό παραγγελίας')).toBeInTheDocument()
    expect(screen.getByText('Η πληρωμή αυτής της παραγγελίας χρειάζεται έλεγχο.')).toBeInTheDocument()
    expect(document.body).not.toHaveTextContent(blocker.orderId)
    expect(warn).toHaveBeenCalledWith('[UnsettledPaymentBlockersPanel] Unrecognized payment detail:', {
      orderId: blocker.orderId, field: 'orderNumber', value: blocker.orderId,
    })
  })
})

describe('UnsettledPaymentBlockersPanel driver checkout note', () => {
  afterEach(cleanup)

  it('renders the same blocker with or without a legacy driver checkout note', async () => {
    const i18n = i18next.createInstance()
    await i18n.init({ lng: 'el', resources: { el: { translation: localeBundles.el } }, interpolation: { escapeValue: false } })
    const blocker = { ...futureBlocker, reasonCode: 'no_persisted_payment' }
    const withLegacyNote = {
      ...blocker,
      driverCheckoutNote: { driverShiftId: 's1', driverStaffId: 'd1', driverName: 'Μαρία', amountCents: 1140 },
    }
    const panel = (row: UnsettledPaymentBlocker) => (
      <I18nextProvider i18n={i18n}>
        <UnsettledPaymentBlockersPanel blockers={[row]} />
      </I18nextProvider>
    )
    const view = render(panel(blocker))
    const original = view.container.innerHTML
    view.rerender(panel(withLegacyNote))
    expect(view.container.innerHTML).toBe(original)
    expect(screen.queryByText(/Μαρία|driverCheckoutNote/)).toBeNull()
  })
})
