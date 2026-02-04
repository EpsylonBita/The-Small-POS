import React from 'react'
import { useTranslation } from 'react-i18next'
import {
  CreditCard,
  Bluetooth,
  Usb,
  Wifi,
  Settings,
  Power,
  PowerOff,
  Star,
  Trash2,
} from 'lucide-react'
import { TerminalStatusIndicator } from './TerminalStatusIndicator'

type DeviceState = 'disconnected' | 'connecting' | 'connected' | 'busy' | 'error'
type ConnectionType = 'bluetooth' | 'serial_usb' | 'network'
type Protocol = 'generic' | 'zvt' | 'pax'

interface ECRDevice {
  id: string
  name: string
  deviceType: string
  connectionType: ConnectionType
  protocol: Protocol
  terminalId?: string
  isDefault: boolean
  enabled: boolean
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

const ConnectionIcon: React.FC<{ type: ConnectionType; className?: string }> = ({
  type,
  className = 'w-5 h-5',
}) => {
  switch (type) {
    case 'bluetooth':
      return <Bluetooth className={className} />
    case 'serial_usb':
      return <Usb className={className} />
    case 'network':
      return <Wifi className={className} />
    default:
      return <CreditCard className={className} />
  }
}

export const TerminalCard: React.FC<Props> = ({
  device,
  status,
  onConnect,
  onDisconnect,
  onEdit,
  onDelete,
  onSetDefault,
}) => {
  const { t } = useTranslation()
  const isConnected = status?.state === 'connected'
  const isConnecting = status?.state === 'connecting'

  const protocolLabels: Record<Protocol, string> = {
    generic: 'Generic ECR',
    zvt: 'ZVT (Ingenico/Verifone)',
    pax: 'PAX Protocol',
  }

  return (
    <div
      className={`
        relative rounded-xl p-4
        bg-gradient-to-br from-gray-800/80 to-gray-900/80
        backdrop-blur-sm border border-gray-700/50
        transition-all duration-200
        ${!device.enabled ? 'opacity-60' : ''}
        ${device.isDefault ? 'ring-2 ring-blue-500/50' : ''}
      `}
    >
      {/* Header */}
      <div className="flex items-start justify-between mb-3">
        <div className="flex items-center gap-3">
          <div className="p-2 rounded-lg bg-gray-700/50">
            <ConnectionIcon type={device.connectionType} className="w-6 h-6 text-gray-300" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h3 className="font-semibold text-white">{device.name}</h3>
              {device.isDefault && (
                <Star className="w-4 h-4 text-yellow-400 fill-yellow-400" />
              )}
            </div>
            <p className="text-sm text-gray-400">{protocolLabels[device.protocol]}</p>
          </div>
        </div>
        <TerminalStatusIndicator
          state={status?.state || 'disconnected'}
          showLabel
        />
      </div>

      {/* Info */}
      <div className="space-y-1 mb-4">
        {device.terminalId && (
          <p className="text-sm text-gray-400">
            {t('ecr.terminalId', 'Terminal ID')}: {device.terminalId}
          </p>
        )}
        {status?.errorMessage && (
          <p className="text-sm text-red-400">{status.errorMessage}</p>
        )}
      </div>

      {/* Actions */}
      <div className="flex items-center gap-2">
        {isConnected ? (
          <button
            onClick={onDisconnect}
            className="flex items-center gap-2 px-3 py-2 rounded-lg bg-red-500/20 text-red-400 hover:bg-red-500/30 transition-colors"
          >
            <PowerOff className="w-4 h-4" />
            {t('ecr.disconnect', 'Disconnect')}
          </button>
        ) : (
          <button
            onClick={onConnect}
            disabled={isConnecting || !device.enabled}
            className="flex items-center gap-2 px-3 py-2 rounded-lg bg-green-500/20 text-green-400 hover:bg-green-500/30 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <Power className="w-4 h-4" />
            {isConnecting
              ? t('ecr.connecting', 'Connecting...')
              : t('ecr.connect', 'Connect')}
          </button>
        )}

        <button
          onClick={onEdit}
          className="p-2 rounded-lg bg-gray-700/50 text-gray-300 hover:bg-gray-700 transition-colors"
          title={t('common.edit', 'Edit')}
        >
          <Settings className="w-4 h-4" />
        </button>

        {!device.isDefault && (
          <button
            onClick={onSetDefault}
            className="p-2 rounded-lg bg-gray-700/50 text-gray-300 hover:bg-gray-700 transition-colors"
            title={t('ecr.setDefault', 'Set as default')}
          >
            <Star className="w-4 h-4" />
          </button>
        )}

        <button
          onClick={onDelete}
          className="p-2 rounded-lg bg-gray-700/50 text-red-400 hover:bg-red-500/20 transition-colors"
          title={t('common.delete', 'Delete')}
        >
          <Trash2 className="w-4 h-4" />
        </button>
      </div>
    </div>
  )
}
