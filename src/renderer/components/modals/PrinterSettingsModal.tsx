import React, { useEffect, useState, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'react-hot-toast'
import { LiquidGlassModal } from '../ui/pos-glass-components'
import { liquidGlassModalButton } from '../../styles/designSystem'
import { discoverBluetoothPrinters, getBluetoothStatus } from '../../utils/web-bluetooth-printer-discovery'

// Types matching the printer module types
type PrinterType = 'network' | 'bluetooth' | 'usb' | 'wifi' | 'system'
type PrinterRole = 'receipt' | 'kitchen' | 'bar' | 'label'
type PrinterState = 'online' | 'offline' | 'error' | 'busy'
type PaperSize = '58mm' | '80mm' | '112mm'
type GreekRenderMode = 'text' | 'bitmap'
type ReceiptTemplate = 'classic' | 'modern'

interface ConnectionDetails {
  type: string
  ip?: string
  port?: number
  hostname?: string
  address?: string
  channel?: number
  deviceName?: string
  vendorId?: number
  productId?: number
  systemName?: string
  path?: string
}

interface PrinterConfig {
  id: string
  name: string
  type: PrinterType
  connectionDetails: ConnectionDetails
  paperSize: PaperSize
  characterSet: string
  greekRenderMode?: GreekRenderMode
  receiptTemplate?: ReceiptTemplate
  role: PrinterRole
  isDefault: boolean
  fallbackPrinterId?: string
  enabled: boolean
  createdAt: Date
  updatedAt: Date
}

interface PrinterStatus {
  printerId: string
  state: PrinterState
  errorCode?: string
  errorMessage?: string
  lastSeen: Date
  queueLength: number
}

interface DiscoveredPrinter {
  name: string
  type: PrinterType
  address: string
  port?: number
  model?: string
  manufacturer?: string
  isConfigured: boolean
}

interface PrinterDiagnostics {
  printerId: string
  connectionType: PrinterType
  connectionLatencyMs?: number
  signalStrength?: number
  model?: string
  firmwareVersion?: string
  recentJobs: {
    total: number
    successful: number
    failed: number
  }
}

interface Props {
  isOpen: boolean
  onClose: () => void
}

// View modes for the modal
type ViewMode = 'list' | 'add' | 'edit' | 'discover' | 'diagnostics'

// Status indicator component
const StatusIndicator: React.FC<{ state: PrinterState }> = ({ state }) => {
  const colors: Record<PrinterState, string> = {
    online: 'bg-green-500',
    offline: 'bg-gray-500',
    error: 'bg-red-500',
    busy: 'bg-yellow-500',
  }
  return (
    <span className={`inline-block w-2 h-2 rounded-full ${colors[state] || 'bg-gray-400'}`} />
  )
}

const PrinterSettingsModal: React.FC<Props> = ({ isOpen, onClose }) => {
  const { t } = useTranslation()
  const api = (window as any)?.electronAPI

  // State
  const [viewMode, setViewMode] = useState<ViewMode>('list')
  const [printers, setPrinters] = useState<PrinterConfig[]>([])
  const [statuses, setStatuses] = useState<Record<string, PrinterStatus>>({})
  const [discoveredPrinters, setDiscoveredPrinters] = useState<DiscoveredPrinter[]>([])
  const [selectedPrinter, setSelectedPrinter] = useState<PrinterConfig | null>(null)
  const [diagnostics, setDiagnostics] = useState<PrinterDiagnostics | null>(null)
  const [loading, setLoading] = useState(false)
  const [scanning, setScanning] = useState(false)

  // Form state for add/edit
  const [formData, setFormData] = useState({
    name: '',
    type: 'network' as PrinterType,
    ip: '',
    port: 9100,
    bluetoothAddress: '',
    bluetoothChannel: 1,
    usbVendorId: 0,
    usbProductId: 0,
    usbSystemName: '',
    usbPath: '',
    systemPrinterName: '',
    paperSize: '80mm' as PaperSize,
    characterSet: 'PC437_USA',
    greekRenderMode: 'text' as GreekRenderMode,
    receiptTemplate: 'classic' as ReceiptTemplate,
    role: 'receipt' as PrinterRole,
    isDefault: false,
    fallbackPrinterId: '',
    enabled: true,
  })

  // Load printers and statuses
  const loadPrinters = useCallback(async () => {
    try {
      const result = await api?.printerGetAll?.()
      if (result?.success) {
        setPrinters(result.printers || [])
      }
    } catch (e) {
      console.error('Failed to load printers:', e)
    }
  }, [api])

  const loadStatuses = useCallback(async () => {
    try {
      const result = await api?.printerGetAllStatuses?.()
      if (result?.success) {
        setStatuses(result.statuses || {})
      }
    } catch (e) {
      console.error('Failed to load statuses:', e)
    }
  }, [api])

  // Initial load and status polling
  useEffect(() => {
    if (!isOpen) return
    loadPrinters()
    loadStatuses()
    const interval = setInterval(loadStatuses, 5000) // Poll every 5 seconds
    return () => clearInterval(interval)
  }, [isOpen, loadPrinters, loadStatuses])

  // Listen for real-time status changes
  useEffect(() => {
    if (!isOpen) return
    const unsubscribe = api?.onPrinterStatusChanged?.((data: { printerId: string; status: PrinterStatus }) => {
      setStatuses(prev => ({ ...prev, [data.printerId]: data.status }))
    })
    return () => unsubscribe?.()
  }, [isOpen, api])

  // Discover printers (network, USB, system)
  const handleDiscover = async (types?: PrinterType[]) => {
    setScanning(true)
    try {
      const result = await api?.printerDiscover?.(types)
      if (result?.success) {
        setDiscoveredPrinters(result.printers || [])
        setViewMode('discover')
      } else {
        toast.error(result?.error || t('settings.printer.discoveryFailed'))
      }
    } catch (e) {
      console.error('Discovery failed:', e)
      toast.error(t('settings.printer.discoveryFailed'))
    } finally {
      setScanning(false)
    }
  }

  // Discover Bluetooth printers - uses native Windows Bluetooth detection
  const handleDiscoverBluetooth = async () => {
    setScanning(true)
    try {
      console.log('[PrinterSettings] Scanning for Bluetooth devices...')

      // Call the updated handler that scans Windows paired devices
      const result = await api?.printerDiscover?.(['bluetooth'])

      if (result?.success) {
        const btDevices = result.printers || []
        console.log('[PrinterSettings] Found Bluetooth devices:', btDevices)

        if (btDevices.length > 0) {
          // Replace discovered printers with Bluetooth results
          setDiscoveredPrinters(btDevices)
          setViewMode('discover')
          toast.success(t('settings.printer.bluetoothDeviceFound', { count: btDevices.length }))
        } else {
          toast(t('settings.printer.noBluetoothDevicesFound'), { icon: 'ℹ️' })
        }
      } else {
        toast.error(result?.error || t('settings.printer.bluetoothDiscoveryFailed'))
      }
    } catch (e: any) {
      console.error('Bluetooth discovery failed:', e)
      toast.error(e.message || t('settings.printer.bluetoothDiscoveryFailed'))
    } finally {
      setScanning(false)
    }
  }

  // Add printer from discovered
  const handleAddFromDiscovered = (discovered: DiscoveredPrinter) => {
    const connectionDetails: ConnectionDetails = { type: discovered.type }
    let usbVendorId = 0
    let usbProductId = 0
    
    if (discovered.type === 'network' || discovered.type === 'wifi') {
      connectionDetails.ip = discovered.address
      connectionDetails.port = discovered.port || 9100
    } else if (discovered.type === 'bluetooth') {
      connectionDetails.address = discovered.address
      connectionDetails.channel = 1
    } else if (discovered.type === 'usb') {
      connectionDetails.path = discovered.address
      // Parse USB address format "vendorId:productId" (e.g., "1046:20497")
      const usbParts = discovered.address.split(':')
      if (usbParts.length === 2) {
        usbVendorId = parseInt(usbParts[0], 10) || 0
        usbProductId = parseInt(usbParts[1], 10) || 0
      }
    }

    setFormData({
      name: discovered.name || `${discovered.type} Printer`,
      type: discovered.type,
      ip: connectionDetails.ip || '',
      port: connectionDetails.port || 9100,
      bluetoothAddress: connectionDetails.address || '',
      bluetoothChannel: connectionDetails.channel || 1,
      usbVendorId,
      usbProductId,
      usbSystemName: '',
      usbPath: connectionDetails.path || '',
      systemPrinterName: '',
      paperSize: '80mm',
      characterSet: 'PC437_USA',
      greekRenderMode: 'text',
      receiptTemplate: 'classic',
      role: 'receipt',
      isDefault: printers.length === 0,
      fallbackPrinterId: '',
      enabled: true,
    })
    setViewMode('add')
  }

  // Build connection details from form
  const buildConnectionDetails = (): ConnectionDetails => {
    switch (formData.type) {
      case 'network':
      case 'wifi':
        return {
          type: formData.type,
          ip: formData.ip,
          port: formData.port,
        }
      case 'bluetooth':
        return {
          type: 'bluetooth',
          address: formData.bluetoothAddress,
          channel: formData.bluetoothChannel,
        }
      case 'usb':
        return {
          type: 'usb',
          vendorId: formData.usbVendorId,
          productId: formData.usbProductId,
          systemName: formData.usbSystemName,
          path: formData.usbPath,
        }
      case 'system':
        return {
          type: 'system',
          systemName: formData.systemPrinterName,
        }
      default:
        return { type: formData.type }
    }
  }

  // Save printer (add or update)
  const handleSave = async () => {
    setLoading(true)
    try {
      const config = {
        name: formData.name,
        type: formData.type,
        connectionDetails: buildConnectionDetails(),
        paperSize: formData.paperSize,
        characterSet: formData.characterSet,
        greekRenderMode: formData.greekRenderMode,
        receiptTemplate: formData.receiptTemplate,
        role: formData.role,
        isDefault: formData.isDefault,
        fallbackPrinterId: formData.fallbackPrinterId || undefined,
        enabled: formData.enabled,
      }

      let result
      if (selectedPrinter) {
        result = await api?.printerUpdate?.(selectedPrinter.id, config)
      } else {
        result = await api?.printerAdd?.(config)
      }

      if (result?.success) {
        toast.success(t('settings.printer.saved'))
        await loadPrinters()
        setViewMode('list')
        setSelectedPrinter(null)
        resetForm()
      } else {
        toast.error(result?.error || t('errors.operationFailed'))
      }
    } catch (e) {
      console.error('Save failed:', e)
      toast.error(t('errors.operationFailed'))
    } finally {
      setLoading(false)
    }
  }

  // Delete printer
  const handleDelete = async (printerId: string) => {
    if (!confirm(t('settings.printer.confirmDelete'))) return
    setLoading(true)
    try {
      const result = await api?.printerRemove?.(printerId)
      if (result?.success) {
        toast.success(t('settings.printer.deleted'))
        await loadPrinters()
      } else {
        toast.error(result?.error || t('errors.operationFailed'))
      }
    } catch (e) {
      console.error('Delete failed:', e)
      toast.error(t('errors.operationFailed'))
    } finally {
      setLoading(false)
    }
  }

  // Test print with detailed error handling
  // Requirements: 10.1, 10.2, 10.3, 10.5
  const handleTestPrint = async (printerId: string) => {
    setLoading(true)
    const printer = printers.find(p => p.id === printerId)
    const printerName = printer?.name || 'Printer'
    
    try {
      const result = await api?.printerTest?.(printerId)
      if (result?.success) {
        const latencyInfo = result.latencyMs ? ` (${result.latencyMs}ms)` : ''
        toast.success(`${printerName}: ${t('settings.printer.testPrintSuccess')}${latencyInfo}`)
      } else {
        // Show detailed error message (Requirement 10.3)
        const errorMsg = result?.error || t('settings.printer.testPrintFailed')
        toast.error(`${printerName}: ${errorMsg}`, { duration: 6000 })
        
        // Log error and automatically show diagnostics for troubleshooting
        console.error(`Test print failed for ${printerName}:`, result?.error)
        
        // Automatically navigate to diagnostics view to help troubleshoot
        handleGetDiagnostics(printerId)
      }
    } catch (e) {
      console.error('Test print failed:', e)
      const errorMessage = e instanceof Error ? e.message : String(t('settings.printer.testPrintFailed'))
      toast.error(`${printerName}: ${errorMessage}`, { duration: 6000 })
      
      // Automatically navigate to diagnostics view to help troubleshoot
      handleGetDiagnostics(printerId)
    } finally {
      setLoading(false)
    }
  }

  // Get diagnostics
  const handleGetDiagnostics = async (printerId: string) => {
    setLoading(true)
    try {
      const result = await api?.printerGetDiagnostics?.(printerId)
      if (result?.success) {
        setDiagnostics(result.diagnostics)
        setViewMode('diagnostics')
      } else {
        toast.error(result?.error || t('errors.operationFailed'))
      }
    } catch (e) {
      console.error('Get diagnostics failed:', e)
      toast.error(t('errors.operationFailed'))
    } finally {
      setLoading(false)
    }
  }

  // Edit printer
  const handleEdit = (printer: PrinterConfig) => {
    setSelectedPrinter(printer)
    const conn = printer.connectionDetails
    setFormData({
      name: printer.name,
      type: printer.type,
      ip: conn.ip || '',
      port: conn.port || 9100,
      bluetoothAddress: conn.address || '',
      bluetoothChannel: conn.channel || 1,
      usbVendorId: conn.vendorId || 0,
      usbProductId: conn.productId || 0,
      usbSystemName: conn.systemName || '',
      usbPath: conn.path || '',
      systemPrinterName: printer.type === 'system' ? (conn.systemName || '') : '',
      paperSize: printer.paperSize,
      characterSet: printer.characterSet,
      greekRenderMode: printer.greekRenderMode || 'text',
      receiptTemplate: printer.receiptTemplate || 'classic',
      role: printer.role,
      isDefault: printer.isDefault,
      fallbackPrinterId: printer.fallbackPrinterId || '',
      enabled: printer.enabled,
    })
    setViewMode('edit')
  }

  // Reset form
  const resetForm = () => {
    setFormData({
      name: '',
      type: 'network',
      ip: '',
      port: 9100,
      bluetoothAddress: '',
      bluetoothChannel: 1,
      usbVendorId: 0,
      usbProductId: 0,
      usbSystemName: '',
      usbPath: '',
      systemPrinterName: '',
      paperSize: '80mm',
      characterSet: 'PC437_USA',
      greekRenderMode: 'text',
      receiptTemplate: 'classic',
      role: 'receipt',
      isDefault: false,
      fallbackPrinterId: '',
      enabled: true,
    })
    setSelectedPrinter(null)
  }

  // Get role label
  const getRoleLabel = (role: PrinterRole): string => {
    const labels: Record<PrinterRole, string> = {
      receipt: t('settings.printer.roleReceipt'),
      kitchen: t('settings.printer.roleKitchen'),
      bar: t('settings.printer.roleBar'),
      label: t('settings.printer.roleLabel'),
    }
    return labels[role] || role
  }

  // Get state label
  const getStateLabel = (state: PrinterState): string => {
    const labels: Record<PrinterState, string> = {
      online: t('settings.printer.stateOnline'),
      offline: t('settings.printer.stateOffline'),
      error: t('settings.printer.stateError'),
      busy: t('settings.printer.stateBusy'),
    }
    return labels[state] || state
  }

  // Get printers by role
  const getPrintersByRole = (role: PrinterRole): PrinterConfig[] => {
    return printers.filter(p => p.role === role && p.enabled)
  }

  // Render role assignment summary
  const renderRolesSummary = () => {
    const roles: PrinterRole[] = ['receipt', 'kitchen', 'bar', 'label']
    const roleIcons: Record<PrinterRole, string> = {
      receipt: '🧾',
      kitchen: '👨‍🍳',
      bar: '🍸',
      label: '🏷️',
    }

    return (
      <div className="grid grid-cols-2 md:grid-cols-4 gap-2 mb-4">
        {roles.map(role => {
          const rolePrinters = getPrintersByRole(role)
          const hasOnline = rolePrinters.some(p => statuses[p.id]?.state === 'online')
          return (
            <div
              key={role}
              className={`p-2 rounded-lg border ${
                rolePrinters.length > 0
                  ? hasOnline
                    ? 'bg-green-500/10 border-green-500/30'
                    : 'bg-yellow-500/10 border-yellow-500/30'
                  : 'bg-white/5 border-white/10'
              }`}
            >
              <div className="flex items-center gap-1 text-sm">
                <span>{roleIcons[role]}</span>
                <span className="font-medium liquid-glass-modal-text">{getRoleLabel(role)}</span>
              </div>
              <div className="text-xs liquid-glass-modal-text-muted mt-1">
                {rolePrinters.length === 0
                  ? t('settings.printer.noAssigned')
                  : rolePrinters.map(p => p.name).join(', ')}
              </div>
            </div>
          )
        })}
      </div>
    )
  }

  // Render printer list view
  const renderListView = () => (
    <div className="space-y-4">
      {/* Action buttons */}
      <div className="flex gap-2 flex-wrap">
        <button
          onClick={() => { resetForm(); setViewMode('add') }}
          className={liquidGlassModalButton('primary', 'sm')}
        >
          {t('settings.printer.addPrinter')}
        </button>
        <button
          onClick={() => handleDiscover()}
          disabled={scanning}
          className={liquidGlassModalButton('secondary', 'sm')}
        >
          {scanning ? t('settings.printer.scanning') : t('settings.printer.discoverPrinters')}
        </button>
        <button
          onClick={handleDiscoverBluetooth}
          disabled={scanning}
          className={liquidGlassModalButton('secondary', 'sm')}
          title={t('settings.printer.discoverBluetoothTooltip')}
        >
          {t('settings.printer.discoverBluetooth')}
        </button>
      </div>

      {/* Role assignments summary */}
      {printers.length > 0 && renderRolesSummary()}

      {/* Printer list */}
      {printers.length === 0 ? (
        <div className="text-center py-8 liquid-glass-modal-text-muted">
          {t('settings.printer.noPrintersConfigured')}
        </div>
      ) : (
        <div className="space-y-2">
          {printers.map(printer => {
            const status = statuses[printer.id]
            return (
              <div
                key={printer.id}
                className="p-3 rounded-lg bg-white/5 border border-white/10 flex items-center justify-between"
              >
                <div className="flex items-center gap-3">
                  <StatusIndicator state={status?.state || 'offline'} />
                  <div>
                    <div className="font-medium liquid-glass-modal-text">
                      {printer.name}
                      {printer.isDefault && (
                        <span className="ml-2 text-xs bg-blue-500/20 text-blue-300 px-2 py-0.5 rounded">
                          {t('settings.printer.default')}
                        </span>
                      )}
                    </div>
                    <div className="text-xs liquid-glass-modal-text-muted">
                      {printer.type.toUpperCase()} • {getRoleLabel(printer.role)}
                      {status && ` • ${getStateLabel(status.state)}`}
                      {status?.queueLength > 0 && ` • ${status.queueLength} ${t('settings.printer.jobsInQueue')}`}
                    </div>
                  </div>
                </div>
                <div className="flex gap-1">
                  <button
                    onClick={() => handleTestPrint(printer.id)}
                    disabled={loading}
                    className={liquidGlassModalButton('secondary', 'sm')}
                    title={t('settings.printer.testPrint')}
                  >
                    🖨️
                  </button>
                  <button
                    onClick={() => handleGetDiagnostics(printer.id)}
                    disabled={loading}
                    className={liquidGlassModalButton('secondary', 'sm')}
                    title={t('settings.printer.diagnostics')}
                  >
                    📊
                  </button>
                  <button
                    onClick={() => handleEdit(printer)}
                    className={liquidGlassModalButton('secondary', 'sm')}
                    title={t('common.actions.edit')}
                  >
                    ✏️
                  </button>
                  <button
                    onClick={() => handleDelete(printer.id)}
                    disabled={loading}
                    className={liquidGlassModalButton('danger', 'sm')}
                    title={t('common.actions.delete')}
                  >
                    🗑️
                  </button>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )

  // Render discovery view
  const renderDiscoverView = () => (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="font-medium liquid-glass-modal-text">{t('settings.printer.discoveredPrinters')}</h3>
        <button
          onClick={() => handleDiscover()}
          disabled={scanning}
          className={liquidGlassModalButton('secondary', 'sm')}
        >
          {scanning ? t('settings.printer.scanning') : t('settings.printer.refresh')}
        </button>
      </div>

      {discoveredPrinters.length === 0 ? (
        <div className="text-center py-8 liquid-glass-modal-text-muted">
          {scanning ? t('settings.printer.scanning') : t('settings.printer.noDevicesFound')}
        </div>
      ) : (
        <div className="space-y-2">
          {discoveredPrinters.map((printer, idx) => (
            <div
              key={idx}
              className="p-3 rounded-lg bg-white/5 border border-white/10 flex items-center justify-between"
            >
              <div>
                <div className="font-medium liquid-glass-modal-text">{printer.name}</div>
                <div className="text-xs liquid-glass-modal-text-muted">
                  {printer.type.toUpperCase()} • {printer.address}
                  {printer.port && `:${printer.port}`}
                  {printer.model && ` • ${printer.model}`}
                </div>
              </div>
              <button
                onClick={() => handleAddFromDiscovered(printer)}
                disabled={printer.isConfigured}
                className={liquidGlassModalButton(printer.isConfigured ? 'secondary' : 'primary', 'sm')}
              >
                {printer.isConfigured ? t('settings.printer.alreadyConfigured') : t('settings.printer.add')}
              </button>
            </div>
          ))}
        </div>
      )}

      <button onClick={() => setViewMode('list')} className={liquidGlassModalButton('secondary', 'md')}>
        {t('common.actions.back')}
      </button>
    </div>
  )

  // Render add/edit form
  const renderFormView = () => (
    <div className="space-y-4">
      <h3 className="font-medium liquid-glass-modal-text">
        {viewMode === 'edit' ? t('settings.printer.editPrinter') : t('settings.printer.addPrinter')}
      </h3>

      {/* Name */}
      <div>
        <label className="block text-xs font-medium mb-1 liquid-glass-modal-text-muted">
          {t('settings.printer.name')}
        </label>
        <input
          value={formData.name}
          onChange={e => setFormData(prev => ({ ...prev, name: e.target.value }))}
          className="liquid-glass-modal-input"
          placeholder={t('settings.printer.namePlaceholder') as string}
        />
      </div>

      {/* Type */}
      <div>
        <label className="block text-xs font-medium mb-1 liquid-glass-modal-text-muted">
          {t('settings.printer.type')}
        </label>
        <select
          value={formData.type}
          onChange={e => setFormData(prev => ({ ...prev, type: e.target.value as PrinterType }))}
          className="liquid-glass-modal-input"
        >
          <option value="network">{t('settings.printer.typeNetwork')}</option>
          <option value="wifi">{t('settings.printer.typeWifi')}</option>
          <option value="bluetooth">{t('settings.printer.typeBluetooth')}</option>
          <option value="usb">{t('settings.printer.typeUsb')}</option>
          <option value="system">{t('settings.printer.typeSystem', 'System Printer')}</option>
        </select>
      </div>

      {/* Connection details based on type */}
      {(formData.type === 'network' || formData.type === 'wifi') && (
        <>
          <div>
            <label className="block text-xs font-medium mb-1 liquid-glass-modal-text-muted">
              {t('settings.printer.networkIp')}
            </label>
            <input
              value={formData.ip}
              onChange={e => setFormData(prev => ({ ...prev, ip: e.target.value }))}
              className="liquid-glass-modal-input"
              placeholder="192.168.1.100"
            />
          </div>
          <div>
            <label className="block text-xs font-medium mb-1 liquid-glass-modal-text-muted">
              {t('settings.printer.networkPort')}
            </label>
            <input
              type="number"
              value={formData.port}
              onChange={e => setFormData(prev => ({ ...prev, port: parseInt(e.target.value) || 9100 }))}
              className="liquid-glass-modal-input"
              placeholder="9100"
            />
          </div>
        </>
      )}

      {formData.type === 'bluetooth' && (
        <>
          <div>
            <label className="block text-xs font-medium mb-1 liquid-glass-modal-text-muted">
              {t('settings.printer.bluetoothAddress')}
            </label>
            <input
              value={formData.bluetoothAddress}
              onChange={e => setFormData(prev => ({ ...prev, bluetoothAddress: e.target.value }))}
              className="liquid-glass-modal-input"
              placeholder="00:11:22:33:44:55"
            />
          </div>
          <div>
            <label className="block text-xs font-medium mb-1 liquid-glass-modal-text-muted">
              {t('settings.printer.bluetoothChannel')}
            </label>
            <input
              type="number"
              value={formData.bluetoothChannel}
              onChange={e => setFormData(prev => ({ ...prev, bluetoothChannel: parseInt(e.target.value) || 1 }))}
              className="liquid-glass-modal-input"
              placeholder="1"
            />
          </div>
        </>
      )}

      {formData.type === 'usb' && (
        <div>
          <label className="block text-xs font-medium mb-1 liquid-glass-modal-text-muted">
            {t('settings.printer.usbPath')}
          </label>
          <input
            value={formData.usbPath}
            onChange={e => setFormData(prev => ({ ...prev, usbPath: e.target.value }))}
            className="liquid-glass-modal-input"
            placeholder={t('settings.printer.usbPathPlaceholder') as string}
          />
        </div>
      )}

      {formData.type === 'system' && (
        <div>
          <label className="block text-xs font-medium mb-1 liquid-glass-modal-text-muted">
            {t('settings.printer.systemName', 'Windows Printer Name')}
          </label>
          <input
            value={formData.systemPrinterName || ''}
            onChange={e => setFormData(prev => ({ ...prev, systemPrinterName: e.target.value }))}
            className="liquid-glass-modal-input"
            placeholder={t('settings.printer.systemNamePlaceholder', 'e.g., POS-58 Printer') as string}
          />
          <p className="text-xs text-gray-400 mt-1">
            {t('settings.printer.systemNameHint', 'Enter the exact printer name as shown in Windows Printers & Scanners')}
          </p>
        </div>
      )}

      {/* Paper Size */}
      <div>
        <label className="block text-xs font-medium mb-1 liquid-glass-modal-text-muted">
          {t('settings.printer.paperSize')}
        </label>
        <select
          value={formData.paperSize}
          onChange={e => setFormData(prev => ({ ...prev, paperSize: e.target.value as PaperSize }))}
          className="liquid-glass-modal-input"
        >
          <option value="58mm">58mm</option>
          <option value="80mm">80mm</option>
          <option value="112mm">112mm</option>
        </select>
      </div>

      {/* Character Set / Code Page */}
      <div>
        <label className="block text-xs font-medium mb-1 liquid-glass-modal-text-muted">
          {t('settings.printer.characterSet', 'Character Set')}
        </label>
        <select
          value={formData.characterSet}
          onChange={e => setFormData(prev => ({ ...prev, characterSet: e.target.value }))}
          className="liquid-glass-modal-input"
        >
          <option value="PC437_USA">PC437 (USA/Standard)</option>
          <option value="CP66_GREEK">CP66 (Chinese/Netum Greek)</option>
          <option value="PC737_GREEK">PC737 (Greek)</option>
          <option value="PC851_GREEK">PC851 (Greek)</option>
          <option value="PC869_GREEK">PC869 (Greek)</option>
          <option value="PC850_MULTILINGUAL">PC850 (Multilingual)</option>
          <option value="PC852_LATIN2">PC852 (Latin 2)</option>
          <option value="PC866_CYRILLIC">PC866 (Cyrillic)</option>
          <option value="PC1252_LATIN1">PC1252 (Latin 1)</option>
          <option value="PC1253_GREEK">PC1253 (Windows Greek)</option>
        </select>
        <p className="text-xs text-gray-400 mt-1">
          {t('settings.printer.characterSetHint', 'Select the character set that matches your printer\'s default code page. For Greek, try PC737 or PC1253.')}
        </p>
      </div>

      {/* Greek Render Mode - only show when Greek character set is selected */}
      {(formData.characterSet.includes('GREEK') || formData.characterSet === 'CP66_GREEK') && (
        <div>
          <label className="block text-xs font-medium mb-1 liquid-glass-modal-text-muted">
            {t('settings.printer.greekRenderMode', 'Greek Rendering Mode')}
          </label>
          <select
            value={formData.greekRenderMode}
            onChange={e => setFormData(prev => ({ ...prev, greekRenderMode: e.target.value as GreekRenderMode }))}
            className="liquid-glass-modal-input"
          >
            <option value="text">{t('settings.printer.greekRenderModeText', 'Text (use printer fonts)')}</option>
            <option value="bitmap">{t('settings.printer.greekRenderModeBitmap', 'Bitmap (render as image)')}</option>
          </select>
          <p className="text-xs text-gray-400 mt-1">
            {t('settings.printer.greekRenderModeHint', 'Use "Text" if your printer has Greek fonts. Use "Bitmap" if Greek characters print as gibberish or squares.')}
          </p>
        </div>
      )}

      {/* Receipt Template - only show for receipt printers */}
      {formData.role === 'receipt' && (
        <div>
          <label className="block text-xs font-medium mb-1 liquid-glass-modal-text-muted">
            {t('settings.printer.receiptTemplate', 'Receipt Template')}
          </label>
          <select
            value={formData.receiptTemplate}
            onChange={e => setFormData(prev => ({ ...prev, receiptTemplate: e.target.value as ReceiptTemplate }))}
            className="liquid-glass-modal-input"
          >
            <option value="classic">{t('settings.printer.receiptTemplateClassic', 'Classic (simple text layout)')}</option>
            <option value="modern">{t('settings.printer.receiptTemplateModern', 'Modern (styled with headers)')}</option>
          </select>
          <p className="text-xs text-gray-400 mt-1">
            {t('settings.printer.receiptTemplateHint', 'Classic: simple text-based layout. Modern: styled layout with pillow-shaped section headers.')}
          </p>
        </div>
      )}

      {/* Role */}
      <div>
        <label className="block text-xs font-medium mb-1 liquid-glass-modal-text-muted">
          {t('settings.printer.role')}
        </label>
        <select
          value={formData.role}
          onChange={e => setFormData(prev => ({ ...prev, role: e.target.value as PrinterRole }))}
          className="liquid-glass-modal-input"
        >
          <option value="receipt">{t('settings.printer.roleReceipt')}</option>
          <option value="kitchen">{t('settings.printer.roleKitchen')}</option>
          <option value="bar">{t('settings.printer.roleBar')}</option>
          <option value="label">{t('settings.printer.roleLabel')}</option>
        </select>
      </div>

      {/* Fallback Printer */}
      {printers.length > 0 && (
        <div>
          <label className="block text-xs font-medium mb-1 liquid-glass-modal-text-muted">
            {t('settings.printer.fallbackPrinter')}
          </label>
          <select
            value={formData.fallbackPrinterId}
            onChange={e => setFormData(prev => ({ ...prev, fallbackPrinterId: e.target.value }))}
            className="liquid-glass-modal-input"
          >
            <option value="">{t('settings.printer.noFallback')}</option>
            {printers
              .filter(p => p.id !== selectedPrinter?.id)
              .map(p => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
          </select>
        </div>
      )}

      {/* Options */}
      <div className="flex gap-4">
        <label className="flex items-center gap-2 cursor-pointer">
          <input
            type="checkbox"
            checked={formData.isDefault}
            onChange={e => setFormData(prev => ({ ...prev, isDefault: e.target.checked }))}
            className="rounded"
          />
          <span className="text-sm liquid-glass-modal-text">{t('settings.printer.setAsDefault')}</span>
        </label>
        <label className="flex items-center gap-2 cursor-pointer">
          <input
            type="checkbox"
            checked={formData.enabled}
            onChange={e => setFormData(prev => ({ ...prev, enabled: e.target.checked }))}
            className="rounded"
          />
          <span className="text-sm liquid-glass-modal-text">{t('settings.printer.enabled')}</span>
        </label>
      </div>

      {/* Actions */}
      <div className="flex gap-2 pt-2">
        <button
          onClick={() => { setViewMode('list'); resetForm() }}
          className={liquidGlassModalButton('secondary', 'md')}
        >
          {t('common.actions.cancel')}
        </button>
        <button
          onClick={handleSave}
          disabled={loading || !formData.name}
          className={liquidGlassModalButton('primary', 'md')}
        >
          {loading ? t('common.actions.saving') : t('common.actions.save')}
        </button>
      </div>
    </div>
  )

  // Get error description for user-friendly display
  const getErrorDescription = (errorCode?: string): string => {
    if (!errorCode) return ''
    const errorDescriptions: Record<string, string> = {
      PAPER_OUT: t('settings.printer.errorPaperOut'),
      COVER_OPEN: t('settings.printer.errorCoverOpen'),
      PAPER_JAM: t('settings.printer.errorPaperJam'),
      CUTTER_ERROR: t('settings.printer.errorCutterError'),
      OVERHEATED: t('settings.printer.errorOverheated'),
      CONNECTION_LOST: t('settings.printer.errorConnectionLost'),
      UNKNOWN: t('settings.printer.errorUnknown'),
    }
    return errorDescriptions[errorCode] || errorCode
  }

  // Render diagnostics view
  const renderDiagnosticsView = () => {
    const printer = diagnostics ? printers.find(p => p.id === diagnostics.printerId) : null
    const status = diagnostics ? statuses[diagnostics.printerId] : null

    return (
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <h3 className="font-medium liquid-glass-modal-text">
            {t('settings.printer.diagnostics')}
            {printer && `: ${printer.name}`}
          </h3>
          {diagnostics && (
            <button
              onClick={() => handleTestPrint(diagnostics.printerId)}
              disabled={loading}
              className={liquidGlassModalButton('primary', 'sm')}
            >
              {t('settings.printer.testPrint')}
            </button>
          )}
        </div>

        {diagnostics ? (
          <div className="space-y-3">
            {/* Current Status */}
            {status && (
              <div className={`p-3 rounded-lg border ${
                status.state === 'online' ? 'bg-green-500/10 border-green-500/30' :
                status.state === 'error' ? 'bg-red-500/10 border-red-500/30' :
                status.state === 'busy' ? 'bg-yellow-500/10 border-yellow-500/30' :
                'bg-gray-500/10 border-gray-500/30'
              }`}>
                <div className="flex items-center gap-2">
                  <StatusIndicator state={status.state} />
                  <span className="font-medium liquid-glass-modal-text">
                    {getStateLabel(status.state)}
                  </span>
                </div>
                {status.errorCode && (
                  <div className="mt-1 text-sm text-red-400">
                    {getErrorDescription(status.errorCode)}
                    {status.errorMessage && `: ${status.errorMessage}`}
                  </div>
                )}
                {status.queueLength > 0 && (
                  <div className="mt-1 text-xs liquid-glass-modal-text-muted">
                    {status.queueLength} {t('settings.printer.jobsInQueue')}
                  </div>
                )}
              </div>
            )}

            {/* Connection Details */}
            <div className="grid grid-cols-2 gap-2 text-sm">
              <div className="liquid-glass-modal-text-muted">{t('settings.printer.connectionType')}:</div>
              <div className="liquid-glass-modal-text">{diagnostics.connectionType.toUpperCase()}</div>

              {diagnostics.connectionLatencyMs !== undefined && (
                <>
                  <div className="liquid-glass-modal-text-muted">{t('settings.printer.latency')}:</div>
                  <div className={`liquid-glass-modal-text ${
                    diagnostics.connectionLatencyMs > 500 ? 'text-yellow-400' :
                    diagnostics.connectionLatencyMs > 1000 ? 'text-red-400' : ''
                  }`}>
                    {diagnostics.connectionLatencyMs}ms
                    {diagnostics.connectionLatencyMs > 500 && ' ⚠️'}
                  </div>
                </>
              )}

              {diagnostics.signalStrength !== undefined && (
                <>
                  <div className="liquid-glass-modal-text-muted">{t('settings.printer.signalStrength')}:</div>
                  <div className={`liquid-glass-modal-text ${
                    diagnostics.signalStrength < 30 ? 'text-red-400' :
                    diagnostics.signalStrength < 60 ? 'text-yellow-400' : ''
                  }`}>
                    {diagnostics.signalStrength}%
                    {diagnostics.signalStrength < 30 && ' ⚠️ ' + t('settings.printer.weakSignal')}
                  </div>
                </>
              )}

              {diagnostics.model && (
                <>
                  <div className="liquid-glass-modal-text-muted">{t('settings.printer.model')}:</div>
                  <div className="liquid-glass-modal-text">{diagnostics.model}</div>
                </>
              )}

              {diagnostics.firmwareVersion && (
                <>
                  <div className="liquid-glass-modal-text-muted">{t('settings.printer.firmware')}:</div>
                  <div className="liquid-glass-modal-text">{diagnostics.firmwareVersion}</div>
                </>
              )}
            </div>

            {/* Recent Jobs Statistics */}
            <div className="border-t border-white/10 pt-3">
              <div className="text-sm font-medium liquid-glass-modal-text mb-2">
                {t('settings.printer.recentJobs')}
              </div>
              <div className="grid grid-cols-3 gap-2 text-center">
                <div className="p-2 rounded bg-white/5">
                  <div className="text-lg font-bold liquid-glass-modal-text">{diagnostics.recentJobs.total}</div>
                  <div className="text-xs liquid-glass-modal-text-muted">{t('settings.printer.total')}</div>
                </div>
                <div className="p-2 rounded bg-green-500/10">
                  <div className="text-lg font-bold text-green-400">{diagnostics.recentJobs.successful}</div>
                  <div className="text-xs liquid-glass-modal-text-muted">{t('settings.printer.successful')}</div>
                </div>
                <div className="p-2 rounded bg-red-500/10">
                  <div className="text-lg font-bold text-red-400">{diagnostics.recentJobs.failed}</div>
                  <div className="text-xs liquid-glass-modal-text-muted">{t('settings.printer.failed')}</div>
                </div>
              </div>
              {/* Success rate */}
              {diagnostics.recentJobs.total > 0 && (
                <div className="mt-2 text-xs text-center liquid-glass-modal-text-muted">
                  {t('settings.printer.successRate')}: {Math.round((diagnostics.recentJobs.successful / diagnostics.recentJobs.total) * 100)}%
                </div>
              )}
            </div>
          </div>
        ) : (
          <div className="text-center py-8 liquid-glass-modal-text-muted">
            {t('settings.printer.noDiagnostics')}
          </div>
        )}

        <button onClick={() => setViewMode('list')} className={liquidGlassModalButton('secondary', 'md')}>
          {t('common.actions.back')}
        </button>
      </div>
    )
  }

  // Render content based on view mode
  const renderContent = () => {
    switch (viewMode) {
      case 'list':
        return renderListView()
      case 'discover':
        return renderDiscoverView()
      case 'add':
      case 'edit':
        return renderFormView()
      case 'diagnostics':
        return renderDiagnosticsView()
      default:
        return renderListView()
    }
  }

  return (
    <LiquidGlassModal
      isOpen={isOpen}
      onClose={onClose}
      title={t('settings.printer.title')}
      size="lg"
      closeOnBackdrop={true}
      closeOnEscape={true}
    >
      <div className="p-6">
        {renderContent()}
      </div>
    </LiquidGlassModal>
  )
}

export default PrinterSettingsModal
