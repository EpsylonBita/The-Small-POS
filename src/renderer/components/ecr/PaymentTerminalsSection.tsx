/**
 * PaymentTerminalsSection - ECR Device Management for Settings Modal
 *
 * A redesigned payment terminals interface that matches the liquid glass
 * design language of the settings modal. Replaces the embedded page approach.
 */

import React, { useState, useEffect, useCallback, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'react-hot-toast'
import {
  ArrowLeft,
  CreditCard,
  Plus,
  RefreshCw,
  Search,
  Loader2,
  AlertCircle,
  CheckCircle,
  XCircle,
  Wifi,
  WifiOff,
  ChevronDown,
} from 'lucide-react'
import { liquidGlassModalButton } from '../../styles/designSystem'
import { TerminalCardCompact } from './TerminalCardCompact'
import { TerminalDiscoveryModal } from './TerminalDiscoveryModal'
import { TerminalConfigModal } from './TerminalConfigModal'

// ============================================================
// TYPES
// ============================================================

type ConnectionType = 'bluetooth' | 'serial_usb' | 'network'
type Protocol = 'generic' | 'zvt' | 'pax'
type DeviceState = 'disconnected' | 'connecting' | 'connected' | 'busy' | 'error'

interface ECRDevice {
  id: string
  name: string
  deviceType: string
  connectionType: ConnectionType
  connectionDetails: Record<string, unknown>
  protocol: Protocol
  terminalId?: string
  merchantId?: string
  isDefault: boolean
  enabled: boolean
  settings: Record<string, unknown>
  createdAt?: string
  updatedAt?: string
}

interface ECRDeviceStatus {
  deviceId: string
  state: DeviceState
  isOnline: boolean
  lastSeen?: Date
  errorMessage?: string
}

interface DiscoveredDevice {
  name: string
  deviceType: string
  connectionType: ConnectionType
  connectionDetails: Record<string, unknown>
  manufacturer?: string
  model?: string
  isConfigured: boolean
}

interface TerminalStats {
  total: number
  connected: number
  disconnected: number
  error: number
}

// ============================================================
// IPC API
// ============================================================

const ecrAPI = {
  discoverDevices: async (types?: ConnectionType[]): Promise<DiscoveredDevice[]> => {
    const result = await (window as any).electronAPI?.invoke('ecr:discover-devices', types)
    return result || []
  },
  getDevices: async (): Promise<ECRDevice[]> => {
    const result = await (window as any).electronAPI?.invoke('ecr:get-devices')
    return result || []
  },
  addDevice: async (
    config: Omit<ECRDevice, 'id' | 'createdAt' | 'updatedAt'>
  ): Promise<ECRDevice> => {
    return (window as any).electronAPI?.invoke('ecr:add-device', config)
  },
  updateDevice: async (
    deviceId: string,
    updates: Partial<ECRDevice>
  ): Promise<ECRDevice | null> => {
    return (window as any).electronAPI?.invoke('ecr:update-device', deviceId, updates)
  },
  removeDevice: async (deviceId: string): Promise<boolean> => {
    return (window as any).electronAPI?.invoke('ecr:remove-device', deviceId)
  },
  connectDevice: async (deviceId: string): Promise<void> => {
    return (window as any).electronAPI?.invoke('ecr:connect-device', deviceId)
  },
  disconnectDevice: async (deviceId: string): Promise<void> => {
    return (window as any).electronAPI?.invoke('ecr:disconnect-device', deviceId)
  },
  getDeviceStatus: async (deviceId: string): Promise<ECRDeviceStatus | null> => {
    return (window as any).electronAPI?.invoke('ecr:get-device-status', deviceId)
  },
  getAllStatuses: async (): Promise<Record<string, ECRDeviceStatus>> => {
    const result = await (window as any).electronAPI?.invoke('ecr:get-all-statuses')
    return result || {}
  },
}

// ============================================================
// MINI STAT CARD COMPONENT
// ============================================================

interface MiniStatCardProps {
  label: string
  value: number
  icon: typeof CreditCard
  color: 'indigo' | 'green' | 'gray' | 'red'
}

const colorMap = {
  indigo: {
    bg: 'bg-indigo-500/20',
    text: 'text-indigo-400',
    shadow: 'drop-shadow-[0_0_6px_rgba(99,102,241,0.5)]',
  },
  green: {
    bg: 'bg-green-500/20',
    text: 'text-green-400',
    shadow: 'drop-shadow-[0_0_6px_rgba(34,197,94,0.5)]',
  },
  gray: {
    bg: 'bg-gray-500/20',
    text: 'text-gray-400',
    shadow: '',
  },
  red: {
    bg: 'bg-red-500/20',
    text: 'text-red-400',
    shadow: 'drop-shadow-[0_0_6px_rgba(239,68,68,0.5)]',
  },
}

const MiniStatCard: React.FC<MiniStatCardProps> = ({ label, value, icon: Icon, color }) => {
  const colors = colorMap[color]
  return (
    <div className="rounded-lg p-2 bg-white/5 dark:bg-gray-800/20 border liquid-glass-modal-border">
      <div className="flex items-center gap-2">
        <div className={`w-7 h-7 rounded-md flex items-center justify-center ${colors.bg}`}>
          <Icon size={14} className={`${colors.text} ${colors.shadow}`} />
        </div>
        <div>
          <p className="text-lg font-bold liquid-glass-modal-text">{value}</p>
          <p className="text-[10px] liquid-glass-modal-text-muted">{label}</p>
        </div>
      </div>
    </div>
  )
}

// ============================================================
// MAIN SECTION COMPONENT
// ============================================================

interface Props {
  onBack: () => void
}

export const PaymentTerminalsSection: React.FC<Props> = ({ onBack }) => {
  const { t } = useTranslation()

  // State
  const [devices, setDevices] = useState<ECRDevice[]>([])
  const [statuses, setStatuses] = useState<Record<string, ECRDeviceStatus>>({})
  const [loading, setLoading] = useState(true)
  const [isRefreshing, setIsRefreshing] = useState(false)
  const [isOnline, setIsOnline] = useState(navigator.onLine)
  const [showTerminalsList, setShowTerminalsList] = useState(true)

  // Modals
  const [showDiscoveryModal, setShowDiscoveryModal] = useState(false)
  const [showConfigModal, setShowConfigModal] = useState(false)
  const [editingDevice, setEditingDevice] = useState<ECRDevice | undefined>()
  const [selectedDiscoveredDevice, setSelectedDiscoveredDevice] = useState<
    DiscoveredDevice | undefined
  >()

  // Monitor online status
  useEffect(() => {
    const handleOnline = () => setIsOnline(true)
    const handleOffline = () => setIsOnline(false)

    window.addEventListener('online', handleOnline)
    window.addEventListener('offline', handleOffline)

    return () => {
      window.removeEventListener('online', handleOnline)
      window.removeEventListener('offline', handleOffline)
    }
  }, [])

  // Fetch devices and statuses
  const fetchData = useCallback(async () => {
    try {
      setLoading(true)
      const [deviceList, deviceStatuses] = await Promise.all([
        ecrAPI.getDevices(),
        ecrAPI.getAllStatuses(),
      ])
      setDevices(deviceList)
      setStatuses(deviceStatuses)
    } catch (err) {
      console.error('Failed to fetch ECR devices:', err)
      toast.error(t('ecr.errors.fetchFailed', 'Failed to load payment terminals'))
    } finally {
      setLoading(false)
    }
  }, [t])

  // Initial fetch
  useEffect(() => {
    fetchData()
  }, [fetchData])

  // Set up event listeners for status updates
  useEffect(() => {
    const handleDeviceConnected = (deviceId: string) => {
      setStatuses((prev) => ({
        ...prev,
        [deviceId]: {
          ...prev[deviceId],
          deviceId,
          state: 'connected',
          isOnline: true,
          lastSeen: new Date(),
        },
      }))
      toast.success(t('ecr.status.connected', 'Terminal connected'))
    }

    const handleDeviceDisconnected = (deviceId: string) => {
      setStatuses((prev) => ({
        ...prev,
        [deviceId]: {
          ...prev[deviceId],
          deviceId,
          state: 'disconnected',
          isOnline: false,
        },
      }))
    }

    const handleStatusChanged = (deviceId: string, status: ECRDeviceStatus) => {
      setStatuses((prev) => ({
        ...prev,
        [deviceId]: status,
      }))
    }

    const api = (window as any).electronAPI
    if (api?.ipcRenderer) {
      api.ipcRenderer.on('ecr:event:device-connected', handleDeviceConnected)
      api.ipcRenderer.on('ecr:event:device-disconnected', handleDeviceDisconnected)
      api.ipcRenderer.on('ecr:event:device-status-changed', handleStatusChanged)
    }

    return () => {
      if (api?.ipcRenderer) {
        api.ipcRenderer.removeListener('ecr:event:device-connected', handleDeviceConnected)
        api.ipcRenderer.removeListener('ecr:event:device-disconnected', handleDeviceDisconnected)
        api.ipcRenderer.removeListener('ecr:event:device-status-changed', handleStatusChanged)
      }
    }
  }, [t])

  // Handlers
  const handleRefresh = useCallback(async () => {
    setIsRefreshing(true)
    try {
      await fetchData()
      toast.success(t('ecr.refreshSuccess', 'Terminals refreshed'))
    } catch {
      toast.error(t('ecr.refreshError', 'Failed to refresh'))
    } finally {
      setIsRefreshing(false)
    }
  }, [fetchData, t])

  const handleConnect = useCallback(
    async (deviceId: string) => {
      try {
        setStatuses((prev) => ({
          ...prev,
          [deviceId]: {
            ...prev[deviceId],
            deviceId,
            state: 'connecting',
            isOnline: false,
          },
        }))
        await ecrAPI.connectDevice(deviceId)
      } catch (err) {
        toast.error(
          err instanceof Error ? err.message : t('ecr.errors.connectFailed', 'Connection failed')
        )
        setStatuses((prev) => ({
          ...prev,
          [deviceId]: {
            ...prev[deviceId],
            deviceId,
            state: 'error',
            isOnline: false,
            errorMessage: err instanceof Error ? err.message : 'Connection failed',
          },
        }))
      }
    },
    [t]
  )

  const handleDisconnect = useCallback(
    async (deviceId: string) => {
      try {
        await ecrAPI.disconnectDevice(deviceId)
        toast.success(t('ecr.disconnectSuccess', 'Terminal disconnected'))
      } catch (err) {
        toast.error(
          err instanceof Error
            ? err.message
            : t('ecr.errors.disconnectFailed', 'Disconnect failed')
        )
      }
    },
    [t]
  )

  const handleEdit = useCallback((device: ECRDevice) => {
    setEditingDevice(device)
    setSelectedDiscoveredDevice(undefined)
    setShowConfigModal(true)
  }, [])

  const handleDelete = useCallback(
    async (deviceId: string) => {
      if (!confirm(t('ecr.confirmDelete', 'Are you sure you want to delete this terminal?'))) {
        return
      }

      try {
        await ecrAPI.removeDevice(deviceId)
        setDevices((prev) => prev.filter((d) => d.id !== deviceId))
        toast.success(t('ecr.deleteSuccess', 'Terminal deleted'))
      } catch (err) {
        toast.error(
          err instanceof Error ? err.message : t('ecr.errors.deleteFailed', 'Delete failed')
        )
      }
    },
    [t]
  )

  const handleSetDefault = useCallback(
    async (deviceId: string) => {
      try {
        // First, unset any existing default
        const currentDefault = devices.find((d) => d.isDefault)
        if (currentDefault && currentDefault.id !== deviceId) {
          await ecrAPI.updateDevice(currentDefault.id, { isDefault: false })
        }

        // Set the new default
        await ecrAPI.updateDevice(deviceId, { isDefault: true })

        // Update local state
        setDevices((prev) =>
          prev.map((d) => ({
            ...d,
            isDefault: d.id === deviceId,
          }))
        )

        toast.success(t('ecr.setDefaultSuccess', 'Default terminal updated'))
      } catch (err) {
        toast.error(
          err instanceof Error
            ? err.message
            : t('ecr.errors.setDefaultFailed', 'Failed to set default')
        )
      }
    },
    [devices, t]
  )

  const handleDiscoveredDeviceSelect = useCallback((device: DiscoveredDevice) => {
    setShowDiscoveryModal(false)
    setEditingDevice(undefined)
    setSelectedDiscoveredDevice(device)
    setShowConfigModal(true)
  }, [])

  const handleSaveDevice = useCallback(
    async (config: Omit<ECRDevice, 'id' | 'createdAt' | 'updatedAt'>) => {
      try {
        if (editingDevice) {
          // Update existing device
          const updated = await ecrAPI.updateDevice(editingDevice.id, config)
          if (updated) {
            setDevices((prev) => prev.map((d) => (d.id === editingDevice.id ? updated : d)))
            toast.success(t('ecr.updateSuccess', 'Terminal updated'))
          }
        } else {
          // Add new device
          const newDevice = await ecrAPI.addDevice(config)
          setDevices((prev) => [...prev, newDevice])
          toast.success(t('ecr.addSuccess', 'Terminal added'))
        }
        setShowConfigModal(false)
        setEditingDevice(undefined)
        setSelectedDiscoveredDevice(undefined)
      } catch (err) {
        throw err // Let the modal handle the error
      }
    },
    [editingDevice, t]
  )

  // Calculate stats
  const stats = useMemo<TerminalStats>(() => {
    const statusList = Object.values(statuses)
    return {
      total: devices.length,
      connected: statusList.filter((s) => s.state === 'connected').length,
      disconnected: statusList.filter((s) => s.state === 'disconnected').length,
      error: statusList.filter((s) => s.state === 'error').length,
    }
  }, [devices, statuses])

  // Loading state
  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="text-center">
          <Loader2 className="w-8 h-8 animate-spin mx-auto mb-3 text-emerald-400" />
          <p className="text-sm liquid-glass-modal-text-muted">
            {t('ecr.loading', 'Loading payment terminals...')}
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      {/* Header with Back Button */}
      <div className="flex items-center justify-between pb-3 border-b liquid-glass-modal-border">
        <button
          onClick={onBack}
          className="flex items-center gap-2 liquid-glass-modal-text hover:opacity-80 transition-opacity"
        >
          <ArrowLeft size={20} />
          <span className="font-medium">{t('common.back', 'Back')}</span>
        </button>
        <div className="flex items-center gap-3">
          {/* Online Status */}
          <span
            className={`flex items-center gap-1.5 text-xs px-2 py-1 rounded-md ${
              isOnline
                ? 'bg-green-500/20 text-green-400'
                : 'bg-red-500/20 text-red-400'
            }`}
          >
            {isOnline ? <Wifi size={12} /> : <WifiOff size={12} />}
            {isOnline ? t('common.online', 'Online') : t('common.offline', 'Offline')}
          </span>

          {/* Refresh Button */}
          <button
            onClick={handleRefresh}
            disabled={isRefreshing}
            className="p-1.5 rounded-md hover:bg-white/10 transition-colors disabled:opacity-50"
          >
            <RefreshCw
              size={16}
              className={`liquid-glass-modal-text ${isRefreshing ? 'animate-spin' : ''}`}
            />
          </button>
        </div>
      </div>

      {/* Title */}
      <div className="flex items-center gap-3 px-1">
        <div className="w-10 h-10 rounded-xl flex items-center justify-center bg-emerald-500/20">
          <CreditCard
            size={22}
            className="text-emerald-400 drop-shadow-[0_0_8px_rgba(52,211,153,0.6)]"
          />
        </div>
        <div>
          <h2 className="text-lg font-bold liquid-glass-modal-text">
            {t('settings.paymentTerminals.title', 'Payment Terminals')}
          </h2>
          <p className="text-xs liquid-glass-modal-text-muted">
            {t('settings.paymentTerminals.helpText', 'Configure ECR payment devices')}
          </p>
        </div>
      </div>

      {/* Stats Mini Cards */}
      <div className="grid grid-cols-4 gap-2">
        <MiniStatCard
          icon={CreditCard}
          value={stats.total}
          label={t('ecr.stats.total', 'Total')}
          color="indigo"
        />
        <MiniStatCard
          icon={CheckCircle}
          value={stats.connected}
          label={t('ecr.stats.connected', 'Connected')}
          color="green"
        />
        <MiniStatCard
          icon={XCircle}
          value={stats.disconnected}
          label={t('ecr.stats.disconnected', 'Disconnected')}
          color="gray"
        />
        <MiniStatCard
          icon={AlertCircle}
          value={stats.error}
          label={t('ecr.stats.error', 'Error')}
          color="red"
        />
      </div>

      {/* Configured Terminals Section */}
      <div
        className={`rounded-xl backdrop-blur-sm border liquid-glass-modal-border bg-white/5 dark:bg-gray-800/10 transition-all ${
          showTerminalsList ? 'bg-white/10 dark:bg-gray-800/20' : ''
        }`}
      >
        <button
          onClick={() => setShowTerminalsList(!showTerminalsList)}
          className="w-full px-4 py-3 flex items-center justify-between transition-colors liquid-glass-modal-text"
        >
          <div className="flex items-center gap-3">
            <CreditCard className="w-5 h-5 text-emerald-400 drop-shadow-[0_0_8px_rgba(52,211,153,0.6)]" />
            <span className="font-medium">
              {t('ecr.configuredTerminals', 'Configured Terminals')}
            </span>
            {devices.length > 0 && (
              <span className="px-2 py-0.5 text-xs rounded-full bg-emerald-500/20 text-emerald-400">
                {devices.length}
              </span>
            )}
          </div>
          <ChevronDown
            className={`w-5 h-5 transition-transform ${showTerminalsList ? 'rotate-180' : ''}`}
          />
        </button>

        {showTerminalsList && (
          <div className="px-4 pb-4 space-y-3 border-t liquid-glass-modal-border">
            {devices.length === 0 ? (
              <div className="text-center py-6">
                <CreditCard size={36} className="mx-auto mb-3 opacity-30" />
                <p className="font-medium liquid-glass-modal-text mb-1">
                  {t('ecr.empty.title', 'No payment terminals')}
                </p>
                <p className="text-xs liquid-glass-modal-text-muted">
                  {t('ecr.empty.description', 'Add a payment terminal to accept card payments')}
                </p>
              </div>
            ) : (
              <div className="space-y-2 pt-3">
                {devices.map((device) => (
                  <TerminalCardCompact
                    key={device.id}
                    device={device}
                    status={statuses[device.id]}
                    onConnect={() => handleConnect(device.id)}
                    onDisconnect={() => handleDisconnect(device.id)}
                    onEdit={() => handleEdit(device)}
                    onDelete={() => handleDelete(device.id)}
                    onSetDefault={() => handleSetDefault(device.id)}
                  />
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Action Buttons */}
      <div className="flex gap-2">
        <button
          onClick={() => setShowDiscoveryModal(true)}
          className={`flex-1 flex items-center justify-center gap-2 ${liquidGlassModalButton('secondary', 'md')}`}
        >
          <Search size={16} />
          {t('ecr.discover', 'Discover')}
        </button>
        <button
          onClick={() => {
            setEditingDevice(undefined)
            setSelectedDiscoveredDevice(undefined)
            setShowConfigModal(true)
          }}
          className={`flex-1 flex items-center justify-center gap-2 ${liquidGlassModalButton('primary', 'md')}`}
        >
          <Plus size={16} />
          {t('ecr.addManual', 'Add Terminal')}
        </button>
      </div>

      {/* Discovery Modal */}
      <TerminalDiscoveryModal
        isOpen={showDiscoveryModal}
        onClose={() => setShowDiscoveryModal(false)}
        onSelect={handleDiscoveredDeviceSelect}
        discoverDevices={ecrAPI.discoverDevices}
      />

      {/* Config Modal */}
      <TerminalConfigModal
        isOpen={showConfigModal}
        onClose={() => {
          setShowConfigModal(false)
          setEditingDevice(undefined)
          setSelectedDiscoveredDevice(undefined)
        }}
        onSave={handleSaveDevice}
        device={editingDevice}
        discoveredDevice={selectedDiscoveredDevice}
      />
    </div>
  )
}

export default PaymentTerminalsSection
