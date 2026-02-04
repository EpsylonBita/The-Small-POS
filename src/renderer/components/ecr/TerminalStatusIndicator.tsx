import React from 'react'
import { useTranslation } from 'react-i18next'

type DeviceState = 'disconnected' | 'connecting' | 'connected' | 'busy' | 'error'

interface Props {
  state: DeviceState
  showLabel?: boolean
  size?: 'sm' | 'md' | 'lg'
}

const stateColors: Record<DeviceState, string> = {
  connected: 'bg-green-500',
  disconnected: 'bg-gray-500',
  connecting: 'bg-yellow-500 animate-pulse',
  busy: 'bg-blue-500 animate-pulse',
  error: 'bg-red-500',
}

const sizeClasses = {
  sm: 'w-2 h-2',
  md: 'w-3 h-3',
  lg: 'w-4 h-4',
}

export const TerminalStatusIndicator: React.FC<Props> = ({
  state,
  showLabel = false,
  size = 'md',
}) => {
  const { t } = useTranslation()

  const labels: Record<DeviceState, string> = {
    connected: t('ecr.status.connected', 'Connected'),
    disconnected: t('ecr.status.disconnected', 'Disconnected'),
    connecting: t('ecr.status.connecting', 'Connecting...'),
    busy: t('ecr.status.busy', 'Processing'),
    error: t('ecr.status.error', 'Error'),
  }

  return (
    <div className="flex items-center gap-2">
      <span
        className={`inline-block rounded-full ${sizeClasses[size]} ${stateColors[state]}`}
      />
      {showLabel && (
        <span className="text-sm text-gray-300">{labels[state]}</span>
      )}
    </div>
  )
}
