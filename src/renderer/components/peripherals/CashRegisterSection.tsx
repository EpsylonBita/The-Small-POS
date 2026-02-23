import React, { useState, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'react-hot-toast'
import { getBridge } from '../../../lib'
import {
  CreditCard,
  Printer,
  Plug,
  Plus,
  Trash2,
  RefreshCw,
  Settings,
  ChevronDown,
  Pencil,
  AlertCircle,
  CheckCircle,
  XCircle,
  Loader2,
} from 'lucide-react'

// ============================================================
// TYPES
// ============================================================

type DeviceType = 'cash_register' | 'payment_terminal'
type ConnectionType = 'serial_usb' | 'network' | 'bluetooth'
type Protocol = 'generic' | 'zvt' | 'pax'
type PrintMode = 'register_prints' | 'pos_sends_receipt'
type DeviceStatus = 'connected' | 'disconnected' | 'error'

interface TaxRate {
  code: string
  rate: string
  label: string
}

interface ECRCashDevice {
  id: string
  name: string
  device_type: DeviceType
  brand: string
  protocol: Protocol
  connection_type: ConnectionType
  com_port?: string
  baud_rate?: number
  ip_address?: string
  tcp_port?: number
  mac_address?: string
  print_mode: PrintMode
  tax_rates: TaxRate[]
  operator_id?: string
  is_default: boolean
  enabled: boolean
  status?: DeviceStatus
  error_message?: string
}

type FormData = Omit<ECRCashDevice, 'id' | 'status' | 'error_message'>

const BRANDS = [
  'Generic',
  'Datecs',
  'Elcom',
  'Casio',
  'RBS',
  'Bixolon',
  'Star',
  'Epson Fiscal',
  'Sam4s',
  'Custom',
  'Ingenico',
  'Verifone',
  'PAX',
] as const

const BRAND_PROTOCOL_MAP: Record<string, Protocol> = {
  Generic: 'generic',
  Datecs: 'generic',
  Elcom: 'generic',
  Casio: 'generic',
  RBS: 'generic',
  Bixolon: 'generic',
  Star: 'generic',
  'Epson Fiscal': 'generic',
  Sam4s: 'generic',
  Custom: 'generic',
  Ingenico: 'zvt',
  Verifone: 'zvt',
  PAX: 'pax',
}

const BAUD_RATES = [9600, 19200, 38400, 57600, 115200] as const

const DEFAULT_TAX_RATES: TaxRate[] = [
  { code: 'A', rate: '24', label: 'Standard' },
  { code: 'B', rate: '13', label: 'Reduced' },
  { code: 'C', rate: '6', label: 'Super Reduced' },
  { code: 'D', rate: '0', label: 'Zero' },
]

const EMPTY_FORM: FormData = {
  name: '',
  device_type: 'cash_register',
  brand: 'Generic',
  protocol: 'generic',
  connection_type: 'serial_usb',
  com_port: '',
  baud_rate: 9600,
  ip_address: '',
  tcp_port: 9100,
  mac_address: '',
  print_mode: 'register_prints',
  tax_rates: DEFAULT_TAX_RATES,
  operator_id: '',
  is_default: false,
  enabled: true,
}

// ============================================================
// IPC HELPERS
// ============================================================

const bridge = getBridge()

const invokeIPC = async (command: string, args?: unknown): Promise<any> => {
  switch (command) {
    case 'ecr_get_devices':
      return bridge.ecr.getDevices()
    case 'ecr_update_device': {
      const payload = (args as Record<string, any>) || {}
      const { device_id, ...updates } = payload
      return bridge.ecr.updateDevice(device_id, updates)
    }
    case 'ecr_add_device':
      return bridge.ecr.addDevice(args)
    case 'ecr_remove_device': {
      const payload = (args as Record<string, any>) || {}
      return bridge.ecr.removeDevice(payload.device_id)
    }
    case 'ecr_test_connection': {
      const payload = (args as Record<string, any>) || {}
      return bridge.invoke('ecr:test-connection', payload.device_id)
    }
    case 'ecr_test_print': {
      const payload = (args as Record<string, any>) || {}
      return bridge.invoke('ecr:test-print', payload.device_id)
    }
    default:
      return bridge.invoke(command, args)
  }
}

// ============================================================
// STATUS INDICATOR
// ============================================================

const StatusIndicator: React.FC<{ status?: DeviceStatus; error?: string }> = ({ status, error }) => {
  if (!status || status === 'disconnected') {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-gray-500/20 text-gray-400">
        <XCircle className="w-3 h-3" />
        Disconnected
      </span>
    )
  }
  if (status === 'error') {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-red-500/20 text-red-400" title={error}>
        <AlertCircle className="w-3 h-3" />
        Error
      </span>
    )
  }
  return (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-green-500/20 text-green-400">
      <CheckCircle className="w-3 h-3" />
      Connected
    </span>
  )
}

// ============================================================
// MAIN COMPONENT
// ============================================================

interface CashRegisterSectionProps {
  // optional: refresh trigger, etc.
}

type ViewMode = 'list' | 'add' | 'edit'

export const CashRegisterSection: React.FC<CashRegisterSectionProps> = () => {
  const { t } = useTranslation()

  const [devices, setDevices] = useState<ECRCashDevice[]>([])
  const [loading, setLoading] = useState(true)
  const [viewMode, setViewMode] = useState<ViewMode>('list')
  const [editingDeviceId, setEditingDeviceId] = useState<string | null>(null)
  const [form, setForm] = useState<FormData>({ ...EMPTY_FORM })
  const [isSaving, setIsSaving] = useState(false)
  const [isTesting, setIsTesting] = useState<string | null>(null)
  const [showDevices, setShowDevices] = useState(true)
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null)

  // Load devices
  const loadDevices = useCallback(async () => {
    try {
      setLoading(true)
      const result = await invokeIPC('ecr_get_devices')
      const list = result?.devices || result?.data || []
      setDevices(Array.isArray(list) ? list : [])
    } catch (e) {
      console.error('Failed to load ECR cash register devices:', e)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    loadDevices()
  }, [loadDevices])

  // Form helpers
  const updateForm = (patch: Partial<FormData>) => {
    setForm((prev) => ({ ...prev, ...patch }))
  }

  const handleBrandChange = (brand: string) => {
    const protocol = BRAND_PROTOCOL_MAP[brand] || 'generic'
    updateForm({ brand, protocol })
  }

  const handleConnectionTypeChange = (connectionType: ConnectionType) => {
    const patch: Partial<FormData> = { connection_type: connectionType }
    if (connectionType === 'network') {
      patch.tcp_port = form.device_type === 'payment_terminal' ? 20007 : 9100
    }
    updateForm(patch)
  }

  const updateTaxRate = (index: number, field: keyof TaxRate, value: string) => {
    const updated = [...form.tax_rates]
    updated[index] = { ...updated[index], [field]: value }
    updateForm({ tax_rates: updated })
  }

  const resetForm = () => {
    setForm({ ...EMPTY_FORM })
    setEditingDeviceId(null)
  }

  // Open add form
  const handleAdd = () => {
    resetForm()
    setViewMode('add')
  }

  // Open edit form
  const handleEdit = (device: ECRCashDevice) => {
    setEditingDeviceId(device.id)
    setForm({
      name: device.name,
      device_type: device.device_type,
      brand: device.brand,
      protocol: device.protocol,
      connection_type: device.connection_type,
      com_port: device.com_port || '',
      baud_rate: device.baud_rate || 9600,
      ip_address: device.ip_address || '',
      tcp_port: device.tcp_port || 9100,
      mac_address: device.mac_address || '',
      print_mode: device.print_mode,
      tax_rates: device.tax_rates?.length ? device.tax_rates : DEFAULT_TAX_RATES,
      operator_id: device.operator_id || '',
      is_default: device.is_default,
      enabled: device.enabled,
    })
    setViewMode('edit')
  }

  // Save (add or update)
  const handleSave = async () => {
    if (!form.name.trim()) {
      toast.error(t('settings.peripherals.cashRegister.nameRequired', 'Device name is required'))
      return
    }

    if (form.connection_type === 'serial_usb' && !form.com_port?.trim()) {
      toast.error(t('settings.peripherals.cashRegister.comPortRequired', 'COM port is required'))
      return
    }
    if (form.connection_type === 'network' && !form.ip_address?.trim()) {
      toast.error(t('settings.peripherals.cashRegister.ipRequired', 'IP address is required'))
      return
    }
    if (form.connection_type === 'bluetooth' && !form.mac_address?.trim()) {
      toast.error(t('settings.peripherals.cashRegister.macRequired', 'MAC address is required'))
      return
    }

    setIsSaving(true)
    try {
      if (viewMode === 'edit' && editingDeviceId) {
        await invokeIPC('ecr_update_device', { device_id: editingDeviceId, ...form })
        toast.success(t('settings.peripherals.cashRegister.updated', 'Device updated'))
      } else {
        await invokeIPC('ecr_add_device', form)
        toast.success(t('settings.peripherals.cashRegister.added', 'Device added'))
      }
      await loadDevices()
      setViewMode('list')
      resetForm()
    } catch (e: any) {
      console.error('Failed to save ECR device:', e)
      toast.error(e?.message || t('settings.peripherals.cashRegister.saveFailed', 'Failed to save device'))
    } finally {
      setIsSaving(false)
    }
  }

  // Delete
  const handleDeleteConfirm = async () => {
    if (!deleteConfirmId) return
    try {
      await invokeIPC('ecr_remove_device', { device_id: deleteConfirmId })
      setDevices((prev) => prev.filter((d) => d.id !== deleteConfirmId))
      toast.success(t('settings.peripherals.cashRegister.deleted', 'Device deleted'))
    } catch (e: any) {
      console.error('Failed to delete ECR device:', e)
      toast.error(e?.message || t('settings.peripherals.cashRegister.deleteFailed', 'Failed to delete device'))
    } finally {
      setDeleteConfirmId(null)
    }
  }

  // Test connection
  const handleTestConnection = async (deviceId: string) => {
    setIsTesting(deviceId)
    try {
      const result = await invokeIPC('ecr_test_connection', { device_id: deviceId })
      if (result?.success) {
        toast.success(t('settings.peripherals.cashRegister.testSuccess', 'Connection successful'))
        setDevices((prev) =>
          prev.map((d) => (d.id === deviceId ? { ...d, status: 'connected' as DeviceStatus } : d))
        )
      } else {
        toast.error(result?.error || t('settings.peripherals.cashRegister.testFailed', 'Connection failed'))
        setDevices((prev) =>
          prev.map((d) =>
            d.id === deviceId
              ? { ...d, status: 'error' as DeviceStatus, error_message: result?.error }
              : d
          )
        )
      }
    } catch (e: any) {
      console.error('ECR test connection failed:', e)
      toast.error(e?.message || t('settings.peripherals.cashRegister.testFailed', 'Connection failed'))
    } finally {
      setIsTesting(null)
    }
  }

  // Test print
  const handleTestPrint = async (deviceId: string) => {
    try {
      const result = await invokeIPC('ecr_test_print', { device_id: deviceId })
      if (result?.success) {
        toast.success(t('settings.peripherals.cashRegister.testPrintSuccess', 'Test print sent'))
      } else {
        toast.error(result?.error || t('settings.peripherals.cashRegister.testPrintFailed', 'Test print failed'))
      }
    } catch (e: any) {
      console.error('ECR test print failed:', e)
      toast.error(e?.message || t('settings.peripherals.cashRegister.testPrintFailed', 'Test print failed'))
    }
  }

  // ============================================================
  // RENDER: DEVICE LIST VIEW
  // ============================================================

  const renderListView = () => (
    <div className="space-y-3">
      {/* Section Header (collapsible) */}
      <div
        className={`rounded-xl backdrop-blur-sm border liquid-glass-modal-border bg-white/5 dark:bg-gray-800/10 hover:bg-white/10 dark:hover:bg-gray-800/20 transition-all ${
          showDevices ? 'bg-white/10 dark:bg-gray-800/20' : ''
        }`}
      >
        <button
          onClick={() => setShowDevices(!showDevices)}
          className="w-full px-4 py-3 flex items-center justify-between transition-colors liquid-glass-modal-text"
        >
          <div className="flex items-center gap-3">
            <CreditCard className="w-5 h-5 text-amber-400 drop-shadow-[0_0_8px_rgba(251,191,36,0.6)]" />
            <div className="text-left">
              <span className="font-medium block">
                {t('settings.peripherals.cashRegister.title', 'Cash Register / Fiscal Printer')}
              </span>
              <span className="text-xs liquid-glass-modal-text-muted">
                {t('settings.peripherals.cashRegister.helpText', 'Configure fiscal devices and tax settings')}
              </span>
            </div>
            {devices.length > 0 && (
              <span className="px-2 py-0.5 text-xs rounded-full bg-amber-500/20 text-amber-400">
                {devices.length}
              </span>
            )}
          </div>
          <ChevronDown className={`w-5 h-5 transition-transform ${showDevices ? 'rotate-180' : ''}`} />
        </button>

        {showDevices && (
          <div className="px-4 pb-4 space-y-3 border-t liquid-glass-modal-border">
            {/* Add Button */}
            <div className="pt-3 flex gap-2">
              <button
                onClick={handleAdd}
                className="flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-medium transition-all bg-cyan-500/20 border border-cyan-500/50 text-cyan-300 hover:bg-cyan-500/30"
              >
                <Plus className="w-4 h-4" />
                {t('settings.peripherals.cashRegister.addDevice', 'Add Device')}
              </button>
              <button
                onClick={loadDevices}
                disabled={loading}
                className="flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-medium transition-all bg-white/10 border border-white/20 text-gray-300 hover:bg-white/20"
              >
                <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
              </button>
            </div>

            {/* Device List */}
            {loading ? (
              <div className="flex items-center justify-center py-8">
                <Loader2 className="w-6 h-6 animate-spin text-amber-400" />
              </div>
            ) : devices.length === 0 ? (
              <div className="text-center py-6">
                <CreditCard className="w-8 h-8 mx-auto mb-2 opacity-30" />
                <p className="text-sm liquid-glass-modal-text-muted">
                  {t('settings.peripherals.cashRegister.noDevices', 'No cash register devices configured')}
                </p>
              </div>
            ) : (
              <div className="space-y-2">
                {devices.map((device) => (
                  <div
                    key={device.id}
                    className="p-3 rounded-lg bg-white/5 border border-white/10 space-y-2"
                  >
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-3 min-w-0">
                        <div className="flex-shrink-0">
                          {device.device_type === 'cash_register' ? (
                            <CreditCard className="w-4 h-4 text-amber-400" />
                          ) : (
                            <CreditCard className="w-4 h-4 text-emerald-400" />
                          )}
                        </div>
                        <div className="min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="font-medium liquid-glass-modal-text truncate">
                              {device.name}
                            </span>
                            {device.is_default && (
                              <span className="text-xs bg-blue-500/20 text-blue-300 px-2 py-0.5 rounded flex-shrink-0">
                                {t('settings.peripherals.cashRegister.default', 'Default')}
                              </span>
                            )}
                            {!device.enabled && (
                              <span className="text-xs bg-gray-500/20 text-gray-400 px-2 py-0.5 rounded flex-shrink-0">
                                {t('settings.peripherals.cashRegister.disabled', 'Disabled')}
                              </span>
                            )}
                          </div>
                          <div className="text-xs liquid-glass-modal-text-muted">
                            {device.brand} &middot; {device.protocol.toUpperCase()} &middot; {device.connection_type.replace('_', '/')}
                          </div>
                        </div>
                      </div>
                      <StatusIndicator status={device.status} error={device.error_message} />
                    </div>

                    {/* Action buttons */}
                    <div className="flex gap-1.5 pt-1">
                      <button
                        onClick={() => handleTestConnection(device.id)}
                        disabled={isTesting === device.id}
                        className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium transition-all bg-cyan-500/20 border border-cyan-500/50 text-cyan-300 hover:bg-cyan-500/30 disabled:opacity-50"
                      >
                        {isTesting === device.id ? (
                          <Loader2 className="w-3 h-3 animate-spin" />
                        ) : (
                          <Plug className="w-3 h-3" />
                        )}
                        {t('settings.peripherals.cashRegister.testConnection', 'Test Connection')}
                      </button>
                      <button
                        onClick={() => handleTestPrint(device.id)}
                        className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium transition-all bg-cyan-500/20 border border-cyan-500/50 text-cyan-300 hover:bg-cyan-500/30"
                      >
                        <Printer className="w-3 h-3" />
                        {t('settings.peripherals.cashRegister.testPrint', 'Test Print')}
                      </button>
                      <div className="flex-1" />
                      <button
                        onClick={() => handleEdit(device)}
                        className="p-1.5 rounded-lg text-xs transition-all bg-white/10 border border-white/20 text-gray-300 hover:bg-white/20"
                        title={t('common.actions.edit', 'Edit')}
                      >
                        <Pencil className="w-3.5 h-3.5" />
                      </button>
                      <button
                        onClick={() => setDeleteConfirmId(device.id)}
                        className="p-1.5 rounded-lg text-xs transition-all bg-red-500/10 border border-red-500/30 text-red-400 hover:bg-red-500/20"
                        title={t('common.actions.delete', 'Delete')}
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Delete confirmation overlay */}
      {deleteConfirmId && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 backdrop-blur-sm">
          <div className="bg-gray-900/95 border border-white/15 rounded-xl p-6 mx-6 max-w-sm w-full shadow-2xl">
            <div className="flex items-center gap-3 mb-4">
              <Trash2 className="w-5 h-5 text-red-400 flex-shrink-0" />
              <div>
                <h3 className="text-sm font-semibold text-white">
                  {t('settings.peripherals.cashRegister.confirmDeleteTitle', 'Delete Device')}
                </h3>
                <p className="text-xs text-gray-400 mt-0.5">
                  {devices.find((d) => d.id === deleteConfirmId)?.name || 'Device'}
                </p>
              </div>
            </div>
            <p className="text-sm text-gray-300 mb-5">
              {t('settings.peripherals.cashRegister.confirmDeleteMessage', 'Are you sure you want to delete this device? This action cannot be undone.')}
            </p>
            <div className="flex gap-2 justify-end">
              <button
                onClick={() => setDeleteConfirmId(null)}
                className="px-4 py-2 text-sm font-medium rounded-lg bg-white/10 border border-white/20 text-gray-300 hover:bg-white/20 transition-all"
              >
                {t('common.actions.cancel', 'Cancel')}
              </button>
              <button
                onClick={handleDeleteConfirm}
                className="px-4 py-2 text-sm font-medium rounded-lg bg-red-600 hover:bg-red-700 text-white transition-colors"
              >
                {t('common.actions.delete', 'Delete')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )

  // ============================================================
  // RENDER: ADD / EDIT FORM
  // ============================================================

  const renderFormView = () => (
    <div className="space-y-3">
      {/* Header */}
      <div className="flex items-center gap-3 pb-2 border-b liquid-glass-modal-border">
        <Settings className="w-5 h-5 text-amber-400" />
        <h3 className="font-medium liquid-glass-modal-text">
          {viewMode === 'edit'
            ? t('settings.peripherals.cashRegister.editDevice', 'Edit Device')
            : t('settings.peripherals.cashRegister.addDevice', 'Add Device')}
        </h3>
      </div>

      {/* Name */}
      <div>
        <label className="block text-xs font-medium mb-1 liquid-glass-modal-text-muted">
          {t('settings.peripherals.cashRegister.name', 'Device Name')} *
        </label>
        <input
          value={form.name}
          onChange={(e) => updateForm({ name: e.target.value })}
          className="liquid-glass-modal-input"
          placeholder={t('settings.peripherals.cashRegister.namePlaceholder', 'e.g., Main Cash Register') as string}
        />
      </div>

      {/* Device Type */}
      <div>
        <label className="block text-xs font-medium mb-1.5 liquid-glass-modal-text-muted">
          {t('settings.peripherals.cashRegister.deviceType', 'Device Type')}
        </label>
        <div className="flex gap-3">
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="radio"
              name="deviceType"
              checked={form.device_type === 'cash_register'}
              onChange={() => updateForm({ device_type: 'cash_register' })}
              className="accent-cyan-500"
            />
            <span className="text-sm liquid-glass-modal-text">
              {t('settings.peripherals.cashRegister.typeCashRegister', 'Cash Register')}
            </span>
          </label>
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="radio"
              name="deviceType"
              checked={form.device_type === 'payment_terminal'}
              onChange={() => updateForm({ device_type: 'payment_terminal' })}
              className="accent-cyan-500"
            />
            <span className="text-sm liquid-glass-modal-text">
              {t('settings.peripherals.cashRegister.typePaymentTerminal', 'Payment Terminal')}
            </span>
          </label>
        </div>
      </div>

      {/* Brand & Protocol */}
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="block text-xs font-medium mb-1 liquid-glass-modal-text-muted">
            {t('settings.peripherals.cashRegister.brand', 'Brand')}
          </label>
          <select
            value={form.brand}
            onChange={(e) => handleBrandChange(e.target.value)}
            className="liquid-glass-modal-input"
          >
            {BRANDS.map((b) => (
              <option key={b} value={b}>{b}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="block text-xs font-medium mb-1 liquid-glass-modal-text-muted">
            {t('settings.peripherals.cashRegister.protocol', 'Protocol')}
          </label>
          <select
            value={form.protocol}
            onChange={(e) => updateForm({ protocol: e.target.value as Protocol })}
            className="liquid-glass-modal-input"
          >
            <option value="generic">Generic</option>
            <option value="zvt">ZVT (Ingenico/Verifone)</option>
            <option value="pax">PAX</option>
          </select>
        </div>
      </div>

      {/* Connection Type */}
      <div>
        <label className="block text-xs font-medium mb-1 liquid-glass-modal-text-muted">
          {t('settings.peripherals.cashRegister.connectionType', 'Connection Type')}
        </label>
        <select
          value={form.connection_type}
          onChange={(e) => handleConnectionTypeChange(e.target.value as ConnectionType)}
          className="liquid-glass-modal-input"
        >
          <option value="serial_usb">
            {t('settings.peripherals.cashRegister.connSerial', 'Serial / USB')}
          </option>
          <option value="network">
            {t('settings.peripherals.cashRegister.connNetwork', 'Network (TCP)')}
          </option>
          <option value="bluetooth">
            {t('settings.peripherals.cashRegister.connBluetooth', 'Bluetooth')}
          </option>
        </select>
      </div>

      {/* Connection Details: Serial */}
      {form.connection_type === 'serial_usb' && (
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-xs font-medium mb-1 liquid-glass-modal-text-muted">
              {t('settings.peripherals.cashRegister.comPort', 'COM Port')} *
            </label>
            <input
              value={form.com_port || ''}
              onChange={(e) => updateForm({ com_port: e.target.value })}
              className="liquid-glass-modal-input"
              placeholder="COM3"
            />
          </div>
          <div>
            <label className="block text-xs font-medium mb-1 liquid-glass-modal-text-muted">
              {t('settings.peripherals.cashRegister.baudRate', 'Baud Rate')}
            </label>
            <select
              value={form.baud_rate || 9600}
              onChange={(e) => updateForm({ baud_rate: parseInt(e.target.value, 10) })}
              className="liquid-glass-modal-input"
            >
              {BAUD_RATES.map((r) => (
                <option key={r} value={r}>{r}</option>
              ))}
            </select>
          </div>
        </div>
      )}

      {/* Connection Details: Network */}
      {form.connection_type === 'network' && (
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-xs font-medium mb-1 liquid-glass-modal-text-muted">
              {t('settings.peripherals.cashRegister.ipAddress', 'IP Address')} *
            </label>
            <input
              value={form.ip_address || ''}
              onChange={(e) => updateForm({ ip_address: e.target.value })}
              className="liquid-glass-modal-input"
              placeholder="192.168.1.100"
            />
          </div>
          <div>
            <label className="block text-xs font-medium mb-1 liquid-glass-modal-text-muted">
              {t('settings.peripherals.cashRegister.tcpPort', 'TCP Port')}
            </label>
            <input
              type="number"
              value={form.tcp_port || 9100}
              onChange={(e) => updateForm({ tcp_port: parseInt(e.target.value, 10) || 9100 })}
              className="liquid-glass-modal-input"
              placeholder={form.protocol === 'zvt' ? '20007' : '9100'}
            />
          </div>
        </div>
      )}

      {/* Connection Details: Bluetooth */}
      {form.connection_type === 'bluetooth' && (
        <div>
          <label className="block text-xs font-medium mb-1 liquid-glass-modal-text-muted">
            {t('settings.peripherals.cashRegister.macAddress', 'MAC Address')} *
          </label>
          <input
            value={form.mac_address || ''}
            onChange={(e) => updateForm({ mac_address: e.target.value })}
            className="liquid-glass-modal-input font-mono"
            placeholder="00:11:22:33:44:55"
          />
        </div>
      )}

      {/* Print Mode */}
      <div>
        <label className="block text-xs font-medium mb-1.5 liquid-glass-modal-text-muted">
          {t('settings.peripherals.cashRegister.printMode', 'Print Mode')}
        </label>
        <div className="flex gap-3">
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="radio"
              name="printMode"
              checked={form.print_mode === 'register_prints'}
              onChange={() => updateForm({ print_mode: 'register_prints' })}
              className="accent-cyan-500"
            />
            <span className="text-sm liquid-glass-modal-text">
              {t('settings.peripherals.cashRegister.registerPrints', 'Register prints receipt')}
            </span>
          </label>
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="radio"
              name="printMode"
              checked={form.print_mode === 'pos_sends_receipt'}
              onChange={() => updateForm({ print_mode: 'pos_sends_receipt' })}
              className="accent-cyan-500"
            />
            <span className="text-sm liquid-glass-modal-text">
              {t('settings.peripherals.cashRegister.posSendsReceipt', 'POS sends receipt data')}
            </span>
          </label>
        </div>
      </div>

      {/* Tax Rates Table */}
      <div>
        <label className="block text-xs font-medium mb-1.5 liquid-glass-modal-text-muted">
          {t('settings.peripherals.cashRegister.taxRates', 'Tax Rates')}
        </label>
        <div className="rounded-lg border liquid-glass-modal-border overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-white/5">
                <th className="px-3 py-1.5 text-left text-xs font-medium liquid-glass-modal-text-muted">
                  {t('settings.peripherals.cashRegister.taxCode', 'Code')}
                </th>
                <th className="px-3 py-1.5 text-left text-xs font-medium liquid-glass-modal-text-muted">
                  {t('settings.peripherals.cashRegister.taxRate', 'Rate %')}
                </th>
                <th className="px-3 py-1.5 text-left text-xs font-medium liquid-glass-modal-text-muted">
                  {t('settings.peripherals.cashRegister.taxLabel', 'Label')}
                </th>
              </tr>
            </thead>
            <tbody>
              {form.tax_rates.map((row, i) => (
                <tr key={i} className="border-t liquid-glass-modal-border">
                  <td className="px-3 py-1.5">
                    <input
                      value={row.code}
                      onChange={(e) => updateTaxRate(i, 'code', e.target.value)}
                      className="w-12 px-1.5 py-1 rounded bg-white/5 border border-white/10 text-center liquid-glass-modal-text text-xs"
                      maxLength={2}
                    />
                  </td>
                  <td className="px-3 py-1.5">
                    <input
                      value={row.rate}
                      onChange={(e) => updateTaxRate(i, 'rate', e.target.value)}
                      className="w-16 px-1.5 py-1 rounded bg-white/5 border border-white/10 text-center liquid-glass-modal-text text-xs"
                      type="number"
                      min="0"
                      max="100"
                      step="0.01"
                    />
                  </td>
                  <td className="px-3 py-1.5">
                    <input
                      value={row.label}
                      onChange={(e) => updateTaxRate(i, 'label', e.target.value)}
                      className="w-full px-1.5 py-1 rounded bg-white/5 border border-white/10 liquid-glass-modal-text text-xs"
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Operator ID */}
      <div>
        <label className="block text-xs font-medium mb-1 liquid-glass-modal-text-muted">
          {t('settings.peripherals.cashRegister.operatorId', 'Operator ID')}
        </label>
        <input
          value={form.operator_id || ''}
          onChange={(e) => updateForm({ operator_id: e.target.value })}
          className="liquid-glass-modal-input"
          placeholder={t('settings.peripherals.cashRegister.operatorIdPlaceholder', 'Optional') as string}
        />
      </div>

      {/* Default & Enabled */}
      <div className="flex items-center gap-6 pt-1">
        <label className="flex items-center gap-2 cursor-pointer">
          <input
            type="checkbox"
            checked={form.is_default}
            onChange={(e) => updateForm({ is_default: e.target.checked })}
            className="rounded accent-cyan-500"
          />
          <span className="text-sm liquid-glass-modal-text">
            {t('settings.peripherals.cashRegister.setAsDefault', 'Set as default')}
          </span>
        </label>
        <div className="flex items-center gap-2">
          <span className="text-sm liquid-glass-modal-text">
            {t('settings.peripherals.cashRegister.enabled', 'Enabled')}
          </span>
          <label className="relative inline-flex items-center cursor-pointer">
            <input
              type="checkbox"
              checked={form.enabled}
              onChange={(e) => updateForm({ enabled: e.target.checked })}
              className="sr-only peer"
            />
            <div className="w-11 h-6 bg-gray-600 peer-focus:outline-none peer-focus:ring-2 peer-focus:ring-cyan-500/50 rounded-full peer peer-checked:after:translate-x-full rtl:peer-checked:after:-translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:start-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-cyan-500"></div>
          </label>
        </div>
      </div>

      {/* Form Actions */}
      <div className="flex gap-2 pt-3 border-t liquid-glass-modal-border">
        <button
          onClick={() => {
            setViewMode('list')
            resetForm()
          }}
          className="px-4 py-2 rounded-lg text-sm font-medium transition-all bg-white/10 border border-white/20 text-gray-300 hover:bg-white/20"
        >
          {t('common.actions.cancel', 'Cancel')}
        </button>
        <button
          onClick={handleSave}
          disabled={isSaving || !form.name.trim()}
          className="px-4 py-2 rounded-lg text-sm font-medium transition-all bg-cyan-500/20 border border-cyan-500/50 text-cyan-300 hover:bg-cyan-500/30 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {isSaving
            ? t('common.actions.saving', 'Saving...')
            : viewMode === 'edit'
            ? t('common.actions.save', 'Save')
            : t('settings.peripherals.cashRegister.addDevice', 'Add Device')}
        </button>
      </div>
    </div>
  )

  // ============================================================
  // RENDER
  // ============================================================

  if (viewMode === 'add' || viewMode === 'edit') {
    return renderFormView()
  }

  return renderListView()
}

export default CashRegisterSection
