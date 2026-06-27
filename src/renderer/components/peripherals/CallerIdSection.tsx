/**
 * CallerIdSection — guided SIP Caller ID setup for the source terminal.
 *
 * This flow replaces the old raw PBX-only fields with:
 * - provider presets
 * - generic authenticated SIP
 * - advanced legacy PBX trust mode
 *
 * Caller ID remains local-first: exactly one POS terminal per phone line
 * should be configured as the active source.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import { toast } from 'react-hot-toast'
import {
  AlertCircle,
  CheckCircle,
  ChevronDown,
  ChevronUp,
  Circle,
  Info,
  Loader2,
  Lock,
  PhoneIncoming,
  Play,
  Power,
  Save,
  Server,
  ShieldAlert,
} from 'lucide-react'
import {
  callerIdGetConfig,
  callerIdGetStatus,
  callerIdSaveConfig,
  callerIdStart,
  callerIdStop,
  callerIdTestConnection,
  type CallerIdConfig,
  type CallerIdMode,
  type CallerIdStatus,
  type CallerIdStatusReason,
  type CallerIdTransport,
} from '../../services/CallerIdService'

type SetupType = 'provider_preset' | 'generic_sip' | 'legacy_pbx'

interface ProviderPreset {
  id: string
  label: string
  // Optional i18n key for the visible label. Brand-name presets (3CX, FreePBX,
  // Yeastar) keep their literal label; only the generic preset is translated.
  labelKey?: string
  description: string
  descriptionKey: string
  transport: CallerIdTransport
  sipPort: number
  outboundProxy?: string
}

const PROVIDER_PRESETS: ProviderPreset[] = [
  {
    id: 'generic_europe',
    label: 'Generic SIP Europe',
    labelKey: 'settings.peripherals.callerId.presets.genericEurope.label',
    description: 'Standard SIP credentials from a provider or hosted PBX.',
    descriptionKey: 'settings.peripherals.callerId.presets.genericEurope.description',
    transport: 'udp',
    sipPort: 5060,
  },
  {
    id: '3cx',
    label: '3CX',
    description: '3CX default SIP transport and port.',
    descriptionKey: 'settings.peripherals.callerId.presets.threeCx.description',
    transport: 'udp',
    sipPort: 5060,
  },
  {
    id: 'freepbx',
    label: 'FreePBX / Asterisk',
    description: 'Common Asterisk-style SIP registration defaults.',
    descriptionKey: 'settings.peripherals.callerId.presets.freePbx.description',
    transport: 'udp',
    sipPort: 5060,
  },
  {
    id: 'yeastar',
    label: 'Yeastar',
    description: 'Local or hosted Yeastar PBX with standard SIP credentials.',
    descriptionKey: 'settings.peripherals.callerId.presets.yeastar.description',
    transport: 'udp',
    sipPort: 5060,
  },
]

const DEFAULT_CONFIG: CallerIdConfig = {
  mode: 'authenticated_sip',
  transport: 'udp',
  sipServer: '',
  sipPort: 5060,
  sipUsername: '',
  authUsername: '',
  outboundProxy: '',
  providerPresetId: 'generic_europe',
  listenPort: 5060,
  enabled: false,
  hasPassword: false,
  password: '',
}

const normalizeConfig = (config?: Partial<CallerIdConfig> | null): CallerIdConfig => ({
  ...DEFAULT_CONFIG,
  ...config,
  mode: config?.mode ?? DEFAULT_CONFIG.mode,
  transport: config?.transport ?? DEFAULT_CONFIG.transport,
  sipServer: config?.sipServer ?? DEFAULT_CONFIG.sipServer,
  sipPort: Number.isFinite(config?.sipPort) ? Number(config?.sipPort) : DEFAULT_CONFIG.sipPort,
  sipUsername: config?.sipUsername ?? DEFAULT_CONFIG.sipUsername,
  authUsername: config?.authUsername ?? DEFAULT_CONFIG.authUsername,
  outboundProxy: config?.outboundProxy ?? DEFAULT_CONFIG.outboundProxy,
  providerPresetId:
    config?.providerPresetId ?? DEFAULT_CONFIG.providerPresetId,
  listenPort: Number.isFinite(config?.listenPort)
    ? Number(config?.listenPort)
    : DEFAULT_CONFIG.listenPort,
  enabled: Boolean(config?.enabled),
  hasPassword: Boolean(config?.hasPassword),
  password: '',
})

const getSetupType = (config: CallerIdConfig): SetupType => {
  if (config.mode === 'pbx_ip_trust_legacy') {
    return 'legacy_pbx'
  }
  if (config.providerPresetId && config.providerPresetId !== 'generic_sip') {
    return 'provider_preset'
  }
  return 'generic_sip'
}

const toReasonMessage = (reason: CallerIdStatusReason | undefined, t: TFunction): string => {
  switch (reason) {
    case 'auth_failed':
      return t('settings.peripherals.callerId.reason.authFailed', 'Authentication failed. Check the SIP username, auth username, and password.')
    case 'timeout':
      return t('settings.peripherals.callerId.reason.timeout', 'The SIP server did not answer in time. Check the server, port, and firewall.')
    case 'unsupported_provider':
      return t('settings.peripherals.callerId.reason.unsupportedProvider', 'This provider requires an unsupported SIP challenge or router-locked setup.')
    case 'port_in_use':
      return t('settings.peripherals.callerId.reason.portInUse', 'The local SIP listen port is already in use on this POS terminal.')
    case 'invalid_config':
      return t('settings.peripherals.callerId.reason.invalidConfig', 'The SIP configuration is incomplete.')
    case 'network_error':
      return t('settings.peripherals.callerId.reason.networkError', 'The SIP server could not be reached over the selected transport.')
    default:
      return t('settings.peripherals.callerId.reason.failed', 'Caller ID failed to start.')
  }
}

const buildTestFingerprint = (config: CallerIdConfig): string =>
  JSON.stringify({
    mode: config.mode,
    transport: config.transport,
    sipServer: config.sipServer.trim(),
    sipPort: Number(config.sipPort) || 5060,
    sipUsername: config.sipUsername.trim(),
    authUsername: config.authUsername?.trim() || null,
    outboundProxy: config.outboundProxy?.trim() || null,
    providerPresetId: config.providerPresetId || null,
    listenPort: Number(config.listenPort) || 5060,
    passwordState: config.password?.trim()
      ? `inline:${config.password.trim()}`
      : config.hasPassword
        ? '__stored__'
        : null,
  })

const buildConfigPayload = (config: CallerIdConfig, enabled: boolean): Partial<CallerIdConfig> => {
  const payload: Partial<CallerIdConfig> = {
    mode: config.mode,
    transport: config.transport,
    sipServer: config.sipServer.trim(),
    sipPort: Number(config.sipPort) || 5060,
    sipUsername: config.sipUsername.trim(),
    authUsername: config.authUsername?.trim() || undefined,
    outboundProxy: config.outboundProxy?.trim() || undefined,
    providerPresetId: config.providerPresetId?.trim() || undefined,
    listenPort: Number(config.listenPort) || 5060,
    enabled,
  }

  if (config.password?.trim()) {
    payload.password = config.password.trim()
  }

  return payload
}

const statusTone = (status?: CallerIdStatus | null) => {
  if (status?.status === 'listening') return 'text-green-400'
  if (status?.status === 'registering') return 'text-yellow-400'
  if (status?.status === 'error') return 'text-red-400'
  return 'text-zinc-500'
}

const statusLabel = (status?: CallerIdStatus | null) => {
  if (status?.status === 'listening') return 'Listening'
  if (status?.status === 'registering') return 'Registering'
  if (status?.status === 'error') return 'Error'
  return 'Stopped'
}

const CallerIdSection: React.FC = () => {
  const { t } = useTranslation()
  const [config, setConfig] = useState<CallerIdConfig>(DEFAULT_CONFIG)
  const [status, setStatus] = useState<CallerIdStatus | null>(null)
  const [setupType, setSetupType] = useState<SetupType>('provider_preset')
  const [testing, setTesting] = useState(false)
  const [saving, setSaving] = useState(false)
  const [loading, setLoading] = useState(true)
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [lastSuccessfulTestFingerprint, setLastSuccessfulTestFingerprint] = useState<string | null>(null)

  const currentFingerprint = useMemo(() => buildTestFingerprint(config), [config])
  const requiresFreshTest = currentFingerprint !== lastSuccessfulTestFingerprint

  const refreshState = useCallback(async () => {
    const [loadedConfig, loadedStatus] = await Promise.all([
      callerIdGetConfig(),
      callerIdGetStatus(),
    ])
    const normalized = normalizeConfig(loadedConfig)
    setConfig(normalized)
    setSetupType(getSetupType(normalized))
    setStatus(loadedStatus)
    setLastSuccessfulTestFingerprint(
      normalized.enabled ? buildTestFingerprint(normalized) : null,
    )
  }, [])

  useEffect(() => {
    let mounted = true

    ;(async () => {
      try {
        const [loadedConfig, loadedStatus] = await Promise.all([
          callerIdGetConfig(),
          callerIdGetStatus(),
        ])
        if (!mounted) return

        const normalized = normalizeConfig(loadedConfig)
        setConfig(normalized)
        setSetupType(getSetupType(normalized))
        setStatus(loadedStatus)
        setShowAdvanced(
          normalized.transport === 'tcp' ||
            !!normalized.outboundProxy ||
            normalized.listenPort !== 5060,
        )
        setLastSuccessfulTestFingerprint(
          normalized.enabled ? buildTestFingerprint(normalized) : null,
        )
      } catch (error) {
        console.warn('[CallerIdSection] Failed to load config:', error)
      } finally {
        if (mounted) setLoading(false)
      }
    })()

    return () => {
      mounted = false
    }
  }, [])

  useEffect(() => {
    const interval = setInterval(async () => {
      try {
        setStatus(await callerIdGetStatus())
      } catch {
        // Ignore background polling failures.
      }
    }, 5000)

    return () => clearInterval(interval)
  }, [])

  const applySetupType = useCallback((nextType: SetupType) => {
    setSetupType(nextType)
    setLastSuccessfulTestFingerprint(null)
    setConfig((current) => {
      if (nextType === 'legacy_pbx') {
        return {
          ...current,
          mode: 'pbx_ip_trust_legacy',
          providerPresetId: '',
          password: '',
        }
      }

      if (nextType === 'generic_sip') {
        return {
          ...current,
          mode: 'authenticated_sip',
          providerPresetId: 'generic_sip',
          transport: current.transport || 'udp',
        }
      }

      const preset = PROVIDER_PRESETS[0]
      return {
        ...current,
        mode: 'authenticated_sip',
        providerPresetId: current.providerPresetId || preset.id,
        transport: current.transport || preset.transport,
        sipPort: current.sipPort || preset.sipPort,
      }
    })
  }, [])

  const applyPreset = useCallback((presetId: string) => {
    const preset = PROVIDER_PRESETS.find((item) => item.id === presetId)
    if (!preset) return

    setLastSuccessfulTestFingerprint(null)
    setConfig((current) => ({
      ...current,
      mode: 'authenticated_sip',
      providerPresetId: preset.id,
      transport: preset.transport,
      sipPort: preset.sipPort,
      outboundProxy: preset.outboundProxy ?? current.outboundProxy,
    }))
  }, [])

  const handleFieldChange = useCallback(<K extends keyof CallerIdConfig>(key: K, value: CallerIdConfig[K]) => {
    setLastSuccessfulTestFingerprint(null)
    setConfig((current) => ({
      ...current,
      [key]: value,
      ...(key === 'password' && typeof value === 'string' && value.trim()
        ? { hasPassword: true }
        : {}),
    }))
  }, [])

  const handleTest = useCallback(async () => {
    setTesting(true)
    try {
      const payload = buildConfigPayload(config, true)
      const result = await callerIdTestConnection(payload)
      if (result.success) {
        setLastSuccessfulTestFingerprint(currentFingerprint)
        toast.success(result.message)
      } else {
        toast.error(result.message)
      }
    } catch (error: any) {
      toast.error(error?.message || t('settings.peripherals.callerId.testFailed', 'Connection test failed'))
    } finally {
      setTesting(false)
    }
  }, [config, currentFingerprint])

  const handleSaveAndActivate = useCallback(async () => {
    if (requiresFreshTest) {
      toast.error(
        t(
          'settings.peripherals.callerId.testBeforeSave',
          'Run a successful connection test after the latest changes before activating Caller ID.',
        ),
      )
      return
    }

    setSaving(true)
    try {
      const payload = buildConfigPayload(config, true)
      await callerIdSaveConfig(payload as CallerIdConfig)
      await callerIdStop().catch(() => null)
      await callerIdStart()
      await refreshState()
      toast.success(
        t(
          'settings.peripherals.callerId.saved',
          'Caller ID settings saved',
        ),
      )
    } catch (error: any) {
      toast.error(error?.message || t('settings.peripherals.callerId.saveFailed', 'Failed to save Caller ID settings'))
    } finally {
      setSaving(false)
    }
  }, [config, refreshState, requiresFreshTest, t])

  const handleDisable = useCallback(async () => {
    setSaving(true)
    try {
      await callerIdStop().catch(() => null)
      await callerIdSaveConfig(buildConfigPayload(config, false) as CallerIdConfig)
      await refreshState()
      toast.success(
        t(
          'settings.peripherals.callerId.disabled',
          'Caller ID has been disabled on this terminal.',
        ),
      )
    } catch (error: any) {
      toast.error(error?.message || t('settings.peripherals.callerId.disableFailed', 'Failed to disable Caller ID'))
    } finally {
      setSaving(false)
    }
  }, [config, refreshState, t])

  if (loading) {
    return (
      <div className="py-4 flex items-center gap-2 text-zinc-500">
        <Loader2 className="w-4 h-4 animate-spin" />
        <span className="text-sm">{t('common.loading', 'Loading...')}</span>
      </div>
    )
  }

  const authenticatedMode = setupType !== 'legacy_pbx'
  const unsupportedMessage =
    status?.reason === 'unsupported_provider'
      ? t(
          'settings.peripherals.callerId.unsupportedProvider',
          'This line appears to be locked behind an ISP router account. Caller ID in this build needs standard SIP credentials or PBX access.',
        )
      : t(
          'settings.peripherals.callerId.routerUnsupported',
          'If your ISP/router only shows telephony settings inside the router and does not give you SIP credentials, this Caller ID module is not supported in v1.',
        )

  // Single source of truth for the Save & Activate gate: drives both the disabled prop and
  // the button styling (green when enabled, neutral grey when blocked) so they cannot drift.
  const saveAndActivateDisabled =
    saving ||
    testing ||
    !config.sipServer.trim() ||
    !config.sipUsername.trim() ||
    (authenticatedMode && !config.hasPassword && !config.password?.trim()) ||
    requiresFreshTest

  return (
    <div className="space-y-4">
      {/* Body — all non-action content. The reserved bottom padding (pb-32) guarantees the last
          field / caution card / advanced block / router note clears the sticky Step 3 action bar
          instead of rendering underneath it at short heights (1282x802). */}
      <div className="space-y-4 pb-32">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <PhoneIncoming className="w-5 h-5 text-amber-400" />
          <h3 className="text-sm font-semibold text-zinc-200">
            {t('settings.peripherals.callerId.title', 'Caller ID (VoIP/SIP)')}
          </h3>
        </div>
        <div className="flex items-center gap-2">
          <span className={`text-xs font-medium ${statusTone(status)}`}>
            {t(`settings.peripherals.callerId.status.${statusLabel(status).toLowerCase()}`, statusLabel(status))}
          </span>
          {status?.registered && <CheckCircle className="w-3.5 h-3.5 text-green-400" />}
        </div>
      </div>

      {/* Compact one-line reminder (this terminal is the single source for the line). */}
      <div className="flex items-start gap-2 rounded-2xl border border-amber-500/20 bg-amber-500/10 px-3 py-2">
        <Info className="mt-0.5 h-4 w-4 flex-shrink-0 text-amber-300" />
        <p className="text-xs text-amber-100/90">
          {t(
            'settings.peripherals.callerId.singleSourceBody',
            'This terminal will capture incoming calls and forward them to the rest of the store. Do not enable the same line on multiple POS terminals.',
          )}
        </p>
      </div>

      {(status?.error || status?.reason) && (
        <div className="rounded-2xl border border-red-500/20 bg-red-500/10 p-3">
          <div className="flex items-start gap-2">
            <AlertCircle className="mt-0.5 h-4 w-4 flex-shrink-0 text-red-300" />
            <div className="space-y-1">
              <p className="text-xs font-medium text-red-200">
                {status?.error || toReasonMessage(status?.reason, t)}
              </p>
              {status?.reason && (
                <p className="text-xs text-red-200/80">{toReasonMessage(status.reason, t)}</p>
              )}
            </div>
          </div>
        </div>
      )}

      {/* STEP 1 — pick the kind of phone setup. The two common paths are prominent; the older PBX
          path is intentionally de-emphasised so it never reads as the default. */}
      <div className="space-y-2">
        <p className="text-[11px] font-semibold uppercase tracking-wide text-zinc-500">
          {t('settings.peripherals.callerId.steps.choose', 'Step 1 · Choose your phone setup')}
        </p>
        <div className="grid gap-2 sm:grid-cols-2">
          <button
            type="button"
            onClick={() => applySetupType('provider_preset')}
            className={`rounded-xl border px-3 py-3 text-left transition-colors active:border-zinc-600 ${
              setupType === 'provider_preset'
                ? 'border-amber-500 bg-amber-500/15 text-amber-100'
                : 'border-zinc-700 bg-zinc-900/40 text-zinc-300'
            }`}
          >
            <p className="text-sm font-medium">
              {t('settings.peripherals.callerId.setup.providerPreset', 'Provider preset')}
            </p>
            <p className="mt-1 text-xs opacity-80">
              {t(
                'settings.peripherals.callerId.setup.providerPresetHelp',
                'Start from common SIP defaults and edit the server details.',
              )}
            </p>
          </button>
          <button
            type="button"
            onClick={() => applySetupType('generic_sip')}
            className={`rounded-xl border px-3 py-3 text-left transition-colors active:border-zinc-600 ${
              setupType === 'generic_sip'
                ? 'border-amber-500 bg-amber-500/15 text-amber-100'
                : 'border-zinc-700 bg-zinc-900/40 text-zinc-300'
            }`}
          >
            <p className="text-sm font-medium">
              {t('settings.peripherals.callerId.setup.generic', 'Manual SIP')}
            </p>
            <p className="mt-1 text-xs opacity-80">
              {t(
                'settings.peripherals.callerId.setup.genericHelp',
                'Use the SIP server, username, and password from your provider or PBX.',
              )}
            </p>
          </button>
        </div>
        <button
          type="button"
          onClick={() => applySetupType('legacy_pbx')}
          className={`w-full rounded-xl border px-3 py-2 text-left transition-colors active:border-zinc-600 ${
            setupType === 'legacy_pbx'
              ? 'border-amber-500/60 bg-amber-500/10 text-amber-200'
              : 'border-zinc-800 bg-zinc-900/30 text-zinc-400'
          }`}
        >
          <span className="block text-xs font-medium">
            {t('settings.peripherals.callerId.setup.legacy', 'Older PBX')}
          </span>
          <span className="mt-0.5 block text-xs opacity-70">
            {t(
              'settings.peripherals.callerId.setup.legacyHelp',
              'Keep using an IP-trusted PBX registration flow for older installs.',
            )}
          </span>
        </button>
      </div>

      {/* STEP 2 — enter the line details (advanced/technical fields live behind the disclosure). */}
      <p className="text-[11px] font-semibold uppercase tracking-wide text-zinc-500">
        {t('settings.peripherals.callerId.steps.details', 'Step 2 · Enter your line details')}
      </p>

      {authenticatedMode && (
        <div className="space-y-1.5 rounded-2xl border border-zinc-800 bg-zinc-900/40 px-3 py-2.5">
          <p className="text-xs font-medium text-zinc-300">
            {t('settings.peripherals.callerId.checklist.title', "What you'll need")}
          </p>
          {([
            {
              key: 'server',
              done: Boolean(config.sipServer.trim()),
              fallback: 'Your phone server address (like sip.example.com)',
            },
            {
              key: 'username',
              done: Boolean(config.sipUsername.trim()),
              fallback: 'Your extension or username (like 200)',
            },
            {
              key: 'password',
              done: Boolean(config.hasPassword || config.password?.trim()),
              fallback: 'The password for that line',
            },
          ] as const).map((item) => (
            <div key={item.key} className="flex items-start gap-2">
              {item.done ? (
                <CheckCircle className="mt-0.5 h-3.5 w-3.5 flex-shrink-0 text-green-400" />
              ) : (
                <Circle className="mt-0.5 h-3.5 w-3.5 flex-shrink-0 text-zinc-600" />
              )}
              <span className={`text-xs ${item.done ? 'text-zinc-500' : 'text-zinc-300'}`}>
                {t(`settings.peripherals.callerId.checklist.${item.key}`, item.fallback)}
              </span>
            </div>
          ))}
        </div>
      )}

      {setupType === 'provider_preset' && (
        <div className="space-y-2">
          <label className="block text-xs text-zinc-400">
            {t('settings.peripherals.callerId.providerPreset', 'Preset')}
          </label>
          <select
            value={config.providerPresetId || PROVIDER_PRESETS[0].id}
            onChange={(event) => applyPreset(event.target.value)}
            className="w-full rounded-xl border border-zinc-700 bg-zinc-900/60 px-3 py-2 text-sm text-zinc-100 focus:border-amber-500 focus:outline-none"
          >
            {PROVIDER_PRESETS.map((preset) => (
              <option key={preset.id} value={preset.id}>
                {preset.labelKey ? t(preset.labelKey, preset.label) : preset.label}
              </option>
            ))}
          </select>
          <p className="text-xs text-zinc-500">
            {(() => {
              const selectedPreset = PROVIDER_PRESETS.find((preset) => preset.id === config.providerPresetId)
              return selectedPreset ? t(selectedPreset.descriptionKey, selectedPreset.description) : ''
            })()}
          </p>
        </div>
      )}

      <div className="grid gap-3 md:grid-cols-2">
        <div>
          <label className="mb-1 block text-xs text-zinc-400">
            {t('settings.peripherals.callerId.sipServer', 'SIP Server')}
          </label>
          <input
            type="text"
            value={config.sipServer}
            onChange={(event) => handleFieldChange('sipServer', event.target.value)}
            placeholder="sip.example.com"
            className="w-full rounded-xl border border-zinc-700 bg-zinc-900/60 px-3 py-2 text-sm text-zinc-100 placeholder-zinc-600 focus:border-amber-500 focus:outline-none"
          />
        </div>
        <div>
          <label className="mb-1 block text-xs text-zinc-400">
            {t('settings.peripherals.callerId.username', 'SIP Username / Extension')}
          </label>
          <input
            type="text"
            value={config.sipUsername}
            onChange={(event) => handleFieldChange('sipUsername', event.target.value)}
            placeholder="200"
            className="w-full rounded-xl border border-zinc-700 bg-zinc-900/60 px-3 py-2 text-sm text-zinc-100 placeholder-zinc-600 focus:border-amber-500 focus:outline-none"
          />
        </div>

        {authenticatedMode ? (
          <div>
            <label className="mb-1 block text-xs text-zinc-400">
              {t('settings.peripherals.callerId.password', 'SIP Password')}
            </label>
            <input
              type="password"
              value={config.password || ''}
              onChange={(event) => handleFieldChange('password', event.target.value)}
              placeholder={config.hasPassword ? 'Stored securely on this terminal' : 'Required'}
              className="w-full rounded-xl border border-zinc-700 bg-zinc-900/60 px-3 py-2 text-sm text-zinc-100 placeholder-zinc-600 focus:border-amber-500 focus:outline-none"
            />
            {config.hasPassword && !config.password?.trim() && (
              <p className="mt-1 flex items-center gap-1 text-xs text-zinc-500">
                <Lock className="h-3.5 w-3.5" />
                {t(
                  'settings.peripherals.callerId.passwordStored',
                  'A password is already stored securely on this POS terminal. Leave this blank to keep it.',
                )}
              </p>
            )}
          </div>
        ) : (
          <div className="rounded-2xl border border-amber-500/20 bg-amber-500/10 p-3 md:col-span-2">
            <div className="flex items-start gap-2">
              <Server className="mt-0.5 h-4 w-4 flex-shrink-0 text-amber-300" />
              <div>
                <p className="text-xs font-medium text-amber-200">
                  {t(
                    'settings.peripherals.callerId.legacyInfoTitle',
                    'Legacy PBX trust mode',
                  )}
                </p>
                <p className="mt-1 text-xs text-amber-100/80">
                  {t(
                    'settings.peripherals.callerId.legacyInfoBody',
                    'Use this only if your PBX trusts the POS terminal IP and does not require SIP username/password authentication.',
                  )}
                </p>
              </div>
            </div>
          </div>
        )}
        <div>
          <label className="mb-1 block text-xs text-zinc-400">
            {t('settings.peripherals.callerId.sipPort', 'SIP Port')}
          </label>
          <input
            type="number"
            value={config.sipPort}
            onChange={(event) => handleFieldChange('sipPort', Number(event.target.value) || 5060)}
            className="w-full rounded-xl border border-zinc-700 bg-zinc-900/60 px-3 py-2 text-sm text-zinc-100 focus:border-amber-500 focus:outline-none"
          />
        </div>
      </div>

      {/* Advanced (optional/technical) — Auth Username, Transport, Outbound Proxy, Listen Port.
          showAdvanced auto-opens (in the load effect) for non-default transport/proxy/listen port. */}
      <button
        type="button"
        onClick={() => setShowAdvanced((current) => !current)}
        className="flex w-full items-center justify-between rounded-xl border border-zinc-800 bg-zinc-900/40 px-3 py-2 text-sm text-zinc-200 transition-colors active:border-zinc-700"
      >
        <span>{t('settings.peripherals.callerId.advanced', 'Advanced settings')}</span>
        {showAdvanced ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
      </button>

      {showAdvanced && (
        <div className="grid gap-3 md:grid-cols-2">
          {authenticatedMode && (
            <div>
              <label className="mb-1 block text-xs text-zinc-400">
                {t('settings.peripherals.callerId.authUsername', 'Auth Username')}
              </label>
              <input
                type="text"
                value={config.authUsername || ''}
                onChange={(event) => handleFieldChange('authUsername', event.target.value)}
                placeholder={t(
                  'settings.peripherals.callerId.authUsernamePlaceholder',
                  'Leave blank to use the SIP username',
                )}
                className="w-full rounded-xl border border-zinc-700 bg-zinc-900/60 px-3 py-2 text-sm text-zinc-100 placeholder-zinc-600 focus:border-amber-500 focus:outline-none"
              />
            </div>
          )}
          {authenticatedMode && (
            <div>
              <label className="mb-1 block text-xs text-zinc-400">
                {t('settings.peripherals.callerId.transport', 'Transport')}
              </label>
              <select
                value={config.transport}
                onChange={(event) => handleFieldChange('transport', event.target.value as CallerIdTransport)}
                className="w-full rounded-xl border border-zinc-700 bg-zinc-900/60 px-3 py-2 text-sm text-zinc-100 focus:border-amber-500 focus:outline-none"
              >
                <option value="udp">UDP</option>
                <option value="tcp">TCP</option>
              </select>
            </div>
          )}
          {authenticatedMode && (
            <div>
              <label className="mb-1 block text-xs text-zinc-400">
                {t('settings.peripherals.callerId.outboundProxy', 'Outbound Proxy')}
              </label>
              <input
                type="text"
                value={config.outboundProxy || ''}
                onChange={(event) => handleFieldChange('outboundProxy', event.target.value)}
                placeholder="proxy.example.com:5060"
                className="w-full rounded-xl border border-zinc-700 bg-zinc-900/60 px-3 py-2 text-sm text-zinc-100 placeholder-zinc-600 focus:border-amber-500 focus:outline-none"
              />
            </div>
          )}
          <div>
            <label className="mb-1 block text-xs text-zinc-400">
              {t('settings.peripherals.callerId.listenPort', 'Local Listen Port')}
            </label>
            <input
              type="number"
              value={config.listenPort}
              onChange={(event) => handleFieldChange('listenPort', Number(event.target.value) || 5060)}
              className="w-full rounded-xl border border-zinc-700 bg-zinc-900/60 px-3 py-2 text-sm text-zinc-100 focus:border-amber-500 focus:outline-none"
            />
          </div>
        </div>
      )}

      {/* Router-only telephony note — only a prominent caution when the live status reason says the
          provider is unsupported; otherwise a quiet one-line note (no big always-on scary card). */}
      {status?.reason === 'unsupported_provider' ? (
        <div className="rounded-2xl border border-amber-500/20 bg-amber-500/10 p-3">
          <div className="flex items-start gap-2">
            <ShieldAlert className="mt-0.5 h-4 w-4 flex-shrink-0 text-amber-300" />
            <div className="space-y-1">
              <p className="text-xs font-medium text-amber-200">
                {t(
                  'settings.peripherals.callerId.routerUnsupportedTitle',
                  'Router-only telephony accounts are unsupported in v1',
                )}
              </p>
              <p className="text-xs text-amber-100/80">{unsupportedMessage}</p>
            </div>
          </div>
        </div>
      ) : (
        <p className="flex items-start gap-1.5 text-xs text-zinc-500">
          <Info className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" />
          {t(
            'settings.peripherals.callerId.routerNoteCompact',
            "Phone line that only lives inside your internet router, with no username or password? That isn't supported yet.",
          )}
        </p>
      )}

      {status && status.callsDetected > 0 && (
        <p className="text-xs text-zinc-500">
          {t('settings.peripherals.callerId.callsDetected', 'Calls detected')}: {status.callsDetected}
        </p>
      )}
      </div>

      {/* STEP 3 — test, then turn it on. Sticky within the section so Test/Save stay reachable while
          scrolling the form; the body above reserves space (pb-32) so content never sits under it.
          The glass is near-opaque (bg-zinc-950/95) so transient scrolled content cannot bleed
          through. Touch targets are >=44px with centered icon+text. */}
      <div className="sticky bottom-0 z-10 space-y-2 rounded-2xl border border-white/10 bg-zinc-950/95 px-3 py-3 backdrop-blur-md">
        <p className="text-[11px] font-semibold uppercase tracking-wide text-zinc-500">
          {t('settings.peripherals.callerId.steps.activate', 'Step 3 · Test, then turn it on')}
        </p>
        {requiresFreshTest && (
          <p className="text-xs text-amber-300">
            {t(
              'settings.peripherals.callerId.testRequiredHint',
              'Run Test Connection after any change before you activate Caller ID on this terminal.',
            )}
          </p>
        )}
        <div className="flex flex-col gap-2 sm:flex-row">
          <button
            type="button"
            onClick={handleTest}
            disabled={
              testing ||
              saving ||
              !config.sipServer.trim() ||
              !config.sipUsername.trim() ||
              (authenticatedMode && !config.hasPassword && !config.password?.trim())
            }
            className="inline-flex min-h-[44px] flex-1 items-center justify-center gap-1.5 rounded-xl bg-zinc-700 px-3 py-2 text-sm font-medium text-zinc-100 transition-transform duration-150 active:scale-95 active:bg-zinc-600 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {testing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
            {t('settings.peripherals.callerId.testConnection', 'Test Connection')}
          </button>

          <button
            type="button"
            onClick={handleSaveAndActivate}
            disabled={saveAndActivateDisabled}
            className={`inline-flex min-h-[44px] flex-1 items-center justify-center gap-1.5 rounded-xl px-3 py-2 text-sm font-medium transition-transform duration-150 active:scale-95 ${
              saveAndActivateDisabled
                ? 'bg-zinc-800 text-zinc-500 cursor-not-allowed'
                : 'bg-green-600 text-white active:bg-green-700'
            }`}
          >
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
            {t('settings.peripherals.callerId.saveAndActivate', 'Save & Activate')}
          </button>

          {(config.enabled || status?.status === 'listening' || status?.status === 'registering') && (
            <button
              type="button"
              onClick={handleDisable}
              disabled={saving || testing}
              className="inline-flex min-h-[44px] flex-1 items-center justify-center gap-1.5 rounded-xl bg-red-600/90 px-3 py-2 text-sm font-medium text-white transition-transform duration-150 active:scale-95 active:bg-red-500 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <Power className="h-4 w-4" />
              {t('settings.peripherals.callerId.disable', 'Disable')}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

export default CallerIdSection
