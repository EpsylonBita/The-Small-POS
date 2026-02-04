/**
 * TerminalCardCompact - Compact terminal card for settings modal
 *
 * A space-efficient terminal display that fits the liquid glass design
 * language of the settings modal.
 */

import React, { memo } from 'react'
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
        bg: 'bg-green-500/20',
      }
    case 'connecting':
      return {
        label: 'Connecting',
        icon: Loader2,
        color: 'text-yellow-400',
        bg: 'bg-yellow-500/20',
        spin: true,
      }
    case 'error':
      return {
        label: 'Error',
        icon: AlertCircle,
        color: 'text-red-400',
        bg: 'bg-red-500/20',
      }
    case 'busy':
      return {
        label: 'Busy',
        icon: Loader2,
        color: 'text-blue-400',
        bg: 'bg-blue-500/20',
        spin: true,
      }
    default:
      return {
        label: 'Disconnected',
        icon: WifiOff,
        color: 'text-gray-400',
        bg: 'bg-gray-500/20',
      }
  }
}

// ============================================================
// COMPONENT
// ============================================================

export const TerminalCardCompact: React.FC<Props> = memo(
  ({ device, status, onConnect, onDisconnect, onEdit, onDelete, onSetDefault }) => {
    const { t } = useTranslation()
    const ConnectionIcon = getConnectionIcon(device.connectionType)
    const statusInfo = getStatusInfo(status?.state)
    const StatusIcon = statusInfo.icon
    const isConnected = status?.state === 'connected'
    const isConnecting = status?.state === 'connecting'

    return (
      <div className="rounded-lg p-3 bg-white/5 dark:bg-gray-800/20 border liquid-glass-modal-border hover:bg-white/10 dark:hover:bg-gray-800/30 transition-all">
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
                  <span title={t('ecr.defaultTerminal', 'Default Terminal')}>
                    <Star
                      size={12}
                      className="text-yellow-400 fill-yellow-400 flex-shrink-0"
                    />
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
                className="p-1.5 rounded-md text-red-400 hover:bg-red-500/20 transition-colors"
                title={t('ecr.actions.disconnect', 'Disconnect')}
              >
                <WifiOff size={14} />
              </button>
            ) : (
              <button
                onClick={onConnect}
                disabled={isConnecting}
                className="p-1.5 rounded-md text-green-400 hover:bg-green-500/20 transition-colors disabled:opacity-50"
                title={t('ecr.actions.connect', 'Connect')}
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
                className="p-1.5 rounded-md liquid-glass-modal-text-muted hover:text-yellow-400 hover:bg-yellow-500/20 transition-colors"
                title={t('ecr.actions.setDefault', 'Set as Default')}
              >
                <Star size={14} />
              </button>
            )}

            {/* Edit Button */}
            <button
              onClick={onEdit}
              className="p-1.5 rounded-md liquid-glass-modal-text-muted hover:liquid-glass-modal-text hover:bg-white/10 transition-colors"
              title={t('ecr.actions.edit', 'Edit')}
            >
              <Settings size={14} />
            </button>

            {/* Delete Button */}
            <button
              onClick={onDelete}
              className="p-1.5 rounded-md text-red-400/60 hover:text-red-400 hover:bg-red-500/20 transition-colors"
              title={t('ecr.actions.delete', 'Delete')}
            >
              <Trash2 size={14} />
            </button>
          </div>
        </div>
      </div>
    )
  }
)

TerminalCardCompact.displayName = 'TerminalCardCompact'

export default TerminalCardCompact
