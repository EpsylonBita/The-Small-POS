import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'

const localeNames = ['en', 'el', 'de', 'fr', 'it'] as const
const projectRoot = process.cwd()
const localesRoot = path.resolve(projectRoot, 'src', 'locales')

type JsonObject = Record<string, unknown>

const isObject = (value: unknown): value is JsonObject =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)

const readLocale = (locale: string): JsonObject =>
  JSON.parse(fs.readFileSync(path.join(localesRoot, `${locale}.json`), 'utf8')) as JsonObject

const at = (root: JsonObject, dottedPath: string): unknown =>
  dottedPath.split('.').reduce<unknown>((current, segment) =>
    isObject(current) ? current[segment] : undefined, root)

const leafEntries = (value: unknown, prefix = ''): Array<[string, unknown]> => {
  if (!isObject(value)) return [[prefix, value]]
  return Object.entries(value).flatMap(([key, nested]) =>
    leafEntries(nested, prefix ? `${prefix}.${key}` : key))
}

const interpolationTokens = (value: string): string[] =>
  [...value.matchAll(/{{\s*([A-Za-z0-9_]+)\s*}}/g)].map((match) => match[1]).sort()

const staticSourceKeys = (sourcePath: string, prefix: string): string[] => {
  const source = fs.readFileSync(path.join(projectRoot, sourcePath), 'utf8')
  const escapedPrefix = prefix.replace(/\./g, '\\.')
  const pattern = new RegExp(`[\\'\"\\\`](${escapedPrefix}[A-Za-z0-9_.]+)[\\'\"\\\`]`, 'g')
  return [...source.matchAll(pattern)].map((match) => match[1]).sort()
}

const queueNoVariable = [
  'actionResultLabel',
  'cancel',
  'cancelJobAria',
  'confirmBulkAction',
  'confirmBulkMessage',
  'confirmBulkTitle',
  'confirmReprintAction',
  'confirmReprintMessage',
  'confirmReprintTitle',
  'countsLabel',
  'empty',
  'feedback.bulkFailed',
  'feedback.cancelFailed',
  'feedback.noChange',
  'feedback.pauseFailed',
  'feedback.queuePaused',
  'feedback.queueResumed',
  'feedback.queueStillActive',
  'feedback.reprintDuplicate',
  'feedback.reprintFailed',
  'feedback.reprintQueued',
  'feedback.resumePrinterFailed',
  'feedback.retryFailed',
  'feedback.retryQueued',
  'freshnessLabel',
  'hideDetails',
  'hideIssueDetails',
  'initialLoadFailedSafe',
  'issue.genericAttention',
  'keepOriginal',
  'keepPrinting',
  'loadFailedSafe',
  'loading',
  'loadingLabel',
  'localStatus',
  'newReprint',
  'pause',
  'pauseCancel',
  'pauseCancelAria',
  'pauseQueueAria',
  'posOnlyScope',
  'posTitle',
  'refresh',
  'refreshAria',
  'reprint',
  'reprintJobAria',
  'resume',
  'resumePrinter',
  'resumeQueueAria',
  'retry',
  'retryJobAria',
  'showDetails',
  'showIssueDetails',
  'showMore',
  'showMoreAria',
  'stale',
  'transport.notStarted',
  'transportStatus',
  'unavailable',
  'unavailableBody',
  'unknown',
] as const

const queueExpectedTokens: Record<string, readonly string[]> = {
  hideIssueDetailsWithContext: ['context'],
  showIssueDetailsWithContext: ['context'],
  unseenPausedPrinterName: ['index'],
  resumeUnseenPrinterAria: ['index'],
  'feedback.activeStopsRequested': ['count'],
  'feedback.nativeControlsRequested': ['count'],
  'feedback.nativeControlsConfirmed': ['count'],
  'feedback.nativeControlsFailed': ['count'],
  'feedback.ownershipRefused': ['count'],
  'feedback.affected': ['count'],
  'feedback.unchanged': ['count'],
  'feedback.localCancelled': ['count'],
  'feedback.queueResumedWithPrinterPauses': ['count'],
  'feedback.printerStillPaused': ['printer'],
  'feedback.printerPauseRemovedQueuePaused': ['printer'],
  'feedback.printerResumed': ['printer'],
  actionContext: ['entity', 'printer'],
  actionContextWithPosition: ['context', 'position'],
  'counts.active': ['count'],
  'counts.failed': ['count'],
  'counts.stale': ['count'],
  'counts.history': ['count'],
  visiblePausedPrinters: ['printers'],
  unnamedPausedPrinters: ['count'],
  jobArticleAria: ['context'],
  updatedAt: ['value'],
  lastSeenAt: ['value'],
  cancelJobWithContextAria: ['context'],
  retryJobWithContextAria: ['context'],
  reprintJobWithContextAria: ['context'],
  resumePrinterWithContextAria: ['context'],
  resumePrinterAria: ['printer'],
  pagination: ['shown', 'total'],
  confirmReprintTitleWithContext: ['context'],
  stuckWarning: ['count'],
  reference: ['reference'],
}

const queueEntityTypes = [
  'order_receipt',
  'kitchen_ticket',
  'z_report',
  'shift_checkout',
  'delivery_slip',
  'test_print',
  'split_receipt',
  'order_completed_receipt',
  'order_canceled_receipt',
  'receipt',
  'print_job',
] as const
const queueStatuses = ['pending', 'printing', 'printed', 'dispatched', 'failed', 'cancelled', 'completed', 'paused'] as const
const queueTransports = [
  'created',
  'submitting',
  'windows_queued',
  'windows_printing',
  'paused',
  'sent',
  'spool_completed',
  'cancel_requested',
  'cancelled',
  'transport_error',
  'spool_error',
  'cancel_failed',
  'unknown',
  'windows',
  'raw_tcp',
  'serial',
] as const

const wizardDomainRequired = [
  ...['idle', 'queued', 'printing', 'awaiting_confirmation', 'confirmed', 'rejected', 'failed', 'cancelled']
    .map((key) => `quickWizardSamplePhase.${key}`),
  ...['transport', 'encoding', 'branding'].map((key) => `quickWizardStage.${key}`),
  ...['transport_text', 'encoding', 'branding'].map((key) => `quickWizardSampleKind.${key}`),
  ...['transport', 'encoding', 'branding'].map((key) => `quickWizardSampleLabel.${key}`),
  ...['small', 'normal', 'large'].map((key) => `quickWizardReadability.${key}`),
  ...['detect', 'verify', 'style', 'save'].map((key) => `quickWizardStep.${key}`),
] as const

const queueStaticSourceKeys = staticSourceKeys(
  'src/renderer/components/printing/PrintQueuePanel.tsx',
  'settings.printQueue.',
)
const wizardStaticSourceKeys = staticSourceKeys(
  'src/renderer/components/modals/PrinterSetupWizard.tsx',
  'settings.printer.quickWizard',
)

test('printer queue and wizard locale contracts are equal, nonblank, and source-complete in EN/EL/DE/FR/IT', () => {
  const locales = Object.fromEntries(localeNames.map((name) => [name, readLocale(name)]))
  const baseQueueEntries = leafEntries(at(locales.en, 'settings.printQueue')).sort(([a], [b]) => a.localeCompare(b))
  const baseWizardEntries = leafEntries(at(locales.en, 'settings.printer'))
    .filter(([key]) => key.startsWith('quickWizard'))
    .sort(([a], [b]) => a.localeCompare(b))
  const baseQueueKeys = baseQueueEntries.map(([key]) => key)
  const baseWizardKeys = baseWizardEntries.map(([key]) => key)

  const queueRequired = [
    ...queueNoVariable,
    ...Object.keys(queueExpectedTokens),
    ...queueEntityTypes.map((key) => `entityType.${key}`),
    ...queueStatuses.map((key) => `status.${key}`),
    ...queueTransports.map((key) => `transport.${key}`),
  ]
  const wizardRequired = [
    ...wizardDomainRequired,
    ...wizardStaticSourceKeys.map((key) => key.replace('settings.printer.', '')),
  ]

  for (const sourceKey of queueStaticSourceKeys) {
    assert.ok(queueRequired.includes(sourceKey.replace('settings.printQueue.', '')), `source queue key is not contracted: ${sourceKey}`)
  }

  for (const localeName of localeNames) {
    const locale = locales[localeName]
    const queueEntries = leafEntries(at(locale, 'settings.printQueue')).sort(([a], [b]) => a.localeCompare(b))
    const wizardEntries = leafEntries(at(locale, 'settings.printer'))
      .filter(([key]) => key.startsWith('quickWizard'))
      .sort(([a], [b]) => a.localeCompare(b))
    assert.deepEqual(queueEntries.map(([key]) => key), baseQueueKeys, `${localeName} printQueue keys differ from en`)
    assert.deepEqual(wizardEntries.map(([key]) => key), baseWizardKeys, `${localeName} quickWizard keys differ from en`)

    for (const [scope, entries] of [['printQueue', queueEntries], ['quickWizard', wizardEntries]] as const) {
      for (const [key, value] of entries) {
        assert.equal(typeof value, 'string', `${localeName} ${scope}.${key} must be a string leaf`)
        assert.ok((value as string).trim(), `${localeName} ${scope}.${key} must not be blank`)
      }
    }

    for (const key of queueRequired) {
      const value = at(locale, `settings.printQueue.${key}`)
      assert.equal(typeof value, 'string', `${localeName} missing settings.printQueue.${key}`)
      assert.ok((value as string).trim(), `${localeName} has blank settings.printQueue.${key}`)
    }
    for (const key of wizardRequired) {
      const value = at(locale, `settings.printer.${key}`)
      assert.equal(typeof value, 'string', `${localeName} missing settings.printer.${key}`)
      assert.ok((value as string).trim(), `${localeName} has blank settings.printer.${key}`)
    }

    for (const [key, expected] of Object.entries(queueExpectedTokens)) {
      assert.deepEqual(
        interpolationTokens(at(locale, `settings.printQueue.${key}`) as string),
        [...expected].sort(),
        `${localeName} settings.printQueue.${key} interpolation tokens differ`,
      )
    }
    for (const key of ['quickWizardCancelSampleAria', 'quickWizardRetrySampleAria']) {
      assert.deepEqual(
        interpolationTokens(at(locale, `settings.printer.${key}`) as string),
        ['sample'],
        `${localeName} settings.printer.${key} must preserve {{sample}}`,
      )
    }

    for (const [key, englishValue] of [...baseQueueEntries, ...baseWizardEntries]) {
      const prefix = key.startsWith('quickWizard') ? 'settings.printer' : 'settings.printQueue'
      const localizedValue = at(locale, `${prefix}.${key}`)
      assert.deepEqual(
        interpolationTokens(localizedValue as string),
        interpolationTokens(englishValue as string),
        `${localeName} ${prefix}.${key} interpolation token parity differs from en`,
      )
    }

    const guardedCopy = JSON.stringify({
      printQueue: at(locale, 'settings.printQueue'),
      quickWizard: Object.fromEntries(
        Object.entries(at(locale, 'settings.printer') as JsonObject)
          .filter(([key]) => key.startsWith('quickWizard')),
      ),
    })
    assert.doesNotMatch(guardedCopy, /\[NEEDS TRANSLATION\]/i, `${localeName} contains a queue/wizard placeholder`)
    if (localeName !== 'en') {
      assert.notEqual(
        at(locale, 'settings.printer.quickWizardSampleLabel.transport'),
        'transport',
        `${localeName} must not announce the raw English stage enum`,
      )
    }
  }
})
