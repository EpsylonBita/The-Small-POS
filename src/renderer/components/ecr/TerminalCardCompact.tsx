/**
 * TerminalCardCompact - Compact terminal card for settings modal
 *
 * A space-efficient terminal display that fits the liquid glass design
 * language of the settings modal.
 */

import React, { memo, useId } from 'react'
import { useTranslation } from 'react-i18next'
import {
  CreditCard,
  Wifi,
  WifiOff,
  Bluetooth,
  Usb,
  Network,
  Settings,
  Trash2,
  Star,
  Loader2,
  AlertCircle,
} from 'lucide-react'

// ============================================================
// TYPES
// ============================================================

type ConnectionType = 'bluetooth' | 'serial_usb' | 'network'
type DeviceState = 'disconnected' | 'connecting' | 'connected' | 'busy' | 'error'

interface ECRDevice {
  id: string
  name: string
  deviceType: string
  connectionType: ConnectionType
  connectionDetails: Record<string, unknown>
  protocol: string
  terminalId?: string
  merchantId?: string
  isDefault: boolean
  enabled: boolean
  settings: Record<string, unknown>
}

interface ECRDeviceStatus {
  deviceId: string
  state: DeviceState
  isOnline: boolean
  lastSeen?: Date
  errorMessage?: string
}

interface Props {
  device: ECRDevice
  status?: ECRDeviceStatus
  onConnect: () => void
  onDisconnect: () => void
  onEdit: () => void
  onDelete: () => void
  onSetDefault: () => void
  /** Plain-language states shown under the card, e.g. "needs its plugin" (founder rule 08/10/2026). */
  notices?: string[]
  /** When given and the device is enabled, a Disable action is shown (a non-admitted device must stay removable/disableable). */
  onDisable?: () => void
}

// ============================================================
// HELPERS
// ============================================================

const getConnectionIcon = (type: ConnectionType) => {
  switch (type) {
    case 'bluetooth':
      return Bluetooth
    case 'serial_usb':
      return Usb
    case 'network':
      return Network
    default:
      return CreditCard
  }
}

const getStatusInfo = (state?: DeviceState) => {
  switch (state) {
    case 'connected':
      return {
        label: 'Connected',
        icon: Wifi,
        color: 'text-green-400',
        bg: 'bg-green-50 dark:bg-green-950',
      }
    case 'connecting':
      return {
        label: 'Connecting',
        icon: Loader2,
        color: 'text-yellow-400',
        bg: 'bg-yellow-50 dark:bg-yellow-950',
        spin: true,
      }
    case 'error':
      return {
        label: 'Error',
        icon: AlertCircle,
        color: 'text-red-400',
        bg: 'bg-red-50 dark:bg-red-950',
      }
    case 'busy':
      return {
        label: 'Busy',
        icon: Loader2,
        color: 'text-amber-400',
        bg: 'bg-amber-50 dark:bg-amber-950',
        spin: true,
      }
    default:
      return {
        label: 'Disconnected',
        icon: WifiOff,
        color: 'text-zinc-500 dark:text-zinc-400',
        bg: '',
      }
  }
}

// ============================================================
// COMPONENT
// ============================================================

export const TerminalCardCompact: React.FC<Props> = memo(
  ({ device, status, onConnect, onDisconnect, onEdit, onDelete, onSetDefault, notices, onDisable }) => {
    const { t } = useTranslation()
    const ConnectionIcon = getConnectionIcon(device.connectionType)
    const statusInfo = getStatusInfo(status?.state)
    const StatusIcon = statusInfo.icon
    const isConnected = status?.state === 'connected'
    const isConnecting = status?.state === 'connecting'
    const bluetoothUnavailable = device.connectionType === 'bluetooth'
    const bluetoothUnavailableMessage = t(
      'ecr.bluetoothUnavailable',
      'Bluetooth payment terminals are not available in this version. Use USB/Serial or Network (TCP).'
    )
    // Touchscreen POS: the reason is the visible notice under the card, tied
    // to the disabled Connect button for screen readers (no hover tooltip).
    const bluetoothNoticeId = useId()

    return (
      <div className="rounded-2xl p-3 border liquid-glass-modal-border transition-all">
        <div className="flex items-center justify-between gap-3">
          {/* Left: Icon + Info */}
          <div className="flex items-center gap-3 flex-1 min-w-0">
            <div className={`w-9 h-9 rounded-lg flex items-center justify-center ${statusInfo.bg}`}>
              <CreditCard size={18} className={statusInfo.color} />
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="font-medium liquid-glass-modal-text truncate">
                  {device.name}
                </span>
                {device.isDefault && (
                  <span role="img" aria-label={t('ecr.defaultTerminal', 'Default Terminal')}>
                    <Star
                      size={12}
                      className="text-yellow-400 fill-yellow-400 shrink-0"
                    />
                  </span>
                )}
                {!device.enabled && (
                  <span className="text-xs px-1.5 py-0.5 rounded-sm text-zinc-600 dark:text-zinc-400 shrink-0">
                    {t('ecr.admission.disabledBadge', { defaultValue: 'Disabled' })}
                  </span>
                )}
              </div>
              <div className="flex items-center gap-2 mt-0.5">
                <ConnectionIcon size={12} className="liquid-glass-modal-text-muted" />
                <span className="text-xs liquid-glass-modal-text-muted">
                  {device.connectionType === 'serial_usb'
                    ? 'USB/Serial'
                    : device.connectionType === 'bluetooth'
                      ? 'Bluetooth'
                      : 'Network'}
                </span>
                <span className="text-xs liquid-glass-modal-text-muted">•</span>
                <StatusIcon
                  size={12}
                  className={`${statusInfo.color} ${statusInfo.spin ? 'animate-spin' : ''}`}
                />
                <span className={`text-xs ${statusInfo.color}`}>
                  {t(`ecr.status.${status?.state || 'disconnected'}`, statusInfo.label)}
                </span>
              </div>
            </div>
          </div>

          {/* Right: Actions */}
          <div className="flex items-center gap-1">
            {/* Connect/Disconnect Button */}
            {isConnected ? (
              <button
                onClick={onDisconnect}
                className="pos-icon-btn pos-icon-btn--danger"
                aria-label={t('ecr.actions.disconnect', 'Disconnect')}
              >
                <WifiOff size={14} />
              </button>
            ) : (
              <button
                onClick={onConnect}
                disabled={isConnecting || bluetoothUnavailable}
                className="pos-icon-btn"
                aria-label={t('ecr.actions.connect', 'Connect')}
                aria-describedby={bluetoothUnavailable ? bluetoothNoticeId : undefined}
              >
                {isConnecting ? (
                  <Loader2 size={14} className="animate-spin" />
                ) : (
                  <Wifi size={14} />
                )}
              </button>
            )}

            {/* Set Default Button */}
            {!device.isDefault && (
              <button
                onClick={onSetDefault}
                className="pos-icon-btn"
                aria-label={t('ecr.actions.setDefault', 'Set as Default')}
              >
                <Star size={14} />
              </button>
            )}

            {/* Edit Button */}
            <button
              onClick={onEdit}
              className="pos-icon-btn"
              aria-label={t('ecr.actions.edit', 'Edit')}
            >
              <Settings size={14} />
            </button>

            {/* Delete Button */}
            <button
              onClick={onDelete}
              className="pos-icon-btn pos-icon-btn--danger"
              aria-label={t('ecr.actions.delete', 'Delete')}
            >
              <Trash2 size={14} />
            </button>
          </div>
        </div>
        {bluetoothUnavailable && (
          <p id={bluetoothNoticeId} className="mt-2 text-xs text-amber-700 dark:text-amber-300">
            {bluetoothUnavailableMessage}
          </p>
        )}
        {notices?.map((notice) => (
          <p
            key={notice}
            role="status"
            className="mt-2 flex items-start gap-1.5 text-xs text-amber-700 dark:text-amber-300"
          >
            <AlertCircle size={12} className="mt-0.5 shrink-0" />
            <span>{notice}</span>
          </p>
        ))}
        {onDisable && device.enabled && (
          <div className="mt-2 flex justify-end">
            <button
              type="button"
              onClick={onDisable}
              className="pos-solid-btn pos-solid-btn--sm"
            >
              {t('ecr.admission.disable', { defaultValue: 'Disable' })}
            </button>
          </div>
        )}
      </div>
    )
  }
)

TerminalCardCompact.displayName = 'TerminalCardCompact'

export default TerminalCardCompact
