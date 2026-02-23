import React, { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Search,
  Bluetooth,
  Usb,
  Wifi,
  Plus,
  Loader2,
  X,
  AlertCircle,
  CheckCircle,
} from 'lucide-react'
import { LiquidGlassModal } from '../ui/pos-glass-components'

type ConnectionType = 'bluetooth' | 'serial_usb' | 'network'

interface DiscoveredDevice {
  name: string
  deviceType: string
  connectionType: ConnectionType
  connectionDetails: Record<string, unknown>
  manufacturer?: string
  model?: string
  isConfigured: boolean
}

interface Props {
  isOpen: boolean
  onClose: () => void
  onSelect: (device: DiscoveredDevice) => void
  discoverDevices: (types?: ConnectionType[]) => Promise<DiscoveredDevice[]>
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
      return null
  }
}

export const TerminalDiscoveryModal: React.FC<Props> = ({
  isOpen,
  onClose,
  onSelect,
  discoverDevices,
}) => {
  const { t } = useTranslation()
  const [isSearching, setIsSearching] = useState(false)
  const [devices, setDevices] = useState<DiscoveredDevice[]>([])
  const [error, setError] = useState<string | null>(null)
  const [searchTypes, setSearchTypes] = useState<ConnectionType[]>([
    'serial_usb',
    'bluetooth',
  ])

  const toggleSearchType = (type: ConnectionType) => {
    setSearchTypes((prev) =>
      prev.includes(type)
        ? prev.filter((t) => t !== type)
        : [...prev, type]
    )
  }

  const handleSearch = async () => {
    if (searchTypes.length === 0) {
      setError(t('ecr.discovery.selectType', 'Select at least one connection type'))
      return
    }

    setIsSearching(true)
    setError(null)
    setDevices([])

    try {
      const found = await discoverDevices(searchTypes)
      setDevices(found)

      if (found.length === 0) {
        setError(t('ecr.discovery.noDevices', 'No payment terminals found'))
      }
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : t('ecr.discovery.error', 'Discovery failed')
      )
    } finally {
      setIsSearching(false)
    }
  }

  // Auto-search on open
  useEffect(() => {
    if (isOpen) {
      handleSearch()
    } else {
      setDevices([])
      setError(null)
    }
  }, [isOpen])

  return (
    <LiquidGlassModal
      isOpen={isOpen}
      onClose={onClose}
      title={t('ecr.discovery.title', 'Discover Payment Terminals')}
      size="md"
      className="!max-w-lg"
    >
      <div className="space-y-6">
        {/* Search type toggles */}
        <div className="flex flex-wrap gap-3">
          <button
            onClick={() => toggleSearchType('serial_usb')}
            className={`flex items-center gap-2 px-4 py-2 rounded-lg transition-colors ${
              searchTypes.includes('serial_usb')
                ? 'bg-blue-500/30 text-blue-300 border border-blue-500/50'
                : 'bg-gray-700/50 text-gray-400 border border-gray-700'
            }`}
          >
            <Usb className="w-4 h-4" />
            {t('ecr.connection.usb', 'USB/Serial')}
          </button>
          <button
            onClick={() => toggleSearchType('bluetooth')}
            className={`flex items-center gap-2 px-4 py-2 rounded-lg transition-colors ${
              searchTypes.includes('bluetooth')
                ? 'bg-blue-500/30 text-blue-300 border border-blue-500/50'
                : 'bg-gray-700/50 text-gray-400 border border-gray-700'
            }`}
          >
            <Bluetooth className="w-4 h-4" />
            {t('ecr.connection.bluetooth', 'Bluetooth')}
          </button>
          <button
            onClick={() => toggleSearchType('network')}
            className={`flex items-center gap-2 px-4 py-2 rounded-lg transition-colors ${
              searchTypes.includes('network')
                ? 'bg-blue-500/30 text-blue-300 border border-blue-500/50'
                : 'bg-gray-700/50 text-gray-400 border border-gray-700'
            }`}
          >
            <Wifi className="w-4 h-4" />
            {t('ecr.connection.network', 'Network')}
          </button>
        </div>

        {/* Search button */}
        <button
          onClick={handleSearch}
          disabled={isSearching || searchTypes.length === 0}
          className="w-full flex items-center justify-center gap-2 py-3 rounded-lg bg-blue-500/20 text-blue-400 hover:bg-blue-500/30 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {isSearching ? (
            <>
              <Loader2 className="w-5 h-5 animate-spin" />
              {t('ecr.discovery.searching', 'Searching...')}
            </>
          ) : (
            <>
              <Search className="w-5 h-5" />
              {t('ecr.discovery.search', 'Search for Terminals')}
            </>
          )}
        </button>

        {/* Error message */}
        {error && !isSearching && (
          <div className="flex items-center gap-3 p-4 rounded-lg bg-red-500/10 border border-red-500/30">
            <AlertCircle className="w-5 h-5 text-red-400 flex-shrink-0" />
            <p className="text-red-400 text-sm">{error}</p>
          </div>
        )}

        {/* Device list */}
        {devices.length > 0 && (
          <div className="space-y-3">
            <h3 className="text-sm font-medium text-gray-400">
              {t('ecr.discovery.found', 'Found Devices')} ({devices.length})
            </h3>
            <div className="space-y-2 max-h-64 overflow-y-auto">
              {devices.map((device, index) => (
                <div
                  key={index}
                  className={`flex items-center justify-between p-4 rounded-lg border transition-colors ${
                    device.isConfigured
                      ? 'bg-gray-700/30 border-gray-700/50 opacity-60'
                      : 'bg-gray-700/50 border-gray-700 hover:bg-gray-700/70 cursor-pointer'
                  }`}
                  onClick={() => !device.isConfigured && onSelect(device)}
                >
                  <div className="flex items-center gap-3">
                    <div className="p-2 rounded-lg bg-gray-600/50">
                      <ConnectionIcon
                        type={device.connectionType}
                        className="w-5 h-5 text-gray-300"
                      />
                    </div>
                    <div>
                      <p className="font-medium text-white">{device.name}</p>
                      <p className="text-sm text-gray-400">
                        {device.manufacturer && `${device.manufacturer} `}
                        {device.model}
                      </p>
                    </div>
                  </div>
                  {device.isConfigured ? (
                    <div className="flex items-center gap-2 text-green-400">
                      <CheckCircle className="w-4 h-4" />
                      <span className="text-sm">
                        {t('ecr.discovery.configured', 'Configured')}
                      </span>
                    </div>
                  ) : (
                    <button
                      onClick={(e) => {
                        e.stopPropagation()
                        onSelect(device)
                      }}
                      className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-blue-500/20 text-blue-400 hover:bg-blue-500/30 transition-colors"
                    >
                      <Plus className="w-4 h-4" />
                      {t('common.add', 'Add')}
                    </button>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Manual add option */}
        <div className="pt-4 border-t border-gray-700">
          <p className="text-sm text-gray-400 mb-3">
            {t('ecr.discovery.manual', "Can't find your terminal?")}
          </p>
          <button
            onClick={() =>
              onSelect({
                name: '',
                deviceType: 'payment_terminal',
                connectionType: 'serial_usb',
                connectionDetails: {},
                isConfigured: false,
              })
            }
            className="w-full py-3 rounded-lg bg-gray-700/50 text-gray-300 hover:bg-gray-700 transition-colors"
          >
            {t('ecr.discovery.addManually', 'Add Terminal Manually')}
          </button>
        </div>
      </div>
    </LiquidGlassModal>
  )
}
