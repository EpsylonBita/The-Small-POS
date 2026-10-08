import React, { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'react-hot-toast'
import { LiquidGlassModal, POSGlassSwitch } from '../ui/pos-glass-components'
import {
  type EcrDeviceType,
  ecrTypeRequiredMessage,
  hasFiscalCashRegisterIdentity,
  resolveEcrDeviceType,
} from '../../utils/ecr-device-type'

type ConnectionType = 'bluetooth' | 'serial_usb' | 'network'
type Protocol = 'generic' | 'zvt' | 'pax'

interface ECRDevice {
  id: string
  name: string
  deviceType: string
  brand?: string
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
  isConfigured?: boolean
  isSupported?: boolean
  unsupportedReason?: string
  discoverySource?: string
}

interface Props {
  isOpen: boolean
  onClose: () => void
  onSave: (device: Omit<ECRDevice, 'id' | 'createdAt' | 'updatedAt'>) => Promise<void>
  device?: ECRDevice // For editing existing device
  discoveredDevice?: DiscoveredDevice // For creating from discovery
  /** Opens Settings > Cash Register / Fiscal Printer (a fiscal register is never saved here). */
  onOpenCashRegisterSetup?: () => void
  /**
   * Shown while "enabled" is on and the card terminal is not admitted (no active,
   * configured payment plugin for this store). The parent also refuses the save.
   */
  notAdmittedNotice?: string
}

// Round 295: the print-on-terminal / default / enabled switches use the shared POSGlassSwitch (one
// fixed-geometry green-on/neutral-off glass switch), so they match every other Settings switch. The
// previous local switch-track class was removed.

export const TerminalConfigModal: React.FC<Props> = ({
  isOpen,
  onClose,
  onSave,
  device,
  discoveredDevice,
  onOpenCashRegisterSetup,
  notAdmittedNotice,
}) => {
  const { t } = useTranslation()
  const isEdit = !!device

  // Form state
  const [name, setName] = useState('')
  const [connectionType, setConnectionType] = useState<ConnectionType>('serial_usb')
  const [protocol, setProtocol] = useState<Protocol>('zvt')
  const [terminalId, setTerminalId] = useState('')
  const [merchantId, setMerchantId] = useState('')
  const [isDefault, setIsDefault] = useState(false)
  const [enabled, setEnabled] = useState(true)
  // Founder rule 08/10/2026: the device type is never defaulted silently. A new
  // or unknown device needs an explicit choice; RBS / ELIO is a fiscal register.
  const [deviceType, setDeviceType] = useState<EcrDeviceType | null>(null)

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
  const showLegacyGenericOption = device?.protocol === 'generic' || protocol === 'generic'
  const bluetoothUnavailable = connectionType === 'bluetooth'
  const bluetoothUnavailableMessage = t(
    'ecr.bluetoothUnavailable',
    'Bluetooth payment terminals are not available in this version. Use USB/Serial or Network (TCP).'
  )

  // A fiscal identity in the typed name, the stored brand or the discovered
  // manufacturer/model always wins: such a device is never a card terminal.
  const identityIsFiscal = hasFiscalCashRegisterIdentity({
    name,
    brand: device?.brand,
    manufacturer: discoveredDevice?.manufacturer,
    model: discoveredDevice?.model,
  })
  const effectiveDeviceType: EcrDeviceType | null = identityIsFiscal ? 'cash_register' : deviceType
  const fiscalRegisterMessage = t('ecr.admission.fiscalNotCardTerminal', {
    defaultValue:
      'A fiscal cash register (such as RBS or ELIO) is not a card terminal. Set it up under Cash Register / Fiscal Printer.',
  })
  const typeRequiredMessage = ecrTypeRequiredMessage(t)

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
      setDeviceType(resolveEcrDeviceType(device))

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
      setDeviceType(resolveEcrDeviceType(discoveredDevice))

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
      } else {
        setProtocol('zvt')
      }
    } else {
      // Reset form
      setName('')
      setConnectionType('serial_usb')
      setProtocol('zvt')
      setTerminalId('')
      setMerchantId('')
      setIsDefault(false)
      setEnabled(true)
      setDeviceType(null)
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

    if (bluetoothUnavailable) {
      toast.error(bluetoothUnavailableMessage)
      return
    }

    if (effectiveDeviceType === null) {
      toast.error(typeRequiredMessage)
      return
    }
    if (effectiveDeviceType !== 'payment_terminal') {
      toast.error(fiscalRegisterMessage)
      return
    }

    if (!name.trim()) {
      toast.error(t('ecr.config.nameRequired', 'Terminal name is required'))
      return
    }

    // Build connection details
    let connectionDetails: Record<string, unknown> = { type: connectionType }

    if (connectionType === 'serial_usb') {
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
      deviceType: effectiveDeviceType,
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

  // Round 352: the primary action stays disabled until the required VISIBLE fields are filled -- the terminal
  // name plus the connection field for the CURRENT connection type -- so a touchscreen cashier can't tap Add
  // into a toast error. handleSubmit keeps its validation/toasts as a safety fallback.
  const requiredConnectionField =
    connectionType === 'bluetooth'
      ? btAddress
      : connectionType === 'serial_usb'
        ? serialPort
        : networkIp
  const requiredFieldsComplete = name.trim().length > 0 && requiredConnectionField.trim().length > 0
  const deviceTypeBlocked = effectiveDeviceType !== 'payment_terminal'
  const showNotAdmittedNotice =
    Boolean(notAdmittedNotice) &&
    enabled &&
    effectiveDeviceType === 'payment_terminal' &&
    (!device || !device.enabled || device.deviceType !== 'payment_terminal')

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
      footer={
        <div className="px-8 py-4 border-t liquid-glass-modal-border bg-white/85 dark:bg-black/55 backdrop-blur-xl shadow-[0_-8px_24px_rgba(0,0,0,0.18)]">
          {/* Round 352: a calm inline hint (amber, on-palette) explains what is missing while Add is disabled.
              Only shown when required fields are incomplete and not saving, so the footer never feels crowded. */}
          {bluetoothUnavailable && (
            <p role="status" className="mb-2 text-xs font-medium text-amber-700 dark:text-amber-300">
              {bluetoothUnavailableMessage}
            </p>
          )}
          {!bluetoothUnavailable && effectiveDeviceType === null && !isSaving && (
            <p role="status" className="mb-2 text-xs font-medium text-amber-700 dark:text-amber-300">
              {typeRequiredMessage}
            </p>
          )}
          {!bluetoothUnavailable && !deviceTypeBlocked && !requiredFieldsComplete && !isSaving && (
            <p
              data-terminal-required-hint
              className="mb-2 text-xs font-medium text-amber-700 dark:text-amber-300"
            >
              {t('ecr.config.missingRequired', 'Enter the terminal name and connection details to enable Add.')}
            </p>
          )}
          <div className="flex justify-end gap-3">
            <button
              type="button"
              onClick={onClose}
              className="inline-flex items-center justify-center px-6 py-2 rounded-xl bg-red-500/10 active:bg-red-500/20 text-red-600 dark:text-red-300 font-medium border border-red-500/40 transition-colors active:scale-[0.98]"
            >
              {t('common.actions.cancel', 'Cancel')}
            </button>
            <button
              type="submit"
              form="terminal-config-form"
              disabled={isSaving || bluetoothUnavailable || deviceTypeBlocked || !requiredFieldsComplete}
              className="inline-flex items-center justify-center px-6 py-2 rounded-xl bg-green-600 active:bg-green-700 text-white font-medium border border-green-600 shadow-sm shadow-green-600/25 transition-colors active:scale-[0.98] disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {isSaving
                ? t('common.actions.saving', 'Saving...')
                : isEdit
                ? t('common.actions.save', 'Save')
                : t('common.actions.add', 'Add')}
            </button>
          </div>
        </div>
      }
    >
      {/* Bottom padding clears the pinned footer so the last fields stay reachable. */}
      <form id="terminal-config-form" onSubmit={handleSubmit} className="space-y-4 pb-28">
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
              className="w-full px-4 py-2 rounded-xl bg-white/50 dark:bg-gray-800/50 border border-gray-300 dark:border-gray-600 text-gray-900 dark:text-gray-100 placeholder-gray-400 dark:placeholder-gray-500 focus:ring-2 focus:ring-amber-500 focus:border-transparent"
            />
          </div>

          <div>
            <span
              id="terminal-config-device-type"
              className="block text-sm font-medium liquid-glass-modal-text mb-2"
            >
              {t('settings.peripherals.cashRegister.deviceType', 'Device Type')} *
            </span>
            <div
              role="radiogroup"
              aria-labelledby="terminal-config-device-type"
              className="grid grid-cols-2 gap-2"
            >
              {(['payment_terminal', 'cash_register'] as const).map((option) => {
                const selected = effectiveDeviceType === option
                return (
                  <button
                    key={option}
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    disabled={option === 'payment_terminal' && identityIsFiscal}
                    onClick={() => setDeviceType(option)}
                    className={`min-h-[44px] rounded-xl border px-3 py-2 text-sm font-medium transition-all active:scale-[0.98] disabled:opacity-50 ${
                      selected
                        ? 'border-green-600 bg-green-600/15 text-green-800 dark:text-green-200'
                        : 'liquid-glass-modal-border bg-white/5 liquid-glass-modal-text'
                    }`}
                  >
                    {option === 'payment_terminal'
                      ? t('settings.peripherals.cashRegister.paymentTerminal', 'Payment Terminal')
                      : t('settings.peripherals.cashRegister.cashRegister', 'Fiscal Cash Register')}
                  </button>
                )
              })}
            </div>
            {effectiveDeviceType === 'cash_register' && (
              <div
                role="alert"
                className="mt-2 space-y-2 rounded-xl border border-amber-500/40 bg-amber-500/10 p-3 text-xs text-amber-800 dark:text-amber-200"
              >
                <p>{fiscalRegisterMessage}</p>
                {onOpenCashRegisterSetup && (
                  <button
                    type="button"
                    onClick={onOpenCashRegisterSetup}
                    className="inline-flex min-h-[36px] items-center rounded-lg border border-amber-500/40 bg-amber-500/15 px-3 font-medium active:bg-amber-500/25"
                  >
                    {t('ecr.discovery.configureCashRegister', 'Configure Cash Register')}
                  </button>
                )}
              </div>
            )}
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium liquid-glass-modal-text mb-2">
                {t('ecr.config.connection', 'Connection Type')}
              </label>
              <select
                value={connectionType}
                onChange={(e) => setConnectionType(e.target.value as ConnectionType)}
                className="w-full px-4 py-2 rounded-xl bg-white/50 dark:bg-gray-800/50 border border-gray-300 dark:border-gray-600 text-gray-900 dark:text-gray-100 focus:ring-2 focus:ring-amber-500 focus:border-transparent"
              >
                <option value="serial_usb">USB/Serial</option>
                <option value="bluetooth" disabled>{t('ecr.bluetoothUnavailableOption', 'Bluetooth (unavailable)')}</option>
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
                className="w-full px-4 py-2 rounded-xl bg-white/50 dark:bg-gray-800/50 border border-gray-300 dark:border-gray-600 text-gray-900 dark:text-gray-100 focus:ring-2 focus:ring-amber-500 focus:border-transparent"
              >
                {showLegacyGenericOption && (
                  <option value="generic">
                    {t('ecr.config.legacyGeneric', 'Generic ECR (legacy)')}
                  </option>
                )}
                <option value="zvt">ZVT (Ingenico/Verifone)</option>
                <option value="pax">PAX Protocol</option>
              </select>
            </div>
          </div>
        </div>

        {/* Connection Details */}
        <div className="space-y-4 p-4 rounded-2xl border border-black/10 dark:border-white/10 bg-white/40 dark:bg-white/5 backdrop-blur-sm">
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
                  className="w-full px-4 py-2 rounded-xl bg-white/50 dark:bg-gray-800/50 border border-gray-300 dark:border-gray-600 text-gray-900 dark:text-gray-100 placeholder-gray-400 dark:placeholder-gray-500 focus:ring-2 focus:ring-amber-500 focus:border-transparent font-mono"
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
                  className="w-full px-4 py-2 rounded-xl bg-white/50 dark:bg-gray-800/50 border border-gray-300 dark:border-gray-600 text-gray-900 dark:text-gray-100 focus:ring-2 focus:ring-amber-500 focus:border-transparent"
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
                  className="w-full px-4 py-2 rounded-xl bg-white/50 dark:bg-gray-800/50 border border-gray-300 dark:border-gray-600 text-gray-900 dark:text-gray-100 placeholder-gray-400 dark:placeholder-gray-500 focus:ring-2 focus:ring-amber-500 focus:border-transparent font-mono"
                />
              </div>
              <div>
                <label className="block text-sm liquid-glass-modal-text-muted mb-1">
                  {t('ecr.config.baudRate', 'Baud Rate')}
                </label>
                <select
                  value={baudRate}
                  onChange={(e) => setBaudRate(parseInt(e.target.value))}
                  className="w-full px-4 py-2 rounded-xl bg-white/50 dark:bg-gray-800/50 border border-gray-300 dark:border-gray-600 text-gray-900 dark:text-gray-100 focus:ring-2 focus:ring-amber-500 focus:border-transparent"
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
                  className="w-full px-4 py-2 rounded-xl bg-white/50 dark:bg-gray-800/50 border border-gray-300 dark:border-gray-600 text-gray-900 dark:text-gray-100 placeholder-gray-400 dark:placeholder-gray-500 focus:ring-2 focus:ring-amber-500 focus:border-transparent font-mono"
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
                  className="w-full px-4 py-2 rounded-xl bg-white/50 dark:bg-gray-800/50 border border-gray-300 dark:border-gray-600 text-gray-900 dark:text-gray-100 focus:ring-2 focus:ring-amber-500 focus:border-transparent"
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
              className="w-full px-4 py-2 rounded-xl bg-white/50 dark:bg-gray-800/50 border border-gray-300 dark:border-gray-600 text-gray-900 dark:text-gray-100 placeholder-gray-400 dark:placeholder-gray-500 focus:ring-2 focus:ring-amber-500 focus:border-transparent font-mono"
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
              className="w-full px-4 py-2 rounded-xl bg-white/50 dark:bg-gray-800/50 border border-gray-300 dark:border-gray-600 text-gray-900 dark:text-gray-100 placeholder-gray-400 dark:placeholder-gray-500 focus:ring-2 focus:ring-amber-500 focus:border-transparent font-mono"
            />
          </div>
        </div>

        {/* Settings */}
        <div className="space-y-4 p-4 rounded-2xl border border-black/10 dark:border-white/10 bg-white/40 dark:bg-white/5 backdrop-blur-sm">
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
                className="w-full px-4 py-2 rounded-xl bg-white/50 dark:bg-gray-800/50 border border-gray-300 dark:border-gray-600 text-gray-900 dark:text-gray-100 focus:ring-2 focus:ring-amber-500 focus:border-transparent"
              />
            </div>
          </div>

          <div className="flex min-h-[44px] items-center justify-between gap-3 rounded-xl border liquid-glass-modal-border bg-white/5 px-3 py-2">
            <span className="text-sm liquid-glass-modal-text">
              {t('ecr.config.printOnTerminal', 'Print receipt on terminal')}
            </span>
            <POSGlassSwitch
              id="printOnTerminal"
              checked={printOnTerminal}
              onChange={setPrintOnTerminal}
              aria-label={t('ecr.config.printOnTerminal', 'Print receipt on terminal')}
            />
          </div>

          <div className="flex min-h-[44px] items-center justify-between gap-3 rounded-xl border liquid-glass-modal-border bg-white/5 px-3 py-2">
            <span className="text-sm liquid-glass-modal-text">
              {t('ecr.config.setDefault', 'Set as default terminal')}
            </span>
            <POSGlassSwitch
              id="isDefault"
              checked={isDefault}
              onChange={setIsDefault}
              aria-label={t('ecr.config.setDefault', 'Set as default terminal')}
            />
          </div>

          <div className="flex min-h-[44px] items-center justify-between gap-3 rounded-xl border liquid-glass-modal-border bg-white/5 px-3 py-2">
            <span className="text-sm liquid-glass-modal-text">
              {t('ecr.config.enabled', 'Terminal enabled')}
            </span>
            <POSGlassSwitch
              id="enabled"
              checked={enabled}
              onChange={setEnabled}
              aria-label={t('ecr.config.enabled', 'Terminal enabled')}
            />
          </div>
          {showNotAdmittedNotice && (
            <p role="status" className="text-xs font-medium text-amber-700 dark:text-amber-300">
              {notAdmittedNotice}
            </p>
          )}
        </div>

      </form>
    </LiquidGlassModal>
  )
}
