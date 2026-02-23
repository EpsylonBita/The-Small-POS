import React, { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'react-hot-toast'
import { LiquidGlassModal } from '../ui/pos-glass-components'

type ConnectionType = 'bluetooth' | 'serial_usb' | 'network'
type Protocol = 'generic' | 'zvt' | 'pax'

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
}

interface DiscoveredDevice {
  name: string
  deviceType: string
  connectionType: ConnectionType
  connectionDetails: Record<string, unknown>
  manufacturer?: string
  model?: string
}

interface Props {
  isOpen: boolean
  onClose: () => void
  onSave: (device: Omit<ECRDevice, 'id' | 'createdAt' | 'updatedAt'>) => Promise<void>
  device?: ECRDevice // For editing existing device
  discoveredDevice?: DiscoveredDevice // For creating from discovery
}

export const TerminalConfigModal: React.FC<Props> = ({
  isOpen,
  onClose,
  onSave,
  device,
  discoveredDevice,
}) => {
  const { t } = useTranslation()
  const isEdit = !!device

  // Form state
  const [name, setName] = useState('')
  const [connectionType, setConnectionType] = useState<ConnectionType>('serial_usb')
  const [protocol, setProtocol] = useState<Protocol>('generic')
  const [terminalId, setTerminalId] = useState('')
  const [merchantId, setMerchantId] = useState('')
  const [isDefault, setIsDefault] = useState(false)
  const [enabled, setEnabled] = useState(true)

  // Connection details
  const [btAddress, setBtAddress] = useState('')
  const [btChannel, setBtChannel] = useState(1)
  const [serialPort, setSerialPort] = useState('')
  const [baudRate, setBaudRate] = useState(9600)
  const [networkIp, setNetworkIp] = useState('')
  const [networkPort, setNetworkPort] = useState(20007)

  // Settings
  const [transactionTimeout, setTransactionTimeout] = useState(60)
  const [printOnTerminal, setPrintOnTerminal] = useState(true)

  const [isSaving, setIsSaving] = useState(false)

  // Initialize form values
  useEffect(() => {
    if (device) {
      setName(device.name)
      setConnectionType(device.connectionType)
      setProtocol(device.protocol)
      setTerminalId(device.terminalId || '')
      setMerchantId(device.merchantId || '')
      setIsDefault(device.isDefault)
      setEnabled(device.enabled)

      const details = device.connectionDetails
      if (device.connectionType === 'bluetooth') {
        setBtAddress((details.address as string) || '')
        setBtChannel((details.channel as number) || 1)
      } else if (device.connectionType === 'serial_usb') {
        setSerialPort((details.port as string) || '')
        setBaudRate((details.baudRate as number) || 9600)
      } else if (device.connectionType === 'network') {
        setNetworkIp((details.ip as string) || '')
        setNetworkPort((details.port as number) || 20007)
      }

      const settings = device.settings || {}
      setTransactionTimeout(((settings.transactionTimeout as number) || 60000) / 1000)
      setPrintOnTerminal((settings.printOnTerminal as boolean) ?? true)
    } else if (discoveredDevice) {
      setName(discoveredDevice.name || '')
      setConnectionType(discoveredDevice.connectionType)

      const details = discoveredDevice.connectionDetails
      if (discoveredDevice.connectionType === 'bluetooth') {
        setBtAddress((details.address as string) || '')
      } else if (discoveredDevice.connectionType === 'serial_usb') {
        setSerialPort((details.port as string) || '')
      } else if (discoveredDevice.connectionType === 'network') {
        setNetworkIp((details.ip as string) || '')
        setNetworkPort((details.port as number) || 20007)
      }

      // Auto-detect protocol based on manufacturer
      const manufacturer = discoveredDevice.manufacturer?.toLowerCase()
      if (manufacturer?.includes('ingenico') || manufacturer?.includes('verifone')) {
        setProtocol('zvt')
      } else if (manufacturer?.includes('pax')) {
        setProtocol('pax')
      }
    } else {
      // Reset form
      setName('')
      setConnectionType('serial_usb')
      setProtocol('generic')
      setTerminalId('')
      setMerchantId('')
      setIsDefault(false)
      setEnabled(true)
      setBtAddress('')
      setBtChannel(1)
      setSerialPort('')
      setBaudRate(9600)
      setNetworkIp('')
      setNetworkPort(20007)
      setTransactionTimeout(60)
      setPrintOnTerminal(true)
    }
  }, [device, discoveredDevice, isOpen])

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()

    if (!name.trim()) {
      toast.error(t('ecr.config.nameRequired', 'Terminal name is required'))
      return
    }

    // Build connection details
    let connectionDetails: Record<string, unknown> = { type: connectionType }

    if (connectionType === 'bluetooth') {
      if (!btAddress.trim()) {
        toast.error(t('ecr.config.btAddressRequired', 'Bluetooth address is required'))
        return
      }
      connectionDetails = {
        type: 'bluetooth',
        address: btAddress,
        channel: btChannel,
      }
    } else if (connectionType === 'serial_usb') {
      if (!serialPort.trim()) {
        toast.error(t('ecr.config.serialPortRequired', 'Serial port is required'))
        return
      }
      connectionDetails = {
        type: 'serial_usb',
        port: serialPort,
        baudRate,
      }
    } else if (connectionType === 'network') {
      if (!networkIp.trim()) {
        toast.error(t('ecr.config.ipRequired', 'IP address is required'))
        return
      }
      connectionDetails = {
        type: 'network',
        ip: networkIp,
        port: networkPort,
      }
    }

    const deviceConfig: Omit<ECRDevice, 'id' | 'createdAt' | 'updatedAt'> = {
      name: name.trim(),
      deviceType: 'payment_terminal',
      connectionType,
      connectionDetails,
      protocol,
      terminalId: terminalId.trim() || undefined,
      merchantId: merchantId.trim() || undefined,
      isDefault,
      enabled,
      settings: {
        transactionTimeout: transactionTimeout * 1000,
        printOnTerminal,
      },
    }

    setIsSaving(true)
    try {
      await onSave(deviceConfig)
      onClose()
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : t('ecr.config.saveFailed', 'Failed to save terminal')
      )
    } finally {
      setIsSaving(false)
    }
  }

  return (
    <LiquidGlassModal
      isOpen={isOpen}
      onClose={onClose}
      title={
        isEdit
          ? t('ecr.config.editTitle', 'Edit Payment Terminal')
          : t('ecr.config.addTitle', 'Add Payment Terminal')
      }
      size="md"
      className="!max-w-lg"
    >
      <form onSubmit={handleSubmit} className="space-y-6">
        {/* Basic Info */}
        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium liquid-glass-modal-text mb-2">
              {t('ecr.config.name', 'Terminal Name')} *
            </label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t('ecr.config.namePlaceholder', 'e.g., Main Terminal')}
              className="w-full px-4 py-2 rounded-lg bg-white/50 dark:bg-gray-800/50 border border-gray-300 dark:border-gray-600 text-gray-900 dark:text-gray-100 placeholder-gray-400 dark:placeholder-gray-500 focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium liquid-glass-modal-text mb-2">
                {t('ecr.config.connection', 'Connection Type')}
              </label>
              <select
                value={connectionType}
                onChange={(e) => setConnectionType(e.target.value as ConnectionType)}
                className="w-full px-4 py-2 rounded-lg bg-white/50 dark:bg-gray-800/50 border border-gray-300 dark:border-gray-600 text-gray-900 dark:text-gray-100 focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              >
                <option value="serial_usb">USB/Serial</option>
                <option value="bluetooth">Bluetooth</option>
                <option value="network">Network (TCP)</option>
              </select>
            </div>

            <div>
              <label className="block text-sm font-medium liquid-glass-modal-text mb-2">
                {t('ecr.config.protocol', 'Protocol')}
              </label>
              <select
                value={protocol}
                onChange={(e) => setProtocol(e.target.value as Protocol)}
                className="w-full px-4 py-2 rounded-lg bg-white/50 dark:bg-gray-800/50 border border-gray-300 dark:border-gray-600 text-gray-900 dark:text-gray-100 focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              >
                <option value="generic">Generic ECR</option>
                <option value="zvt">ZVT (Ingenico/Verifone)</option>
                <option value="pax">PAX Protocol</option>
              </select>
            </div>
          </div>
        </div>

        {/* Connection Details */}
        <div className="space-y-4 p-4 rounded-lg liquid-glass-modal-card">
          <h3 className="text-sm font-medium liquid-glass-modal-text">
            {t('ecr.config.connectionDetails', 'Connection Details')}
          </h3>

          {connectionType === 'bluetooth' && (
            <div className="grid grid-cols-2 gap-4">
              <div className="col-span-2 sm:col-span-1">
                <label className="block text-sm liquid-glass-modal-text-muted mb-1">
                  {t('ecr.config.btAddress', 'MAC Address')} *
                </label>
                <input
                  type="text"
                  value={btAddress}
                  onChange={(e) => setBtAddress(e.target.value)}
                  placeholder="XX:XX:XX:XX:XX:XX"
                  className="w-full px-4 py-2 rounded-lg bg-white/50 dark:bg-gray-800/50 border border-gray-300 dark:border-gray-600 text-gray-900 dark:text-gray-100 placeholder-gray-400 dark:placeholder-gray-500 focus:ring-2 focus:ring-blue-500 focus:border-transparent font-mono"
                />
              </div>
              <div>
                <label className="block text-sm liquid-glass-modal-text-muted mb-1">
                  {t('ecr.config.btChannel', 'Channel')}
                </label>
                <input
                  type="number"
                  value={btChannel}
                  onChange={(e) => setBtChannel(parseInt(e.target.value) || 1)}
                  min={1}
                  max={30}
                  className="w-full px-4 py-2 rounded-lg bg-white/50 dark:bg-gray-800/50 border border-gray-300 dark:border-gray-600 text-gray-900 dark:text-gray-100 focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                />
              </div>
            </div>
          )}

          {connectionType === 'serial_usb' && (
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm liquid-glass-modal-text-muted mb-1">
                  {t('ecr.config.serialPort', 'COM Port')} *
                </label>
                <input
                  type="text"
                  value={serialPort}
                  onChange={(e) => setSerialPort(e.target.value)}
                  placeholder="COM3"
                  className="w-full px-4 py-2 rounded-lg bg-white/50 dark:bg-gray-800/50 border border-gray-300 dark:border-gray-600 text-gray-900 dark:text-gray-100 placeholder-gray-400 dark:placeholder-gray-500 focus:ring-2 focus:ring-blue-500 focus:border-transparent font-mono"
                />
              </div>
              <div>
                <label className="block text-sm liquid-glass-modal-text-muted mb-1">
                  {t('ecr.config.baudRate', 'Baud Rate')}
                </label>
                <select
                  value={baudRate}
                  onChange={(e) => setBaudRate(parseInt(e.target.value))}
                  className="w-full px-4 py-2 rounded-lg bg-white/50 dark:bg-gray-800/50 border border-gray-300 dark:border-gray-600 text-gray-900 dark:text-gray-100 focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                >
                  <option value={9600}>9600</option>
                  <option value={19200}>19200</option>
                  <option value={38400}>38400</option>
                  <option value={57600}>57600</option>
                  <option value={115200}>115200</option>
                </select>
              </div>
            </div>
          )}

          {connectionType === 'network' && (
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm liquid-glass-modal-text-muted mb-1">
                  {t('ecr.config.ip', 'IP Address')} *
                </label>
                <input
                  type="text"
                  value={networkIp}
                  onChange={(e) => setNetworkIp(e.target.value)}
                  placeholder="192.168.1.100"
                  className="w-full px-4 py-2 rounded-lg bg-white/50 dark:bg-gray-800/50 border border-gray-300 dark:border-gray-600 text-gray-900 dark:text-gray-100 placeholder-gray-400 dark:placeholder-gray-500 focus:ring-2 focus:ring-blue-500 focus:border-transparent font-mono"
                />
              </div>
              <div>
                <label className="block text-sm liquid-glass-modal-text-muted mb-1">
                  {t('ecr.config.port', 'Port')}
                </label>
                <input
                  type="number"
                  value={networkPort}
                  onChange={(e) => setNetworkPort(parseInt(e.target.value) || 20007)}
                  min={1}
                  max={65535}
                  className="w-full px-4 py-2 rounded-lg bg-white/50 dark:bg-gray-800/50 border border-gray-300 dark:border-gray-600 text-gray-900 dark:text-gray-100 focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                />
              </div>
            </div>
          )}
        </div>

        {/* Terminal IDs */}
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium liquid-glass-modal-text mb-2">
              {t('ecr.config.terminalId', 'Terminal ID (TID)')}
            </label>
            <input
              type="text"
              value={terminalId}
              onChange={(e) => setTerminalId(e.target.value)}
              placeholder="12345678"
              className="w-full px-4 py-2 rounded-lg bg-white/50 dark:bg-gray-800/50 border border-gray-300 dark:border-gray-600 text-gray-900 dark:text-gray-100 placeholder-gray-400 dark:placeholder-gray-500 focus:ring-2 focus:ring-blue-500 focus:border-transparent font-mono"
            />
          </div>
          <div>
            <label className="block text-sm font-medium liquid-glass-modal-text mb-2">
              {t('ecr.config.merchantId', 'Merchant ID (MID)')}
            </label>
            <input
              type="text"
              value={merchantId}
              onChange={(e) => setMerchantId(e.target.value)}
              placeholder="123456789012345"
              className="w-full px-4 py-2 rounded-lg bg-white/50 dark:bg-gray-800/50 border border-gray-300 dark:border-gray-600 text-gray-900 dark:text-gray-100 placeholder-gray-400 dark:placeholder-gray-500 focus:ring-2 focus:ring-blue-500 focus:border-transparent font-mono"
            />
          </div>
        </div>

        {/* Settings */}
        <div className="space-y-4 p-4 rounded-lg liquid-glass-modal-card">
          <h3 className="text-sm font-medium liquid-glass-modal-text">
            {t('ecr.config.settings', 'Settings')}
          </h3>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm liquid-glass-modal-text-muted mb-1">
                {t('ecr.config.timeout', 'Transaction Timeout (sec)')}
              </label>
              <input
                type="number"
                value={transactionTimeout}
                onChange={(e) => setTransactionTimeout(parseInt(e.target.value) || 60)}
                min={30}
                max={300}
                className="w-full px-4 py-2 rounded-lg bg-white/50 dark:bg-gray-800/50 border border-gray-300 dark:border-gray-600 text-gray-900 dark:text-gray-100 focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              />
            </div>
          </div>

          <div className="flex items-center gap-3">
            <input
              type="checkbox"
              id="printOnTerminal"
              checked={printOnTerminal}
              onChange={(e) => setPrintOnTerminal(e.target.checked)}
              className="w-4 h-4 rounded border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-blue-500 focus:ring-blue-500"
            />
            <label htmlFor="printOnTerminal" className="text-sm liquid-glass-modal-text">
              {t('ecr.config.printOnTerminal', 'Print receipt on terminal')}
            </label>
          </div>

          <div className="flex items-center gap-3">
            <input
              type="checkbox"
              id="isDefault"
              checked={isDefault}
              onChange={(e) => setIsDefault(e.target.checked)}
              className="w-4 h-4 rounded border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-blue-500 focus:ring-blue-500"
            />
            <label htmlFor="isDefault" className="text-sm liquid-glass-modal-text">
              {t('ecr.config.setDefault', 'Set as default terminal')}
            </label>
          </div>

          <div className="flex items-center gap-3">
            <input
              type="checkbox"
              id="enabled"
              checked={enabled}
              onChange={(e) => setEnabled(e.target.checked)}
              className="w-4 h-4 rounded border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-blue-500 focus:ring-blue-500"
            />
            <label htmlFor="enabled" className="text-sm liquid-glass-modal-text">
              {t('ecr.config.enabled', 'Terminal enabled')}
            </label>
          </div>
        </div>

        {/* Actions */}
        <div className="flex justify-end gap-3 pt-4 border-t liquid-glass-modal-border">
          <button
            type="button"
            onClick={onClose}
            className="px-6 py-2 rounded-lg bg-gray-500/10 hover:bg-gray-500/20 liquid-glass-modal-text font-medium border border-gray-500/20 transition-all"
          >
            {t('common.cancel', 'Cancel')}
          </button>
          <button
            type="submit"
            disabled={isSaving}
            className="px-6 py-2 rounded-lg bg-blue-500/20 hover:bg-blue-500/30 text-blue-600 dark:text-blue-400 font-medium border border-blue-500/30 transition-all disabled:opacity-50"
          >
            {isSaving
              ? t('common.saving', 'Saving...')
              : isEdit
              ? t('common.save', 'Save')
              : t('common.add', 'Add')}
          </button>
        </div>
      </form>
    </LiquidGlassModal>
  )
}
