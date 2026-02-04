/**
 * PaymentTerminalsPage - ECR Device Management for Desktop POS
 *
 * Features:
 * - List configured payment terminals
 * - Discover new terminals via USB/Serial, Bluetooth, Network
 * - Connect/disconnect terminals
 * - Configure terminal settings
 * - View connection status
 * - Process test payments
 *
 * @since 2.5.0
 */

import React, { useState, useEffect, useCallback, useMemo, memo } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'react-hot-toast'
import { useTheme } from '../contexts/theme-context'
import {
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
  Settings,
  Trash2,
} from 'lucide-react'

import { TerminalCard } from '../components/ecr/TerminalCard'
import { TerminalDiscoveryModal } from '../components/ecr/TerminalDiscoveryModal'
import { TerminalConfigModal } from '../components/ecr/TerminalConfigModal'
import { PaymentDialog } from '../components/ecr/PaymentDialog'

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

interface TransactionResponse {
  transactionId: string
  status: 'pending' | 'processing' | 'approved' | 'declined' | 'error' | 'timeout' | 'cancelled'
  authorizationCode?: string
  cardType?: string
  cardLastFour?: string
  errorMessage?: string
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
  processPayment: async (
    amount: number,
    options?: { deviceId?: string; orderId?: string }
  ): Promise<TransactionResponse> => {
    return (window as any).electronAPI?.invoke('ecr:process-payment', amount, options)
  },
}

// ============================================================
// STATS CARD COMPONENT
// ============================================================

interface StatsCardProps {
  label: string
  value: number
  icon: typeof CreditCard
  color: string
  isDark: boolean
}

const StatsCard = memo<StatsCardProps>(({ label, value, icon: Icon, color, isDark }) => (
  <div className={`p-4 rounded-xl ${isDark ? 'bg-gray-800/50' : 'bg-white'}`}>
    <div className="flex items-center gap-3">
      <div
        className="w-10 h-10 rounded-lg flex items-center justify-center"
        style={{ backgroundColor: `${color}20` }}
      >
        <Icon size={20} style={{ color }} />
      </div>
      <div>
        <p className={`text-2xl font-bold ${isDark ? 'text-white' : 'text-gray-900'}`}>
          {value}
        </p>
        <p className={`text-xs ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>{label}</p>
      </div>
    </div>
  </div>
))

StatsCard.displayName = 'StatsCard'

// ============================================================
// MAIN PAGE COMPONENT
// ============================================================

interface PageProps {
  embedded?: boolean // When true, renders with transparent background for modal embedding
}

export const PaymentTerminalsPage: React.FC<PageProps> = ({ embedded = false }) => {
  const { t } = useTranslation()
  const { resolvedTheme } = useTheme()
  const isDark = resolvedTheme === 'dark'

  // State
  const [devices, setDevices] = useState<ECRDevice[]>([])
  const [statuses, setStatuses] = useState<Record<string, ECRDeviceStatus>>({})
  const [loading, setLoading] = useState(true)
  const [isRefreshing, setIsRefreshing] = useState(false)
  const [isOnline, setIsOnline] = useState(navigator.onLine)

  // Modals
  const [showDiscoveryModal, setShowDiscoveryModal] = useState(false)
  const [showConfigModal, setShowConfigModal] = useState(false)
  const [editingDevice, setEditingDevice] = useState<ECRDevice | undefined>()
  const [selectedDiscoveredDevice, setSelectedDiscoveredDevice] = useState<
    DiscoveredDevice | undefined
  >()
  const [showPaymentDialog, setShowPaymentDialog] = useState(false)
  const [paymentDeviceId, setPaymentDeviceId] = useState<string | undefined>()

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

  const handleTestPayment = useCallback((deviceId: string) => {
    setPaymentDeviceId(deviceId)
    setShowPaymentDialog(true)
  }, [])

  const handlePaymentComplete = useCallback(
    (response: TransactionResponse) => {
      setShowPaymentDialog(false)
      setPaymentDeviceId(undefined)

      if (response.status === 'approved') {
        toast.success(
          t('ecr.payment.testApproved', 'Test payment approved ({{code}})', {
            code: response.authorizationCode,
          })
        )
      } else {
        toast.error(
          response.errorMessage || t('ecr.payment.testFailed', 'Test payment failed')
        )
      }
    },
    [t]
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
      <div
        className={`min-h-screen flex items-center justify-center ${embedded ? 'bg-transparent' : isDark ? 'bg-gray-900' : 'bg-gray-50'}`}
      >
        <div className="text-center">
          <Loader2
            className={`w-8 h-8 animate-spin mx-auto mb-3 ${isDark ? 'text-blue-400' : 'text-blue-500'}`}
          />
          <p className={`text-sm ${isDark ? 'text-gray-400' : 'text-gray-600'}`}>
            {t('ecr.loading', 'Loading payment terminals...')}
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className={`min-h-screen ${embedded ? 'bg-transparent' : isDark ? 'bg-gray-900' : 'bg-gray-50'}`}>
      {/* Header */}
      <div
        className={`sticky top-0 z-10 px-4 py-4 border-b ${embedded ? 'bg-transparent border-white/10 dark:border-white/10' : isDark ? 'bg-gray-900/95 border-white/10' : 'bg-white/95 border-gray-200'} backdrop-blur-sm`}
      >
        <div className="max-w-6xl mx-auto">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-4">
              <div
                className={`w-12 h-12 rounded-xl flex items-center justify-center ${isDark ? 'bg-blue-500/20' : 'bg-blue-100'}`}
              >
                <CreditCard size={24} className="text-blue-500" />
              </div>
              <div>
                <h1 className={`text-xl font-bold ${isDark ? 'text-white' : 'text-gray-900'}`}>
                  {t('ecr.title', 'Payment Terminals')}
                </h1>
                <p className={`text-sm ${isDark ? 'text-gray-400' : 'text-gray-600'}`}>
                  {t('ecr.subtitle', 'Manage card payment terminals')}
                </p>
              </div>
            </div>

            <div className="flex items-center gap-3">
              {/* Online Status */}
              <div
                className={`flex items-center gap-2 px-3 py-1.5 rounded-lg ${
                  isOnline
                    ? isDark
                      ? 'bg-green-500/20 text-green-400'
                      : 'bg-green-100 text-green-600'
                    : isDark
                      ? 'bg-red-500/20 text-red-400'
                      : 'bg-red-100 text-red-600'
                }`}
              >
                {isOnline ? <Wifi size={16} /> : <WifiOff size={16} />}
                <span className="text-xs font-medium">
                  {isOnline ? t('common.online', 'Online') : t('common.offline', 'Offline')}
                </span>
              </div>

              {/* Refresh Button */}
              <button
                onClick={handleRefresh}
                disabled={isRefreshing}
                className={`p-2 rounded-lg transition-colors disabled:opacity-50 ${isDark ? 'hover:bg-white/10 text-gray-300' : 'hover:bg-gray-100 text-gray-600'}`}
              >
                <RefreshCw size={20} className={isRefreshing ? 'animate-spin' : ''} />
              </button>

              {/* Discover Button */}
              <button
                onClick={() => setShowDiscoveryModal(true)}
                className={`flex items-center gap-2 px-4 py-2 rounded-lg transition-colors ${isDark ? 'bg-blue-500/20 text-blue-400 hover:bg-blue-500/30' : 'bg-blue-100 text-blue-600 hover:bg-blue-200'}`}
              >
                <Search size={18} />
                {t('ecr.discover', 'Discover')}
              </button>

              {/* Add Manual Button */}
              <button
                onClick={() => {
                  setEditingDevice(undefined)
                  setSelectedDiscoveredDevice(undefined)
                  setShowConfigModal(true)
                }}
                className={`flex items-center gap-2 px-4 py-2 rounded-lg transition-colors ${isDark ? 'bg-green-500/20 text-green-400 hover:bg-green-500/30' : 'bg-green-100 text-green-600 hover:bg-green-200'}`}
              >
                <Plus size={18} />
                {t('ecr.addManual', 'Add Terminal')}
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Content */}
      <div className="max-w-6xl mx-auto p-4">
        {/* Stats Row */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
          <StatsCard
            label={t('ecr.stats.total', 'Total')}
            value={stats.total}
            icon={CreditCard}
            color="#6366f1"
            isDark={isDark}
          />
          <StatsCard
            label={t('ecr.stats.connected', 'Connected')}
            value={stats.connected}
            icon={CheckCircle}
            color="#22c55e"
            isDark={isDark}
          />
          <StatsCard
            label={t('ecr.stats.disconnected', 'Disconnected')}
            value={stats.disconnected}
            icon={XCircle}
            color="#6b7280"
            isDark={isDark}
          />
          <StatsCard
            label={t('ecr.stats.error', 'Error')}
            value={stats.error}
            icon={AlertCircle}
            color="#ef4444"
            isDark={isDark}
          />
        </div>

        {/* Empty State */}
        {devices.length === 0 && (
          <div
            className={`text-center py-12 rounded-xl ${isDark ? 'bg-gray-800/50' : 'bg-white'}`}
          >
            <CreditCard
              size={48}
              className={`mx-auto mb-4 ${isDark ? 'text-gray-600' : 'text-gray-400'}`}
            />
            <h3
              className={`text-lg font-semibold mb-2 ${isDark ? 'text-white' : 'text-gray-900'}`}
            >
              {t('ecr.empty.title', 'No payment terminals')}
            </h3>
            <p className={`text-sm mb-4 ${isDark ? 'text-gray-400' : 'text-gray-600'}`}>
              {t('ecr.empty.description', 'Add a payment terminal to accept card payments')}
            </p>
            <button
              onClick={() => setShowDiscoveryModal(true)}
              className={`inline-flex items-center gap-2 px-4 py-2 rounded-lg transition-colors ${isDark ? 'bg-blue-500/20 text-blue-400 hover:bg-blue-500/30' : 'bg-blue-100 text-blue-600 hover:bg-blue-200'}`}
            >
              <Search size={18} />
              {t('ecr.discoverTerminals', 'Discover Terminals')}
            </button>
          </div>
        )}

        {/* Device List */}
        {devices.length > 0 && (
          <div className="grid gap-4 sm:grid-cols-1 lg:grid-cols-2">
            {devices.map((device) => (
              <TerminalCard
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

        {/* Test Payment Section */}
        {devices.length > 0 && (
          <div
            className={`mt-6 p-6 rounded-xl ${isDark ? 'bg-gray-800/50' : 'bg-white'}`}
          >
            <h3
              className={`font-semibold mb-4 ${isDark ? 'text-white' : 'text-gray-900'}`}
            >
              {t('ecr.testPayment.title', 'Test Payment')}
            </h3>
            <p className={`text-sm mb-4 ${isDark ? 'text-gray-400' : 'text-gray-600'}`}>
              {t(
                'ecr.testPayment.description',
                'Send a test payment to verify terminal connectivity'
              )}
            </p>
            <div className="flex flex-wrap gap-3">
              {devices
                .filter((d) => d.enabled)
                .map((device) => (
                  <button
                    key={device.id}
                    onClick={() => handleTestPayment(device.id)}
                    disabled={statuses[device.id]?.state !== 'connected'}
                    className={`px-4 py-2 rounded-lg text-sm transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${isDark ? 'bg-blue-500/20 text-blue-400 hover:bg-blue-500/30' : 'bg-blue-100 text-blue-600 hover:bg-blue-200'}`}
                  >
                    {t('ecr.testPayment.button', 'Test {{name}}', { name: device.name })}
                  </button>
                ))}
            </div>
          </div>
        )}
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

      {/* Payment Dialog */}
      <PaymentDialog
        isOpen={showPaymentDialog}
        amount={100} // Test amount: 1.00 EUR
        currency="EUR"
        onClose={() => {
          setShowPaymentDialog(false)
          setPaymentDeviceId(undefined)
        }}
        onComplete={handlePaymentComplete}
        onCancel={() => {
          // Cancel transaction if in progress
          if (paymentDeviceId) {
            (window as any).electronAPI?.invoke('ecr:cancel-transaction', paymentDeviceId)
          }
        }}
        processPayment={(amount: number) =>
          ecrAPI.processPayment(amount, { deviceId: paymentDeviceId })
        }
      />
    </div>
  )
}

export default PaymentTerminalsPage
