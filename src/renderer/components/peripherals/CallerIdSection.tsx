/**
 * CallerIdSection — read-only status for the centrally managed FXO Caller ID flow.
 *
 * Line/device configuration belongs to the Admin Dashboard. This terminal only
 * displays its safe projection and the state of the native UDP listener.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'react-hot-toast'
import {
  AlertCircle,
  CheckCircle,
  Info,
  Loader2,
  MonitorCheck,
  RadioTower,
  RefreshCcw,
  Server,
  ShieldAlert,
} from 'lucide-react'
import {
  callerIdGetServerConfig,
  callerIdGetStatus,
  callerIdStart,
  type CallerIdServerConfig,
  type CallerIdServerSourceLine,
  type CallerIdStatus,
} from '../../services/CallerIdService'
import CallerIdNetworkAccessCard from './CallerIdNetworkAccessCard'
import { StatusLine, TechDisclosure, type StatusTone } from '../settings/SettingsKit'

/** The server refuses Caller ID for a store without the plugin with this code (HTTP 403). */
export const CALLER_ID_ENTITLEMENT_REQUIRED = 'CALLER_ID_ENTITLEMENT_REQUIRED'

/**
 * The POS API error text ends with the server's JSON body ("… (HTTP 403): {"error":…,"code":…}").
 * The code is read only from that JSON's own `code` string, never matched anywhere in free text.
 */
export function callerIdErrorCode(message: string | null | undefined): string | null {
  if (typeof message !== 'string') return null
  const start = message.indexOf('{')
  if (start < 0) return null
  try {
    const body = JSON.parse(message.slice(start)) as { code?: unknown } | null
    return body && typeof body.code === 'string' ? body.code : null
  } catch {
    return null
  }
}

const statusTone = (status?: CallerIdStatus | null): StatusTone => {
  if (status?.status === 'listening') return 'ok'
  if (status?.status === 'registering') return 'warn'
  if (status?.status === 'error') return 'bad'
  return 'idle'
}

const statusLabel = (status?: CallerIdStatus | null) => {
  if (status?.status === 'listening') return 'listening'
  if (status?.status === 'registering') return 'registering'
  if (status?.status === 'error') return 'error'
  return 'stopped'
}

const profileLabel = (profileKey: string): string => {
  const labels: Record<string, string> = {
    grandstream_ht813_fxo: 'Grandstream HT813 (FXO)',
    grandstream_ht841_fxo: 'Grandstream HT841 (FXO)',
    grandstream_ht881_fxo: 'Grandstream HT881 (FXO)',
  }
  return labels[profileKey] || profileKey || '—'
}


interface DetailRowProps {
  label: string
  value: string
}

const DetailRow: React.FC<DetailRowProps> = ({ label, value }) => (
  <div className="liquid-glass-modal-inset rounded-xl px-3 py-2.5">
    <p className="liquid-glass-modal-text-muted text-xs">{label}</p>
    <p className="liquid-glass-modal-text mt-0.5 wrap-break-word text-sm font-medium">{value || '—'}</p>
  </div>
)

interface SourceLineCardProps {
  line: CallerIdServerSourceLine
  t: (key: string, fallback: string) => string
}

const SourceLineCard: React.FC<SourceLineCardProps> = ({ line, t }) => (
  <div className="liquid-glass-modal-inset space-y-3 rounded-2xl border p-3">
    <div className="flex flex-wrap items-start justify-between gap-2">
      <div className="flex min-w-0 items-start gap-2">
        <RadioTower className="mt-0.5 h-4 w-4 shrink-0 liquid-glass-modal-text-muted" />
        <div className="min-w-0">
          <p className="liquid-glass-modal-text text-sm font-semibold">
            {line.name || t('settings.peripherals.callerId.serverManaged.sourceLine', 'Source line')}
          </p>
          <p className="liquid-glass-modal-text-muted mt-0.5 text-xs">
            {line.isReceivingTarget
              ? t('settings.peripherals.callerId.serverManaged.receivingHere', 'This POS also receives this line')
              : t('settings.peripherals.callerId.serverManaged.sourceOnly', 'This POS is the source for this line')}
          </p>
        </div>
      </div>
      <span className="pos-badge shrink-0">
        {t('settings.peripherals.callerId.serverManaged.readOnly', 'Read-only')}
      </span>
    </div>

    <div className="grid gap-2 sm:grid-cols-2">
      <DetailRow
        label={t('settings.peripherals.callerId.serverManaged.profile', 'Device profile')}
        value={profileLabel(line.deviceProfileKey)}
      />
      <DetailRow
        label={t('settings.peripherals.callerId.serverManaged.deviceIp', 'FXO adapter LAN IP')}
        value={line.trustedDeviceIp || '—'}
      />
      <DetailRow
        label={t('settings.peripherals.callerId.serverManaged.channel', 'Source channel')}
        value={line.sourceChannel || '—'}
      />
      <DetailRow
        label={t('settings.peripherals.callerId.serverManaged.port', 'POS listen port')}
        value={line.listenPort ? `UDP ${line.listenPort}` : '—'}
      />
    </div>
  </div>
)

const CallerIdSection: React.FC = () => {
  const { t } = useTranslation()
  const [serverConfig, setServerConfig] = useState<CallerIdServerConfig | null>(null)
  const [status, setStatus] = useState<CallerIdStatus | null>(null)
  const [serverError, setServerError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [localStatusError, setLocalStatusError] = useState<string | null>(null)
  const statusRequest = useRef(0)

  const refreshLocalStatus = useCallback(async (): Promise<boolean> => {
    const request = ++statusRequest.current
    try {
      const nextStatus = await callerIdGetStatus()
      if (request !== statusRequest.current) return false
      setStatus(nextStatus)
      setLocalStatusError(null)
      return true
    } catch (error) {
      if (request !== statusRequest.current) return false
      // Losing access to status does not stop the production listener.
      // Clear the old green display instead of presenting it as current.
      setStatus(null)
      setLocalStatusError(error instanceof Error ? error.message : String(error))
      return false
    }
  }, [])

  const refreshState = useCallback(async (): Promise<boolean> => {
    setRefreshing(true)
    const [configResult, statusResult] = await Promise.allSettled([
      callerIdGetServerConfig(),
      refreshLocalStatus(),
    ])

    if (configResult.status === 'fulfilled') {
      setServerConfig(configResult.value)
      setServerError(null)
    } else {
      setServerError(
        configResult.reason instanceof Error
          ? configResult.reason.message
          : t(
              'settings.peripherals.callerId.serverManaged.loadFailed',
              'Could not load the central Caller ID configuration.',
            ),
      )
    }

    setLoading(false)
    setRefreshing(false)
    return configResult.status === 'fulfilled' && statusResult.status === 'fulfilled' && statusResult.value
  }, [t, refreshLocalStatus])

  useEffect(() => {
    void refreshState()
  }, [refreshState])

  useEffect(() => {
    const interval = setInterval(() => { void refreshLocalStatus() }, 5000)
    return () => {
      clearInterval(interval)
      statusRequest.current += 1
    }
  }, [refreshLocalStatus])

  const handleRefresh = useCallback(async () => {
    // The explicit refresh is the on-demand activation check: the native
    // runtime restarts from its stored lease and checks the server once, so a
    // line assigned in the Admin Dashboard applies without a POS restart.
    try {
      await callerIdStart()
    } catch {
      // The status and configuration refresh below report what is wrong.
    }
    const refreshed = await refreshState()
    if (refreshed) {
      toast.success(
        t(
          'settings.peripherals.callerId.serverManaged.refreshed',
          'Caller ID status refreshed.',
        ),
      )
    } else {
      toast.error(
        t(
          'settings.workflow.callerRefreshFailed',
          'Could not refresh Caller ID status. Check the details below.',
        ),
      )
    }
  }, [refreshState, t])

  if (loading && !serverConfig && !status) {
    return (
      <div className="liquid-glass-modal-text-muted flex items-center gap-2 py-4">
        <Loader2 className="h-4 w-4 animate-spin" />
        <span className="text-sm">{t('common.loading', 'Loading...')}</span>
      </div>
    )
  }

  const sourceLines = serverConfig?.sourceLines ?? []
  const receivingLines = serverConfig?.receivingLines ?? []
  const hasAssignment = sourceLines.length > 0 || receivingLines.length > 0
  const listening = status?.status === 'listening'
  const notEntitled = callerIdErrorCode(serverError) === CALLER_ID_ENTITLEMENT_REQUIRED
  // Raw server and listener texts for support only; the screen says what it means in plain words.
  const supportDetails = [
    serverError,
    status?.error,
    status?.reason ? `reason: ${status.reason}` : null,
    localStatusError,
  ].filter((text): text is string => typeof text === 'string' && text.length > 0)
  const supportDisclosure = supportDetails.length > 0 ? (
    <TechDisclosure
      title={t('settings.peripherals.callerId.supportDetails', 'Support details')}
      data-testid="caller-id-support-details"
    >
      {supportDetails.map((text, index) => (
        <p key={index} className="liquid-glass-modal-text-muted font-mono text-xs break-all">{text}</p>
      ))}
    </TechDisclosure>
  ) : null

  // Caller ID is an optional plugin: without it for this store there is nothing to fix here.
  if (notEntitled) {
    return (
      <section className="pos-group" data-device-card="caller-id" data-caller-id-state="not-entitled">
        <div className="pos-row">
          <div className="pos-row__label">
            <h3 className="pos-row__title">
              {t('settings.peripherals.callerId.title', 'Caller ID')}
            </h3>
            <StatusLine tone="idle">{t('settings.peripherals.callerId.notActive', 'Not active')}</StatusLine>
          </div>
        </div>
        <div className="px-5 pb-4">
          <div className="pos-notice" role="status">
            <Info className="mt-0.5 h-4 w-4 shrink-0 liquid-glass-modal-text-muted" aria-hidden="true" />
            <p className="text-sm">
              {t(
                'settings.peripherals.callerId.notEntitledPlain',
                'Caller ID is not active for this store. It is turned on from the Admin Dashboard.',
              )}
            </p>
          </div>
        </div>
        {supportDisclosure}
      </section>
    )
  }

  return (
    <section className="pos-group" data-device-card="caller-id">
      <div className="pos-row">
        <div className="pos-row__label">
          <h3 className="pos-row__title">
            {t('settings.peripherals.callerId.title', 'Caller ID')}
          </h3>
          <StatusLine tone={localStatusError ? 'bad' : statusTone(status)}>
            {localStatusError ? t('settings.workflow.unavailable', 'Unavailable') : t(
              `settings.peripherals.callerId.status.${statusLabel(status)}`,
              statusLabel(status),
            )}
          </StatusLine>
        </div>
      </div>
      <div className="space-y-4 px-5 pb-4">

      <CallerIdNetworkAccessCard />

      <div className="pos-notice pos-notice--warn">
        <Info className="mt-0.5 h-4 w-4 shrink-0" />
        <p className="text-xs">
          {t(
            'settings.peripherals.callerId.singleSourceBody',
            'This terminal captures incoming calls and shows them here. Other terminals do not show the call. Do not enable the same line on multiple POS terminals.',
          )}
        </p>
      </div>

      <section className="space-y-2">
        <p className="liquid-glass-modal-text text-sm font-semibold">
          {t(
            'settings.peripherals.callerId.serverManaged.step1',
            'Step 1 · Server configuration',
          )}
        </p>
        <div className="liquid-glass-modal-inset flex items-start gap-3 rounded-2xl border p-3">
          {serverConfig?.enabled && hasAssignment ? (
            <CheckCircle className="mt-0.5 h-5 w-5 shrink-0 text-green-600 dark:text-green-300" />
          ) : (
            <Server className="mt-0.5 h-5 w-5 shrink-0 liquid-glass-modal-text-muted" />
          )}
          <div className="space-y-1">
            <p className="liquid-glass-modal-text text-sm font-semibold">
              {serverConfig?.enabled && hasAssignment
                ? t('settings.peripherals.callerId.serverManaged.synced', 'Configuration synced')
                : t('settings.peripherals.callerId.serverManaged.centralTitle', 'Managed from Admin Dashboard')}
            </p>
            <p className="liquid-glass-modal-text-muted text-xs">
              {t(
                'settings.peripherals.callerId.serverManaged.centralBody',
                'Caller ID is configured centrally. This POS does not need SIP usernames, passwords, or a local save action.',
              )}
            </p>
          </div>
        </div>

        {serverConfig && !serverConfig.enabled ? (
          <div className="pos-notice pos-notice--warn">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
            <div>
              <p className="text-xs font-medium">
                {t('settings.peripherals.callerId.serverManaged.disabledTitle', 'Caller ID is not enabled')}
              </p>
              <p className="mt-1 text-xs opacity-80">
                {t(
                  'settings.peripherals.callerId.serverManaged.disabledBody',
                  'Enable and assign the line from the Admin Dashboard, then refresh this screen.',
                )}
              </p>
            </div>
          </div>
        ) : null}

        {serverConfig?.ipTrustSourcePolicy === 'blocked' && sourceLines.length > 0 ? (
          <div className="pos-notice pos-notice--warn">
            <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" />
            <div>
              <p className="text-xs font-medium">
                {t('settings.peripherals.callerId.serverManaged.blockedTitle', 'Source terminal is restricted')}
              </p>
              <p className="mt-1 text-xs opacity-80">
                {t(
                  'settings.peripherals.callerId.serverManaged.blockedBody',
                  'IP-trusted FXO capture is currently limited by the server policy. Review the organization in Admin Dashboard.',
                )}
              </p>
            </div>
          </div>
        ) : null}

        {serverError ? (
          <div className="pos-notice pos-notice--bad" role="alert">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
            <p className="text-xs">
              {t(
                'settings.peripherals.callerId.loadFailedPlain',
                'The Caller ID setup could not be loaded from the Admin Dashboard. Press "Refresh status".',
              )}
            </p>
          </div>
        ) : null}
      </section>

      <section className="space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="liquid-glass-modal-text text-sm font-semibold">
            {t(
              'settings.peripherals.callerId.serverManaged.step2',
              'Step 2 · FXO line details',
            )}
          </p>
          <p className="liquid-glass-modal-text-muted text-xs">
            {t(
              'settings.peripherals.callerId.serverManaged.changeInDashboard',
              'Change these values in Admin Dashboard',
            )}
          </p>
        </div>

        {sourceLines.map((line) => (
          <SourceLineCard key={line.id} line={line} t={t} />
        ))}

        {sourceLines.length === 0 && receivingLines.length > 0 ? (
          <div className="liquid-glass-modal-inset flex items-start gap-3 rounded-2xl border p-3">
            <MonitorCheck className="mt-0.5 h-5 w-5 shrink-0 text-green-600 dark:text-green-300" />
            <div className="space-y-1">
              <p className="liquid-glass-modal-text text-sm font-semibold">
                {t(
                  'settings.peripherals.callerId.serverManaged.receiverOnlyTitle',
                  'This POS receives Caller ID from another terminal',
                )}
              </p>
              <p className="liquid-glass-modal-text-muted text-xs">
                {t(
                  'settings.peripherals.callerId.serverManaged.receiverOnlyBody',
                  'Source device details appear only on the assigned source terminal.',
                )}
              </p>
              <p className="liquid-glass-modal-text pt-1 text-xs font-medium">
                {receivingLines.map((line) => line.name || line.id).join(', ')}
              </p>
            </div>
          </div>
        ) : null}

        {!hasAssignment && !serverError ? (
          <div className="pos-notice pos-notice--warn">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
            <div>
              <p className="text-xs font-medium">
                {t('settings.peripherals.callerId.serverManaged.notAssignedTitle', 'No Caller ID line assigned')}
              </p>
              <p className="mt-1 text-xs opacity-80">
                {t(
                  'settings.peripherals.callerId.serverManaged.notAssignedBody',
                  'Assign this terminal as a source or receiver in Admin Dashboard, then refresh.',
                )}
              </p>
            </div>
          </div>
        ) : null}
      </section>

      {localStatusError && <div role="alert" className="pos-notice pos-notice--bad pos-notice--stack text-xs">
        {t('settings.workflow.callerStatusFailed', 'Local Caller ID status is unavailable. Refresh to check again.')}
      </div>}
      {(status?.error || status?.reason) ? (
        <div className="pos-notice pos-notice--bad" role="alert">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
          <p className="text-xs">
            {t(
              'settings.peripherals.callerId.notStartedPlain',
              'Caller ID did not start on this till. Press "Refresh status"; if it stays, give the support details to support.',
            )}
          </p>
        </div>
      ) : null}

      <section className="liquid-glass-modal-footer space-y-3 rounded-2xl border px-3 py-3">
        <p className="liquid-glass-modal-text text-sm font-semibold">
          {t(
            'settings.peripherals.callerId.serverManaged.step3',
            'Step 3 · Verify reception',
          )}
        </p>
        <div className="flex items-start gap-3">
          {listening ? (
            <CheckCircle className="mt-0.5 h-5 w-5 shrink-0 text-green-600 dark:text-green-300" />
          ) : (
            <RadioTower className="mt-0.5 h-5 w-5 shrink-0 liquid-glass-modal-text-muted" />
          )}
          <div className="space-y-1">
            <p className="liquid-glass-modal-text text-sm font-semibold">
              {t('settings.peripherals.callerId.serverManaged.readinessTitle', 'Local readiness')}
            </p>
            <p className="liquid-glass-modal-text-muted text-xs">
              {localStatusError ? t('settings.workflow.callerStatusFailed', 'Local Caller ID status is unavailable. Refresh to check again.') : listening
                ? t(
                    'settings.peripherals.callerId.serverManaged.listening',
                    'The local FXO listener is running and waiting for incoming calls.',
                  )
                : t(
                    'settings.peripherals.callerId.serverManaged.notListening',
                    'The local listener is not ready yet. Check the assignment and private-network access, then refresh.',
                  )}
            </p>
            <p className="liquid-glass-modal-text-muted text-xs">
              {t(
                'settings.peripherals.callerId.serverManaged.realCallHint',
                'For the final check, start a readiness test in Admin Dashboard and make one real incoming call.',
              )}
            </p>
            <p className="liquid-glass-modal-text text-xs font-medium" aria-live="polite">
              {t(
                'settings.peripherals.callerId.serverManaged.callsDetected',
                'Calls detected in this session',
              )}: {status?.callsDetected ?? 0}
            </p>
            <div
              className="liquid-glass-modal-text-muted grid grid-cols-2 gap-x-4 gap-y-1 pt-1 text-xs"
              aria-label={t(
                'settings.peripherals.callerId.serverManaged.intakeDiagnostics',
                'Local intake diagnostics',
              )}
            >
              <span>UDP: {status?.udpPacketsReceived ?? 0}</span>
              <span>
                {t('settings.peripherals.callerId.serverManaged.trustedPackets', 'Trusted')}: {status?.trustedPacketsReceived ?? 0}
              </span>
              <span>
                {t('settings.peripherals.callerId.serverManaged.candidates', 'Candidates')}: {status?.callerIdCandidates ?? 0}
              </span>
              <span>
                {t('settings.peripherals.callerId.serverManaged.rejected', 'Rejected')}: {status?.rejectedCandidates ?? 0}
              </span>
              <span className="col-span-2">
                {t('settings.peripherals.callerId.serverManaged.lastRejection', 'Last rejection')}: {status?.lastRejectionStage ?? '—'}
              </span>
            </div>
          </div>
        </div>
        <button
          type="button"
          onClick={handleRefresh}
          disabled={refreshing}
          className="liquid-glass-modal-button inline-flex min-h-touch w-full items-center justify-center gap-2 px-3 py-2 text-sm font-medium transition-transform duration-150 active:scale-95 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {refreshing ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <RefreshCcw className="h-4 w-4" />
          )}
          {t('settings.peripherals.callerId.serverManaged.refresh', 'Refresh status')}
        </button>
      </section>
      </div>
      {supportDisclosure}
    </section>
  )
}

export default CallerIdSection
