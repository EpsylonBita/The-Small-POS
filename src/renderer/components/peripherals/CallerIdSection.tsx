/**
 * CallerIdSection — read-only status for the centrally managed FXO Caller ID flow.
 *
 * Line/device configuration belongs to the Admin Dashboard. This terminal only
 * displays its safe projection and the state of the native UDP listener.
 */
import React, { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'react-hot-toast'
import {
  AlertCircle,
  CheckCircle,
  Info,
  Loader2,
  MonitorCheck,
  PhoneIncoming,
  RadioTower,
  RefreshCcw,
  Server,
  ShieldAlert,
} from 'lucide-react'
import {
  callerIdGetServerConfig,
  callerIdGetStatus,
  type CallerIdServerConfig,
  type CallerIdServerSourceLine,
  type CallerIdStatus,
  type CallerIdStatusReason,
} from '../../services/CallerIdService'
import CallerIdNetworkAccessCard from './CallerIdNetworkAccessCard'

const statusTone = (status?: CallerIdStatus | null) => {
  if (status?.status === 'listening') return 'text-green-700 dark:text-green-300'
  if (status?.status === 'registering') return 'text-amber-700 dark:text-amber-300'
  if (status?.status === 'error') return 'text-red-700 dark:text-red-300'
  return 'liquid-glass-modal-text-muted'
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

const reasonKey = (reason: CallerIdStatusReason | undefined): string => {
  switch (reason) {
    case 'port_in_use':
      return 'portInUse'
    case 'network_error':
      return 'networkError'
    case 'invalid_config':
      return 'invalidConfig'
    case 'timeout':
      return 'timeout'
    default:
      return 'failed'
  }
}

interface DetailRowProps {
  label: string
  value: string
}

const DetailRow: React.FC<DetailRowProps> = ({ label, value }) => (
  <div className="liquid-glass-modal-inset rounded-xl px-3 py-2.5">
    <p className="liquid-glass-modal-text-muted text-[11px]">{label}</p>
    <p className="liquid-glass-modal-text mt-0.5 break-words text-sm font-medium">{value || '—'}</p>
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
        <RadioTower className="mt-0.5 h-4 w-4 flex-shrink-0 text-amber-600 dark:text-amber-300" />
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
      <span className="rounded-full border border-amber-500/40 bg-amber-500/10 px-2 py-1 text-[11px] font-medium text-amber-800 dark:text-amber-200">
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

  const refreshState = useCallback(async (): Promise<boolean> => {
    setRefreshing(true)
    const [configResult, statusResult] = await Promise.allSettled([
      callerIdGetServerConfig(),
      callerIdGetStatus(),
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

    if (statusResult.status === 'fulfilled') {
      setStatus(statusResult.value)
    }

    setLoading(false)
    setRefreshing(false)
    return configResult.status === 'fulfilled' && statusResult.status === 'fulfilled'
  }, [t])

  useEffect(() => {
    void refreshState()
  }, [refreshState])

  useEffect(() => {
    const interval = setInterval(async () => {
      try {
        setStatus(await callerIdGetStatus())
      } catch {
        // The manual refresh keeps the visible error path under operator control.
      }
    }, 5000)
    return () => clearInterval(interval)
  }, [])

  const handleRefresh = useCallback(async () => {
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
          'settings.peripherals.callerId.serverManaged.loadFailed',
          'Could not load the central Caller ID configuration.',
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

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <PhoneIncoming className="h-5 w-5 flex-shrink-0 text-amber-600 dark:text-amber-300" />
          <h3 className="liquid-glass-modal-text text-sm font-semibold">
            {t('settings.peripherals.callerId.title', 'Caller ID')}
          </h3>
        </div>
        <div className="flex items-center gap-2">
          <span className={`text-xs font-medium ${statusTone(status)}`}>
            {t(
              `settings.peripherals.callerId.status.${statusLabel(status)}`,
              statusLabel(status),
            )}
          </span>
          {listening ? <CheckCircle className="h-3.5 w-3.5 text-green-500" /> : null}
        </div>
      </div>

      <CallerIdNetworkAccessCard />

      <div className="liquid-glass-modal-warning flex items-start gap-2 rounded-2xl border px-3 py-2.5">
        <Info className="mt-0.5 h-4 w-4 flex-shrink-0" />
        <p className="text-xs">
          {t(
            'settings.peripherals.callerId.singleSourceBody',
            'This terminal captures incoming calls and forwards them to the rest of the store. Do not enable the same line on multiple POS terminals.',
          )}
        </p>
      </div>

      <section className="space-y-2">
        <p className="liquid-glass-modal-text-muted text-[11px] font-semibold uppercase tracking-wide">
          {t(
            'settings.peripherals.callerId.serverManaged.step1',
            'Step 1 · Server configuration',
          )}
        </p>
        <div className="liquid-glass-modal-inset flex items-start gap-3 rounded-2xl border p-3">
          {serverConfig?.enabled && hasAssignment ? (
            <CheckCircle className="mt-0.5 h-5 w-5 flex-shrink-0 text-green-600 dark:text-green-300" />
          ) : (
            <Server className="mt-0.5 h-5 w-5 flex-shrink-0 text-amber-600 dark:text-amber-300" />
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
          <div className="liquid-glass-modal-warning flex items-start gap-2 rounded-2xl border p-3">
            <AlertCircle className="mt-0.5 h-4 w-4 flex-shrink-0" />
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
          <div className="liquid-glass-modal-warning flex items-start gap-2 rounded-2xl border p-3">
            <ShieldAlert className="mt-0.5 h-4 w-4 flex-shrink-0" />
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
          <div className="liquid-glass-modal-error flex items-start gap-2 rounded-2xl border p-3" role="alert">
            <AlertCircle className="mt-0.5 h-4 w-4 flex-shrink-0" />
            <p className="text-xs">{serverError}</p>
          </div>
        ) : null}
      </section>

      <section className="space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="liquid-glass-modal-text-muted text-[11px] font-semibold uppercase tracking-wide">
            {t(
              'settings.peripherals.callerId.serverManaged.step2',
              'Step 2 · FXO line details',
            )}
          </p>
          <p className="liquid-glass-modal-text-muted text-[11px]">
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
            <MonitorCheck className="mt-0.5 h-5 w-5 flex-shrink-0 text-green-600 dark:text-green-300" />
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
          <div className="liquid-glass-modal-warning flex items-start gap-2 rounded-2xl border p-3">
            <AlertCircle className="mt-0.5 h-4 w-4 flex-shrink-0" />
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

      {(status?.error || status?.reason) ? (
        <div className="liquid-glass-modal-error flex items-start gap-2 rounded-2xl border p-3" role="alert">
          <AlertCircle className="mt-0.5 h-4 w-4 flex-shrink-0" />
          <p className="text-xs">
            {status.error || t(
              `settings.peripherals.callerId.reason.${reasonKey(status.reason)}`,
              'Caller ID failed to start.',
            )}
          </p>
        </div>
      ) : null}

      <section className="liquid-glass-modal-footer space-y-3 rounded-2xl border px-3 py-3">
        <p className="liquid-glass-modal-text-muted text-[11px] font-semibold uppercase tracking-wide">
          {t(
            'settings.peripherals.callerId.serverManaged.step3',
            'Step 3 · Verify reception',
          )}
        </p>
        <div className="flex items-start gap-3">
          {listening ? (
            <CheckCircle className="mt-0.5 h-5 w-5 flex-shrink-0 text-green-600 dark:text-green-300" />
          ) : (
            <RadioTower className="mt-0.5 h-5 w-5 flex-shrink-0 text-amber-600 dark:text-amber-300" />
          )}
          <div className="space-y-1">
            <p className="liquid-glass-modal-text text-sm font-semibold">
              {t('settings.peripherals.callerId.serverManaged.readinessTitle', 'Local readiness')}
            </p>
            <p className="liquid-glass-modal-text-muted text-xs">
              {listening
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
              className="liquid-glass-modal-text-muted grid grid-cols-2 gap-x-4 gap-y-1 pt-1 text-[11px]"
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
          className="liquid-glass-modal-button inline-flex min-h-[44px] w-full items-center justify-center gap-2 px-3 py-2 text-sm font-medium transition-transform duration-150 active:scale-95 disabled:cursor-not-allowed disabled:opacity-50"
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
  )
}

export default CallerIdSection
