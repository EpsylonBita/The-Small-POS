import React, { useState, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'react-hot-toast'
import { getBridge } from '../../../lib'
import { renderModalPortal } from '../../utils/render-modal-portal'
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
  X,
} from 'lucide-react'
import { POSGlassSwitch } from '../ui/pos-glass-components'

// ============================================================
// TYPES
// ============================================================

type DeviceType = 'cash_register' | 'payment_terminal'
type ConnectionType = 'serial_usb' | 'network' | 'bluetooth'
type Protocol = string
type PrintMode = 'register_prints' | 'pos_sends_receipt'

// Round 295: the cash-register switches (Auto Fiscal Print, Set-as-default, Enabled) now use the shared
// POSGlassSwitch -- one fixed-geometry green-on/neutral-off glass switch -- so they match every other
// Settings switch exactly. The previous local switch-track class was removed.
type DeviceStatus = 'connected' | 'disconnected' | 'error'
type CashRegisterSetupMode = 'rbs_network'

interface TaxRate {
  code: string
  rate: string
  label: string
  department: string
}

interface CapDriverSettings {
  capturePath: string
  outputPath: string
  serviceName: string
  transactionTimeoutMs: number
  cashPaymentCode: number
  cardPaymentCode: number
  eftPosIndex: number
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
  settings: CapDriverSettings
  is_default: boolean
  enabled: boolean
  status?: DeviceStatus
  error_message?: string
}

type FormData = Omit<ECRCashDevice, 'id' | 'status' | 'error_message'>

export interface CashRegisterSetupIntent {
  mode: CashRegisterSetupMode
  token: number
}

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

const BAUD_RATES = [9600, 19200, 38400, 57600, 115200] as const

const DEFAULT_TAX_RATES: TaxRate[] = [
  { code: 'A', rate: '24', label: 'Standard', department: '' },
  { code: 'B', rate: '13', label: 'Reduced', department: '' },
  { code: 'C', rate: '6', label: 'Super Reduced', department: '' },
  { code: 'D', rate: '0', label: 'Zero', department: '' },
]

const DEFAULT_CAP_DRIVER_SETTINGS: CapDriverSettings = {
  capturePath: 'C:\\Capture',
  outputPath: 'C:\\Capture\\Output',
  serviceName: 'CapDriverSVC',
  transactionTimeoutMs: 120000,
  cashPaymentCode: 1,
  cardPaymentCode: 2,
  eftPosIndex: 1,
}

const cloneTaxRates = (taxRates: TaxRate[]): TaxRate[] =>
  taxRates.map((taxRate) => ({ ...taxRate }))

const defaultNetworkPortForDevice = (deviceType: DeviceType): number =>
  deviceType === 'payment_terminal' ? 20007 : 0

const EMPTY_FORM: FormData = {
  name: '',
  device_type: 'cash_register',
  brand: 'Generic',
  protocol: 'unconfigured',
  connection_type: 'serial_usb',
  com_port: '',
  baud_rate: 9600,
  ip_address: '',
  tcp_port: 0,
  mac_address: '',
  print_mode: 'register_prints',
  tax_rates: DEFAULT_TAX_RATES,
  operator_id: '',
  settings: { ...DEFAULT_CAP_DRIVER_SETTINGS },
  is_default: false,
  enabled: true,
}

const buildEmptyForm = (): FormData => ({
  ...EMPTY_FORM,
  tax_rates: cloneTaxRates(DEFAULT_TAX_RATES),
  settings: { ...DEFAULT_CAP_DRIVER_SETTINGS },
})

const buildRbsNetworkPreset = (): FormData => ({
  ...buildEmptyForm(),
  name: 'RBS ELIO CR',
  brand: 'RBS',
  protocol: 'cap_driver',
  connection_type: 'network',
  tcp_port: 9101,
})

const asRecord = (value: unknown): Record<string, any> => {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, any>
  }
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value)
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
    } catch {
      return {}
    }
  }
  return {}
}

const asCapDriverSettings = (value: unknown): CapDriverSettings => {
  const settings = asRecord(value)
  return {
    capturePath:
      typeof settings.capturePath === 'string' && settings.capturePath.trim()
        ? settings.capturePath
        : DEFAULT_CAP_DRIVER_SETTINGS.capturePath,
    outputPath:
      typeof settings.outputPath === 'string' && settings.outputPath.trim()
        ? settings.outputPath
        : DEFAULT_CAP_DRIVER_SETTINGS.outputPath,
    serviceName:
      typeof settings.serviceName === 'string' && settings.serviceName.trim()
        ? settings.serviceName
        : DEFAULT_CAP_DRIVER_SETTINGS.serviceName,
    transactionTimeoutMs:
      Number.isInteger(settings.transactionTimeoutMs)
        ? settings.transactionTimeoutMs
        : DEFAULT_CAP_DRIVER_SETTINGS.transactionTimeoutMs,
    cashPaymentCode:
      Number.isInteger(settings.cashPaymentCode)
        ? settings.cashPaymentCode
        : DEFAULT_CAP_DRIVER_SETTINGS.cashPaymentCode,
    cardPaymentCode:
      Number.isInteger(settings.cardPaymentCode)
        ? settings.cardPaymentCode
        : DEFAULT_CAP_DRIVER_SETTINGS.cardPaymentCode,
    eftPosIndex:
      Number.isInteger(settings.eftPosIndex)
        ? settings.eftPosIndex
        : DEFAULT_CAP_DRIVER_SETTINGS.eftPosIndex,
  }
}

const asDeviceType = (payload: any): DeviceType => {
  const normalized = String(payload?.device_type ?? payload?.deviceType ?? '').toLowerCase()
  if (normalized === 'cash_register' || normalized === 'payment_terminal') {
    return normalized
  }
  if (
    payload?.print_mode ||
    payload?.printMode ||
    Array.isArray(payload?.tax_rates) ||
    Array.isArray(payload?.taxRates) ||
    typeof payload?.brand === 'string'
  ) {
    return 'cash_register'
  }
  return 'payment_terminal'
}

const asConnectionType = (value: unknown): ConnectionType => {
  const normalized = String(value || '').toLowerCase()
  if (normalized === 'serial_usb' || normalized === 'network' || normalized === 'bluetooth') {
    return normalized
  }
  return 'serial_usb'
}

const asProtocol = (value: unknown): Protocol => {
  const normalized = String(value || '').toLowerCase()
  return normalized || 'unconfigured'
}

const asDeviceStatus = (value: unknown): DeviceStatus | undefined => {
  const normalized = String(value || '').toLowerCase()
  if (normalized === 'connected' || normalized === 'disconnected' || normalized === 'error') {
    return normalized
  }
  return undefined
}

const normalizeCashRegisterDevice = (payload: any): ECRCashDevice => {
  const device_type = asDeviceType(payload)
  const connection_type = asConnectionType(payload?.connection_type ?? payload?.connectionType)
  const connectionDetails =
    payload?.connectionDetails && typeof payload.connectionDetails === 'object'
      ? payload.connectionDetails
      : {}

  return {
    id: typeof payload?.id === 'string' ? payload.id : '',
    name: typeof payload?.name === 'string' ? payload.name : '',
    device_type,
    brand:
      typeof payload?.brand === 'string' && payload.brand.trim()
        ? payload.brand
        : typeof payload?.manufacturer === 'string' && payload.manufacturer.trim()
          ? payload.manufacturer
          : 'Generic',
    protocol: asProtocol(payload?.protocol),
    connection_type,
    com_port:
      typeof payload?.com_port === 'string'
        ? payload.com_port
        : typeof payload?.comPort === 'string'
          ? payload.comPort
          : typeof connectionDetails?.port === 'string' && connection_type === 'serial_usb'
            ? (connectionDetails.port as string)
            : '',
    baud_rate:
      typeof payload?.baud_rate === 'number'
        ? payload.baud_rate
        : typeof payload?.baudRate === 'number'
          ? payload.baudRate
          : typeof connectionDetails?.baudRate === 'number'
            ? (connectionDetails.baudRate as number)
            : 9600,
    ip_address:
      typeof payload?.ip_address === 'string'
        ? payload.ip_address
        : typeof payload?.ipAddress === 'string'
          ? payload.ipAddress
          : typeof connectionDetails?.ip === 'string' && connection_type === 'network'
            ? (connectionDetails.ip as string)
            : '',
    tcp_port:
      typeof payload?.tcp_port === 'number'
        ? payload.tcp_port
        : typeof payload?.tcpPort === 'number'
          ? payload.tcpPort
          : typeof connectionDetails?.port === 'number' && connection_type === 'network'
            ? (connectionDetails.port as number)
            : defaultNetworkPortForDevice(device_type),
    mac_address:
      typeof payload?.mac_address === 'string'
        ? payload.mac_address
        : typeof payload?.macAddress === 'string'
          ? payload.macAddress
          : typeof connectionDetails?.address === 'string' && connection_type === 'bluetooth'
            ? (connectionDetails.address as string)
            : '',
    print_mode:
      payload?.print_mode === 'pos_sends_receipt' || payload?.printMode === 'pos_sends_receipt'
        ? 'pos_sends_receipt'
        : 'register_prints',
    tax_rates: Array.isArray(payload?.tax_rates)
      ? cloneTaxRates((payload.tax_rates as TaxRate[]).map((rate) => ({ ...rate, department: String(rate.department ?? '') })))
      : Array.isArray(payload?.taxRates)
        ? cloneTaxRates((payload.taxRates as TaxRate[]).map((rate) => ({ ...rate, department: String(rate.department ?? '') })))
        : cloneTaxRates(DEFAULT_TAX_RATES),
    operator_id:
      typeof payload?.operator_id === 'string'
        ? payload.operator_id
        : typeof payload?.operatorId === 'string'
          ? payload.operatorId
          : '',
    settings: asCapDriverSettings(payload?.settings),
    is_default: payload?.is_default === true || payload?.isDefault === true,
    enabled: payload?.enabled !== false,
    status: asDeviceStatus(payload?.status),
    error_message:
      typeof payload?.error_message === 'string'
        ? payload.error_message
        : typeof payload?.errorMessage === 'string'
          ? payload.errorMessage
          : undefined,
  }
}

const buildCashRegisterDevicePayload = (form: FormData): Record<string, unknown> => {
  const connectionDetails =
    form.connection_type === 'serial_usb'
      ? { port: form.com_port?.trim() || '', baudRate: form.baud_rate || 9600 }
      : form.connection_type === 'bluetooth'
        ? { address: form.mac_address?.trim() || '' }
        : { ip: form.ip_address?.trim() || '', port: Number(form.tcp_port) }

  return {
    name: form.name.trim(),
    deviceType: form.device_type,
    brand: form.brand,
    protocol: form.protocol,
    connectionType: form.connection_type,
    connectionDetails,
    operatorId: form.operator_id?.trim() || null,
    printMode: form.print_mode,
    taxRates: form.tax_rates.map((rate) => ({
      code: rate.code.trim(),
      rate: Number(rate.rate),
      label: rate.label.trim(),
      department: rate.department.trim() ? Number(rate.department) : null,
    })),
    isDefault: form.is_default,
    enabled: form.enabled,
    settings: { ...form.settings },
  }
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
      return bridge.ecr.testConnection(payload.device_id)
    }
    case 'ecr_test_print': {
      const payload = (args as Record<string, any>) || {}
      return bridge.ecr.testPrint(payload.device_id)
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
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-red-500/20 text-red-400" aria-label={error}>
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
  setupIntent?: CashRegisterSetupIntent | null
}

type ViewMode = 'list' | 'add' | 'edit'

export const CashRegisterSection: React.FC<CashRegisterSectionProps> = ({ setupIntent }) => {
  const { t } = useTranslation()

  const [devices, setDevices] = useState<ECRCashDevice[]>([])
  const [loading, setLoading] = useState(true)
  const [viewMode, setViewMode] = useState<ViewMode>('list')
  const [editingDeviceId, setEditingDeviceId] = useState<string | null>(null)
  const [form, setForm] = useState<FormData>(buildEmptyForm())
  const [isSaving, setIsSaving] = useState(false)
  const [isTesting, setIsTesting] = useState<string | null>(null)
  const [showDevices, setShowDevices] = useState(true)
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null)
  const [fiscalPrintEnabled, setFiscalPrintEnabled] = useState(true)

  // Load devices
  const loadDevices = useCallback(async () => {
    try {
      setLoading(true)
      const result = await invokeIPC('ecr_get_devices')
      const list = result?.devices || result?.data || []
      const normalized = Array.isArray(list)
        ? list
            .map((device) => normalizeCashRegisterDevice(device))
            .filter((device) => device.device_type === 'cash_register')
        : []
      setDevices(normalized)
    } catch (e) {
      console.error('Failed to load ECR cash register devices:', e)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    loadDevices()
    // Load fiscal print setting
    const bridge = getBridge()
    bridge.settings.get('terminal', 'fiscal_print_enabled')
      .then((val: any) => {
        // Default to true if not set
        if (val === false || val === 'false' || val === '0') {
          setFiscalPrintEnabled(false)
        } else {
          setFiscalPrintEnabled(true)
        }
      })
      .catch(() => setFiscalPrintEnabled(true))
  }, [loadDevices])

  const handleFiscalPrintToggle = useCallback(async (enabled: boolean) => {
    setFiscalPrintEnabled(enabled)
    try {
      const bridge = getBridge()
      await bridge.settings.set({ category: 'terminal', key: 'fiscal_print_enabled', value: enabled })
      toast.success(
        enabled
          ? t('settings.peripherals.cashRegister.fiscalPrintEnabled', 'Fiscal printing enabled')
          : t('settings.peripherals.cashRegister.fiscalPrintDisabled', 'Fiscal printing disabled')
      )
    } catch (e: any) {
      console.error('Failed to save fiscal print setting:', e)
      setFiscalPrintEnabled(!enabled) // revert on error
      toast.error(t('settings.peripherals.cashRegister.fiscalPrintSaveFailed', 'Failed to save setting'))
    }
  }, [t])

  // Form helpers
  const updateForm = (patch: Partial<FormData>) => {
    setForm((prev) => ({ ...prev, ...patch }))
  }

  const handleBrandChange = (brand: string) => {
    // Brand alone never proves a wire protocol. Reset the profile and require
    // the exact vendor/model ERP protocol to be chosen and handshaken.
    updateForm({ brand, protocol: 'unconfigured' })
  }

  const handleConnectionTypeChange = (connectionType: ConnectionType) => {
    const patch: Partial<FormData> = { connection_type: connectionType }
    if (connectionType === 'network') {
      patch.tcp_port = defaultNetworkPortForDevice('cash_register')
    }
    updateForm(patch)
  }

  const updateTaxRate = (index: number, field: keyof TaxRate, value: string) => {
    const updated = [...form.tax_rates]
    updated[index] = { ...updated[index], [field]: value }
    updateForm({ tax_rates: updated })
  }

  const resetForm = (nextForm: FormData = buildEmptyForm()) => {
    setForm(nextForm)
    setEditingDeviceId(null)
  }

  // Close the Add/Edit device submodal (back to the list) — used by Cancel, the X, the backdrop
  // and Escape. Does not create or delete anything.
  const closeForm = useCallback(() => {
    setViewMode('list')
    setForm(buildEmptyForm())
    setEditingDeviceId(null)
  }, [])

  // Open add form
  const handleAdd = () => {
    resetForm()
    setViewMode('add')
  }

  useEffect(() => {
    if (setupIntent?.mode !== 'rbs_network') return
    setDeleteConfirmId(null)
    resetForm(buildRbsNetworkPreset())
    setViewMode('add')
  }, [setupIntent?.token])

  // Escape closes the Add/Edit device submodal (close-only — never saves).
  useEffect(() => {
    if (viewMode !== 'add' && viewMode !== 'edit') return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      closeForm()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [viewMode, closeForm])

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
      tcp_port: device.tcp_port ?? 0,
      mac_address: device.mac_address || '',
      print_mode: device.print_mode,
      tax_rates: device.tax_rates?.length ? device.tax_rates : DEFAULT_TAX_RATES,
      operator_id: device.operator_id || '',
      settings: { ...device.settings },
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
    if (!form.protocol.trim() || form.protocol === 'unconfigured') {
      toast.error(
        t(
          'settings.peripherals.cashRegister.protocolRequired',
          'Choose the exact vendor/model protocol before saving'
        )
      )
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
    if (
      form.connection_type === 'network' &&
      (!Number.isInteger(form.tcp_port) || Number(form.tcp_port) <= 0 || Number(form.tcp_port) > 65535)
    ) {
      toast.error(
        t('settings.peripherals.cashRegister.tcpPortRequired', 'A valid vendor ERP TCP port is required')
      )
      return
    }
    if (form.connection_type === 'bluetooth' && !form.mac_address?.trim()) {
      toast.error(t('settings.peripherals.cashRegister.macRequired', 'MAC address is required'))
      return
    }
    if (form.protocol === 'cap_driver') {
      const invalidDepartment = form.tax_rates.some(
        (rate) =>
          !Number.isInteger(Number(rate.department)) ||
          Number(rate.department) < 1 ||
          Number(rate.department) > 99
      )
      if (invalidDepartment) {
        toast.error(
          t(
            'settings.peripherals.cashRegister.capDepartmentRequired',
            'Enter the cashier department (1–99) for every VAT rate'
          )
        )
        return
      }
      if (!form.settings.capturePath.trim() || !form.settings.outputPath.trim()) {
        toast.error(
          t(
            'settings.peripherals.cashRegister.capFoldersRequired',
            'CAP Driver capture and output folders are required'
          )
        )
        return
      }
      if (
        !Number.isInteger(form.settings.eftPosIndex) ||
        form.settings.eftPosIndex < 1 ||
        form.settings.eftPosIndex > 99 ||
        !Number.isInteger(form.settings.cashPaymentCode) ||
        form.settings.cashPaymentCode < 1 ||
        form.settings.cashPaymentCode > 20 ||
        !Number.isInteger(form.settings.cardPaymentCode) ||
        form.settings.cardPaymentCode < 1 ||
        form.settings.cardPaymentCode > 20
      ) {
        toast.error(
          t(
            'settings.peripherals.cashRegister.capCodesInvalid',
            'CAP payment codes must be 1–20 and the EFT POS number must be 1–99'
          )
        )
        return
      }
    }

    setIsSaving(true)
    try {
      const nativePayload = buildCashRegisterDevicePayload(form)
      if (viewMode === 'edit' && editingDeviceId) {
        await invokeIPC('ecr_update_device', { device_id: editingDeviceId, ...nativePayload })
        toast.success(t('settings.peripherals.cashRegister.updated', 'Device updated'))
      } else {
        await invokeIPC('ecr_add_device', nativePayload)
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
        className={`rounded-xl backdrop-blur-sm border liquid-glass-modal-border bg-white/5 dark:bg-gray-800/10 transition-all ${
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
                className="flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-semibold transition-transform duration-150 active:scale-95 bg-emerald-600 border border-emerald-500 text-white shadow-sm shadow-emerald-600/30 active:bg-emerald-700"
              >
                <Plus className="w-4 h-4" />
                {t('settings.peripherals.cashRegister.addDevice', 'Add Device')}
              </button>
              <button
                onClick={loadDevices}
                disabled={loading}
                aria-label={t('common.refresh', 'Refresh')}
                className="flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-medium transition-all bg-white/10 border border-white/20 text-gray-300 active:bg-white/20"
              >
                <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
              </button>
            </div>

            {/* Fiscal Print Toggle */}
            <div className="flex items-center justify-between rounded-2xl bg-white/5 dark:bg-gray-800/10 border liquid-glass-modal-border px-3 py-2.5">
              <div className="flex items-center gap-2">
                <Printer className="w-4 h-4 text-amber-400" />
                <div>
                  <span className="text-sm font-medium liquid-glass-modal-text">
                    {t('settings.peripherals.cashRegister.fiscalPrintLabel', 'Auto Fiscal Print')}
                  </span>
                  <span className="block text-xs liquid-glass-modal-text-muted">
                    {t('settings.peripherals.cashRegister.fiscalPrintHelp', 'Send fiscal receipt to cash register on each order')}
                  </span>
                </div>
              </div>
              <POSGlassSwitch
                checked={fiscalPrintEnabled}
                onChange={handleFiscalPrintToggle}
                aria-label={t('settings.peripherals.cashRegister.fiscalPrintLabel', 'Auto Fiscal Print')}
              />
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
                    className="p-3 rounded-2xl bg-white/5 border border-white/10 space-y-2"
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
                              <span className="text-xs bg-amber-500/20 text-amber-400 px-2 py-0.5 rounded flex-shrink-0">
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
                        className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium transition-all bg-amber-500/20 border border-amber-500/50 text-amber-900 dark:text-amber-200 active:bg-amber-500/30 disabled:opacity-50"
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
                        className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium transition-all bg-amber-500/20 border border-amber-500/50 text-amber-900 dark:text-amber-200 active:bg-amber-500/30"
                      >
                        <Printer className="w-3 h-3" />
                        {t('settings.peripherals.cashRegister.testPrint', 'Test Print')}
                      </button>
                      <div className="flex-1" />
                      <button
                        onClick={() => handleEdit(device)}
                        aria-label={t('common.actions.edit', 'Edit')}
                        className="inline-flex h-9 w-9 items-center justify-center rounded-lg text-xs transition-transform duration-150 active:scale-95 bg-white/10 border border-white/20 text-gray-300 active:bg-white/20"
                      >
                        <Pencil className="w-3.5 h-3.5" />
                      </button>
                      <button
                        onClick={() => setDeleteConfirmId(device.id)}
                        aria-label={t('common.actions.delete', 'Delete')}
                        className="inline-flex h-9 w-9 items-center justify-center rounded-lg text-xs transition-transform duration-150 active:scale-95 bg-red-500/10 border border-red-500/30 text-red-400 active:bg-red-500/20"
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
          <div className="bg-gray-900/95 border border-white/15 rounded-3xl p-6 mx-6 max-w-sm w-full shadow-2xl">
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
                className="px-4 py-2 text-sm font-medium rounded-lg bg-white/10 border border-white/20 text-gray-300 active:bg-white/20 transition-all"
              >
                {t('common.actions.cancel', 'Cancel')}
              </button>
              <button
                onClick={handleDeleteConfirm}
                className="px-4 py-2 text-sm font-medium rounded-lg bg-red-600 active:bg-red-700 text-white transition-colors"
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

  // Add/Edit fiscal device runs in a focused glass submodal (portaled to body) so it never inherits
  // the settings page scroll offset or appears mid-form. It has its own scroll body + a sticky glass
  // footer, so fields and actions never overlap at short heights (e.g. 1282x802).
  const renderFormModal = () => renderModalPortal(
    // z-[20050] sits ABOVE the Settings LiquidGlassModal viewport (.liquid-glass-modal-viewport,
    // z-index: 20000) — matching the codebase's nested-above-glass-modal overlays (MenuItemModal,
    // TableCheckManagerModal). z-[1200] rendered behind Settings (live QA, Round 241).
    <div className="fixed inset-0 z-[20050] flex items-center justify-center bg-black/70 backdrop-blur-sm p-3 sm:p-6">
      {/* Backdrop — click closes (close-only, never saves) */}
      <div className="absolute inset-0" onClick={closeForm} aria-hidden="true" />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="cash-register-device-form-title"
        className="relative w-full max-w-2xl rounded-3xl border ring-1 shadow-[0_30px_90px_rgba(0,0,0,0.55)] max-h-[calc(100%-1.5rem)] sm:max-h-[calc(100%-3rem)] flex flex-col overflow-hidden bg-white/90 dark:bg-zinc-950/85 backdrop-blur-2xl border-black/10 dark:border-white/10 ring-black/5 dark:ring-white/10"
      >
        {/* Header (shrink-0) */}
        <div className="flex items-center justify-between gap-3 px-5 py-4 border-b shrink-0 border-black/10 dark:border-white/10">
          <div className="flex items-center gap-3">
            <Settings className="w-5 h-5 text-amber-400" />
            <h3 id="cash-register-device-form-title" className="font-medium liquid-glass-modal-text">
              {viewMode === 'edit'
                ? t('settings.peripherals.cashRegister.editDevice', 'Edit Device')
                : t('settings.peripherals.cashRegister.addDevice', 'Add Device')}
            </h3>
          </div>
          <button
            type="button"
            onClick={closeForm}
            aria-label={t('common.actions.close', 'Close')}
            className="inline-flex h-11 w-11 items-center justify-center rounded-xl border transition-transform duration-150 active:scale-95 bg-white/10 border-white/20 text-gray-300 active:bg-white/20"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Body — own scroll + min-h-0 so the sticky footer always keeps its reserved space. */}
        <div className="px-5 py-4 overflow-y-auto flex-1 min-h-0 scrollbar-hide space-y-3">
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
            {!['unconfigured', 'cap_driver', 'generic', 'zvt', 'pax'].includes(form.protocol) && (
              <option value={form.protocol}>{form.protocol}</option>
            )}
            <option value="unconfigured">
              {t(
                'settings.peripherals.cashRegister.protocolUnconfigured',
                'Choose verified protocol…'
              )}
            </option>
            <option value="generic">
              {t(
                'settings.peripherals.cashRegister.legacyDatecsProtocol',
                'Legacy Datecs-style STX/ETX'
              )}
            </option>
            <option value="cap_driver">
              {t(
                'settings.peripherals.cashRegister.capDriverProtocol',
                'CAP Driver (RBS/MAT)'
              )}
            </option>
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
              value={form.tcp_port ?? ''}
              onChange={(e) =>
                updateForm({
                  tcp_port: e.target.value === '' ? 0 : parseInt(e.target.value, 10),
                })
              }
              className="liquid-glass-modal-input"
              placeholder={form.protocol === 'zvt' ? '20007' : ''}
            />
          </div>
          {form.brand === 'RBS' && (
            <div className="col-span-2 rounded-2xl border border-amber-500/20 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
              {t(
                'settings.peripherals.cashRegister.rbsNetworkHint',
                'For ELIO/EDO devices using the vendor CAP Driver, use the cashier ERP IP/port and select CAP Driver. The Windows service owns the authenticated device connection.'
              )}
            </div>
          )}
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

      {form.protocol === 'cap_driver' && (
        <div className="space-y-3 rounded-2xl border border-purple-500/20 bg-purple-500/10 p-3">
          <div>
            <div className="text-sm font-medium liquid-glass-modal-text">
              {t('settings.peripherals.cashRegister.capDriverSettings', 'CAP Driver service')}
            </div>
            <p className="mt-1 text-xs liquid-glass-modal-text-muted">
              {t(
                'settings.peripherals.cashRegister.capDriverHelp',
                'Install and configure the vendor service on this Windows PC. The cashier serial number and unlock key stay only in that service. Test Connection prints a non-closing X report.'
              )}
            </p>
          </div>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            <div>
              <label className="block text-xs font-medium mb-1 liquid-glass-modal-text-muted">
                {t('settings.peripherals.cashRegister.capCapturePath', 'Capture folder')}
              </label>
              <input
                value={form.settings.capturePath}
                onChange={(event) =>
                  updateForm({
                    settings: { ...form.settings, capturePath: event.target.value },
                  })
                }
                className="liquid-glass-modal-input"
                placeholder="C:\Capture"
              />
            </div>
            <div>
              <label className="block text-xs font-medium mb-1 liquid-glass-modal-text-muted">
                {t('settings.peripherals.cashRegister.capOutputPath', 'Output folder')}
              </label>
              <input
                value={form.settings.outputPath}
                onChange={(event) =>
                  updateForm({
                    settings: { ...form.settings, outputPath: event.target.value },
                  })
                }
                className="liquid-glass-modal-input"
                placeholder="C:\Capture\Output"
              />
            </div>
            <div>
              <label className="block text-xs font-medium mb-1 liquid-glass-modal-text-muted">
                {t('settings.peripherals.cashRegister.capEftIndex', 'Paired EFT POS number')}
              </label>
              <input
                type="number"
                min="1"
                max="99"
                value={form.settings.eftPosIndex}
                onChange={(event) =>
                  updateForm({
                    settings: {
                      ...form.settings,
                      eftPosIndex: Number(event.target.value),
                    },
                  })
                }
                className="liquid-glass-modal-input"
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium mb-1 liquid-glass-modal-text-muted">
                  {t('settings.peripherals.cashRegister.capCashCode', 'Cash code')}
                </label>
                <input
                  type="number"
                  min="1"
                  max="20"
                  value={form.settings.cashPaymentCode}
                  onChange={(event) =>
                    updateForm({
                      settings: {
                        ...form.settings,
                        cashPaymentCode: Number(event.target.value),
                      },
                    })
                  }
                  className="liquid-glass-modal-input"
                />
              </div>
              <div>
                <label className="block text-xs font-medium mb-1 liquid-glass-modal-text-muted">
                  {t('settings.peripherals.cashRegister.capCardCode', 'Card code')}
                </label>
                <input
                  type="number"
                  min="1"
                  max="20"
                  value={form.settings.cardPaymentCode}
                  onChange={(event) =>
                    updateForm({
                      settings: {
                        ...form.settings,
                        cardPaymentCode: Number(event.target.value),
                      },
                    })
                  }
                  className="liquid-glass-modal-input"
                />
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Print Mode */}
      <div>
        <label className="block text-xs font-medium mb-1.5 liquid-glass-modal-text-muted">
          {t('settings.peripherals.cashRegister.printMode', 'Print Mode')}
        </label>
        <div className="grid grid-cols-2 gap-2">
          <label className="cursor-pointer">
            <input
              type="radio"
              name="printMode"
              checked={form.print_mode === 'register_prints'}
              onChange={() => updateForm({ print_mode: 'register_prints' })}
              className="sr-only peer"
            />
            <div className="flex min-h-[44px] items-center justify-center rounded-xl border-2 border-white/15 bg-white/5 px-3 py-2.5 text-center text-sm liquid-glass-modal-text transition-colors peer-checked:border-yellow-500 peer-checked:bg-yellow-400/15 peer-checked:text-yellow-900 dark:peer-checked:text-yellow-200 peer-focus:outline-none peer-focus:ring-2 peer-focus:ring-yellow-500/50">
              {t('settings.peripherals.cashRegister.registerPrints', 'Register prints receipt')}
            </div>
          </label>
          <label className="cursor-pointer">
            <input
              type="radio"
              name="printMode"
              checked={form.print_mode === 'pos_sends_receipt'}
              onChange={() => updateForm({ print_mode: 'pos_sends_receipt' })}
              className="sr-only peer"
            />
            <div className="flex min-h-[44px] items-center justify-center rounded-xl border-2 border-white/15 bg-white/5 px-3 py-2.5 text-center text-sm liquid-glass-modal-text transition-colors peer-checked:border-yellow-500 peer-checked:bg-yellow-400/15 peer-checked:text-yellow-900 dark:peer-checked:text-yellow-200 peer-focus:outline-none peer-focus:ring-2 peer-focus:ring-yellow-500/50">
              {t('settings.peripherals.cashRegister.posSendsReceipt', 'POS sends receipt data')}
            </div>
          </label>
        </div>
      </div>

      {/* Tax Rates Table */}
      <div>
        <label className="block text-xs font-medium mb-1.5 liquid-glass-modal-text-muted">
          {t('settings.peripherals.cashRegister.taxRates', 'Tax Rates')}
        </label>
        <div className="rounded-2xl border liquid-glass-modal-border overflow-hidden">
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
                <th className="px-3 py-1.5 text-left text-xs font-medium liquid-glass-modal-text-muted">
                  {t('settings.peripherals.cashRegister.taxDepartment', 'Department')}
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
                  <td className="px-3 py-1.5">
                    <input
                      value={row.department}
                      onChange={(e) => updateTaxRate(i, 'department', e.target.value)}
                      className="w-16 px-1.5 py-1 rounded bg-white/5 border border-white/10 text-center liquid-glass-modal-text text-xs"
                      type="number"
                      min="1"
                      max="99"
                      placeholder={form.protocol === 'cap_driver' ? '1–99' : '—'}
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
      <div className="flex flex-wrap items-center gap-3 pt-1">
        <div className="inline-flex items-center gap-3 rounded-xl border liquid-glass-modal-border bg-white/5 px-3 py-2.5">
          <span className="text-sm liquid-glass-modal-text">
            {t('settings.peripherals.cashRegister.setAsDefault', 'Set as default')}
          </span>
          <POSGlassSwitch
            checked={form.is_default}
            onChange={(next) => updateForm({ is_default: next })}
            aria-label={t('settings.peripherals.cashRegister.setAsDefault', 'Set as default')}
          />
        </div>
        <div className="inline-flex items-center gap-3 rounded-xl border liquid-glass-modal-border bg-white/5 px-3 py-2.5">
          <span className="text-sm liquid-glass-modal-text">
            {t('settings.peripherals.cashRegister.enabled', 'Enabled')}
          </span>
          <POSGlassSwitch
            checked={form.enabled}
            onChange={(next) => updateForm({ enabled: next })}
            aria-label={t('settings.peripherals.cashRegister.enabled', 'Enabled')}
          />
        </div>
      </div>

        </div>

        {/* Footer — sticky glass bar (shrink-0); reserved by the flex column so it never overlaps
            the fields, and the actions are always reachable without scrolling the page. */}
        <div className="px-5 py-4 border-t shrink-0 backdrop-blur-xl border-black/10 dark:border-white/10 bg-white/70 dark:bg-zinc-950/70">
          <div className="flex gap-2 justify-end">
            {/* Cancel = soft destructive red */}
            <button
              onClick={closeForm}
              className="px-4 py-2 rounded-lg text-sm font-medium border transition-transform duration-150 active:scale-95 border-red-500/40 bg-red-500/10 text-red-600 dark:text-red-300 active:bg-red-500/20"
            >
              {t('common.actions.cancel', 'Cancel')}
            </button>
            {/* Save / Add = green primary with a clear disabled state */}
            <button
              onClick={handleSave}
              disabled={isSaving || !form.name.trim()}
              className="px-4 py-2 rounded-lg text-sm font-semibold bg-emerald-600 text-white border border-emerald-500 shadow-sm shadow-emerald-600/30 transition-transform duration-150 active:scale-95 active:bg-emerald-700 disabled:opacity-50 disabled:cursor-not-allowed disabled:active:scale-100"
            >
              {isSaving
                ? t('common.actions.saving', 'Saving...')
                : viewMode === 'edit'
                ? t('common.actions.save', 'Save')
                : t('settings.peripherals.cashRegister.addDevice', 'Add Device')}
            </button>
          </div>
        </div>
      </div>
    </div>
  )

  // ============================================================
  // RENDER
  // ============================================================

  // The list stays mounted; the Add/Edit form opens as a focused submodal overlay on top of it,
  // so it no longer renders inline in the scrolled settings page.
  return (
    <>
      {renderListView()}
      {(viewMode === 'add' || viewMode === 'edit') && renderFormModal()}
    </>
  )
}

export default CashRegisterSection
