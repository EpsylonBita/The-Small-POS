import React, { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'react-hot-toast'
import { Loader2, RefreshCw, ShieldAlert, ShieldCheck } from 'lucide-react'
import { POSGlassSwitch } from '../ui/pos-glass-components'
import {
  callerIdEnableFirewall,
  callerIdGetFirewallStatus,
  callerIdRemoveFirewall,
  type CallerIdFirewallStatus,
} from '../../services/CallerIdService'

const UAC_CANCELLED_ERROR = 'CALLER_ID_FIREWALL_UAC_CANCELLED'
const RULE_NOT_READY_ERROR = 'CALLER_ID_FIREWALL_RULE_NOT_READY'
const CREATE_FAILED_ERROR = 'CALLER_ID_FIREWALL_CREATE_FAILED'
const POSTCHECK_FAILED_ERROR = 'CALLER_ID_FIREWALL_POSTCHECK_FAILED'

const isRepairIssue = (issue?: string) =>
  Boolean(issue && !['none', 'rule_missing', 'unsupported'].includes(issue))

export const CallerIdNetworkAccessCard: React.FC = () => {
  const { t } = useTranslation()
  const [status, setStatus] = useState<CallerIdFirewallStatus | null>(null)
  const [checking, setChecking] = useState(true)
  const [changing, setChanging] = useState(false)
  const [loadFailed, setLoadFailed] = useState(false)

  const refreshStatus = useCallback(async () => {
    setChecking(true)
    setLoadFailed(false)
    try {
      setStatus(await callerIdGetFirewallStatus())
    } catch (error) {
      console.error('Failed to inspect Caller ID network access:', error)
      setStatus(null)
      setLoadFailed(true)
    } finally {
      setChecking(false)
    }
  }, [])

  useEffect(() => {
    void refreshStatus()
  }, [refreshStatus])

  const changeAccess = async (enabled: boolean) => {
    if (changing) return
    setChanging(true)
    try {
      const nextStatus = enabled
        ? await callerIdEnableFirewall()
        : await callerIdRemoveFirewall()
      setStatus(nextStatus)
      setLoadFailed(false)
      toast.success(
        enabled
          ? t(
              'settings.peripherals.callerId.networkAccess.enabledToast',
              'Caller ID private-network access is enabled',
            )
          : t(
              'settings.peripherals.callerId.networkAccess.removedToast',
              'Caller ID private-network access is removed',
            ),
      )
    } catch (error) {
      console.error('Failed to change Caller ID network access:', error)
      const message = error instanceof Error ? error.message : String(error)
      toast.error(
        message.includes(UAC_CANCELLED_ERROR)
          ? t(
              'settings.peripherals.callerId.networkAccess.cancelled',
              'Windows administrator approval was cancelled',
            )
          : message.includes(RULE_NOT_READY_ERROR) ||
              message.includes(POSTCHECK_FAILED_ERROR)
            ? t(
                'settings.peripherals.callerId.networkAccess.ruleNotReady',
                'Windows approved the request, but the safe Caller ID rule was not installed. Try once more; if it repeats, report the reason shown here.',
              )
            : message.includes(CREATE_FAILED_ERROR)
              ? t(
                  'settings.peripherals.callerId.networkAccess.createFailed',
                  'Windows could not create the safe Caller ID rule. Check that Windows Firewall is running, then try again.',
                )
          : t(
              'settings.peripherals.callerId.networkAccess.changeFailed',
              'Windows could not change Caller ID network access',
            ),
      )
      await refreshStatus()
    } finally {
      setChanging(false)
    }
  }

  const busy = checking || changing
  const configured = Boolean(status?.configured)
  const ready = Boolean(
    status?.configured &&
      status.privateNetworkActive &&
      !status.publicRulePresent,
  )

  const statusText = (() => {
    if (checking && !status) {
      return t(
        'settings.peripherals.callerId.networkAccess.checking',
        'Checking Windows permission…',
      )
    }
    if (loadFailed) {
      return t(
        'settings.peripherals.callerId.networkAccess.checkFailed',
        'Windows permission could not be checked',
      )
    }
    if (!status?.supported) {
      return t(
        'settings.peripherals.callerId.networkAccess.windowsOnly',
        'This permission is available on Windows only',
      )
    }
    if (status.publicRulePresent) {
      return t(
        'settings.peripherals.callerId.networkAccess.publicRule',
        'A broad Public-network rule was found. Turn this on to replace it with the safe Private-only rule.',
      )
    }
    if (isRepairIssue(status.configurationIssue)) {
      return t(
        'settings.peripherals.callerId.networkAccess.ruleInvalid',
        'The existing Caller ID rule is not safe or complete. Turn access on to replace it; Windows will show the exact repair result.',
      )
    }
    if (!status.configured) {
      return t(
        'settings.peripherals.callerId.networkAccess.permissionOff',
        'Permission is off. Caller ID devices cannot reach this POS yet.',
      )
    }
    if (!status.networkProfileKnown) {
      return t(
        'settings.peripherals.callerId.networkAccess.profileUnknown',
        'The Private-only rule is installed, but Windows could not report the current network type.',
      )
    }
    if (status.publicNetworkActive && !status.privateNetworkActive) {
      return t(
        'settings.peripherals.callerId.networkAccess.networkPublic',
        'The safe rule is installed, but Windows calls this network Public. In Windows Settings, change this Ethernet or Wi-Fi connection to Private.',
      )
    }
    if (status.publicNetworkActive) {
      return t(
        'settings.peripherals.callerId.networkAccess.networkMixed',
        'Caller ID is ready on Private connections. Another active connection is Public, so Caller ID stays blocked on it.',
      )
    }
    return t(
      'settings.peripherals.callerId.networkAccess.readyBody',
      'Ready for Caller ID devices on this private local network.',
    )
  })()

  const badgeText = ready
    ? t('settings.peripherals.callerId.networkAccess.ready', 'Ready')
    : configured
      ? t('settings.peripherals.callerId.networkAccess.ruleInstalled', 'Rule installed')
      : isRepairIssue(status?.configurationIssue)
        ? t('settings.peripherals.callerId.networkAccess.repairNeeded', 'Repair needed')
        : t('settings.peripherals.callerId.networkAccess.permissionNeeded', 'Permission needed')

  return (
    <div className="rounded-2xl border liquid-glass-modal-border bg-white/5 px-4 py-3 space-y-3 dark:bg-black/10">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <div className="flex items-center gap-2">
            {ready ? (
              <ShieldCheck className="h-5 w-5 flex-shrink-0 text-emerald-600 dark:text-emerald-300" />
            ) : (
              <ShieldAlert className="h-5 w-5 flex-shrink-0 text-amber-600 dark:text-amber-300" />
            )}
            <h4 id="caller-id-network-access-label" className="liquid-glass-modal-text text-sm font-semibold">
              {t(
                'settings.peripherals.callerId.networkAccess.title',
                'Private network access',
              )}
            </h4>
            {status?.supported && (
              <span
                className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${
                  ready
                    ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-200'
                    : 'bg-amber-500/15 text-amber-800 dark:text-amber-200'
                }`}
              >
                {badgeText}
              </span>
            )}
          </div>
          <p className="liquid-glass-modal-text-muted text-xs">
            {t(
              'settings.peripherals.callerId.networkAccess.help',
              'Allows only devices on this local network to send Caller ID packets to this POS (UDP 5060). Windows will ask for administrator approval.',
            )}
          </p>
        </div>
        <POSGlassSwitch
          aria-labelledby="caller-id-network-access-label"
          checked={configured}
          disabled={busy || loadFailed || !status?.supported}
          onChange={changeAccess}
        />
      </div>

      <div
        className={`flex items-start gap-2 rounded-xl border px-3 py-2 text-xs ${
          ready
            ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-800 dark:text-emerald-100'
            : 'border-amber-500/30 bg-amber-500/10 text-amber-900 dark:text-amber-100'
        }`}
      >
        {busy ? (
          <Loader2 className="mt-0.5 h-4 w-4 flex-shrink-0 animate-spin" />
        ) : ready ? (
          <ShieldCheck className="mt-0.5 h-4 w-4 flex-shrink-0" />
        ) : (
          <ShieldAlert className="mt-0.5 h-4 w-4 flex-shrink-0" />
        )}
        <span className="flex-1">{statusText}</span>
        <button
          type="button"
          onClick={() => void refreshStatus()}
          disabled={busy}
          className="inline-flex min-h-[32px] min-w-[32px] flex-shrink-0 items-center justify-center rounded-lg border border-current/20 disabled:opacity-50"
          aria-label={t(
            'settings.peripherals.callerId.networkAccess.checkAgain',
            'Check permission again',
          )}
        >
          <RefreshCw className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  )
}

export default CallerIdNetworkAccessCard
