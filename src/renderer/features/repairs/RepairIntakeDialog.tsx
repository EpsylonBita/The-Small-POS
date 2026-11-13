import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import React, { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Plus, Search, Smartphone, UserRound } from 'lucide-react'

import type { CustomerMessagingPosWorkspace } from '../../../shared/types/customer-messaging'
import { LiquidGlassModal } from '../../components/ui/pos-glass-components'
import {
  CustomerMessagingPreferencePicker,
  type CustomerMessagingPreferenceSelection,
} from '../customer-messaging/CustomerMessagingPreferencePicker'
import { customerMessagingService } from '../customer-messaging/service'
import type {
  RepairCommand,
  RepairCustomerSnapshot,
  RepairDeviceSnapshot,
  RepairPriority,
  RepairSettingsProjection,
} from './contracts'
import type { RepairIntent } from './navigation'
import { validateRepairIntakePolicy, type RepairConnectivity } from './policy'
import { canCreateSecureRepairId, createSecureRepairId } from './secure-id'
import { KitDateField } from '../../components/ui/KitDateField'

export interface RepairDeviceDraft {
  customerId: string
  deviceId: string
  label: string | null
  deviceType: string
  manufacturer: string | null
  model: string | null
  variant: string | null
  storageCapacity: string | null
  color: string | null
}

export interface RepairIntakeSubmission {
  repairId: string
  command: Extract<RepairCommand, { command: 'create_intake' }>
}

export interface RepairIntakeDialogProps {
  isOpen: boolean
  intent: RepairIntent
  settings: RepairSettingsProjection | null
  connectivity: RepairConnectivity
  isSubmitting: boolean
  onClose: () => void
  onSearchCustomers: (search: string) => Promise<RepairCustomerSnapshot[]>
  onLoadDevices: (customerId: string) => Promise<RepairDeviceSnapshot[]>
  onCreateDevice: (draft: RepairDeviceDraft) => Promise<RepairDeviceSnapshot[]>
  onSubmit: (submission: RepairIntakeSubmission) => Promise<void>
}

function nullable(value: string): string | null {
  const trimmed = value.trim()
  return trimmed ? trimmed : null
}

function deviceLabel(device: RepairDeviceSnapshot): string {
  const identity = device.label
    || [device.manufacturer, device.model].filter(Boolean).join(' ')
    || device.deviceType
  return device.serialMasked ? `${identity} · ${device.serialMasked}` : identity
}

function policyMessage(code: string, t: ReturnType<typeof useTranslation>['t']): string {
  if (code === 'REPAIR_SETTINGS_REQUIRED' || code === 'REPAIR_QUICK_SERVICE_DISABLED') {
    return t('repairs.messages.settingsUnavailable')
  }
  if (code === 'REPAIR_STANDARD_DEVICE_REQUIRED' || code === 'REPAIR_STANDARD_CUSTOMER_REQUIRED') {
    return t('repairs.intake.customerRequired')
  }
  if (code === 'REPAIR_QUICK_SERVICE_CUSTOMER_REQUIRED') {
    return t('repairs.intake.quickCustomerRequired')
  }
  return t('repairs.messages.invalidIntake')
}

export function RepairIntakeDialog({
  isOpen,
  intent,
  settings,
  connectivity,
  isSubmitting,
  onClose,
  onSearchCustomers,
  onLoadDevices,
  onCreateDevice,
  onSubmit,
}: RepairIntakeDialogProps) {
  const { t } = useTranslation()
  const reduceMotion = useReducedMotion();
  const revealMotion = {
    initial: reduceMotion ? false as const : { opacity: 0, height: 0, y: 12, overflow: 'hidden' },
    animate: { opacity: 1, height: 'auto', y: 0, overflow: 'visible' },
    exit: reduceMotion ? { opacity: 0 } : { opacity: 0, height: 0, overflow: 'hidden', transition: { overflow: { delay: 0, duration: 0 } } },
    transition: { duration: reduceMotion ? 0 : 0.24, ease: [0.2, 0.8, 0.2, 1] as const, overflow: { delay: reduceMotion ? 0 : 0.24, duration: 0 } },
  };

  const isQuick = intent === 'quick_service'
  const [isAnonymous, setIsAnonymous] = useState(isQuick)
  const [customerQuery, setCustomerQuery] = useState('')
  const [customers, setCustomers] = useState<RepairCustomerSnapshot[]>([])
  const [selectedCustomer, setSelectedCustomer] = useState<RepairCustomerSnapshot | null>(null)
  const [devices, setDevices] = useState<RepairDeviceSnapshot[]>([])
  const [selectedDevice, setSelectedDevice] = useState<RepairDeviceSnapshot | null>(null)
  const [priority, setPriority] = useState<RepairPriority>(settings?.defaultPriority ?? 'normal')
  const [title, setTitle] = useState('')
  const [notes, setNotes] = useState('')
  const [dueAt, setDueAt] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [isLookingUp, setIsLookingUp] = useState(false)
  const [showDeviceForm, setShowDeviceForm] = useState(false)
  const [deviceType, setDeviceType] = useState('phone')
  const [deviceName, setDeviceName] = useState('')
  const [manufacturer, setManufacturer] = useState('')
  const [model, setModel] = useState('')
  const [preferenceWorkspace, setPreferenceWorkspace] = useState<CustomerMessagingPosWorkspace | null>(null)
  const [preferenceBusy, setPreferenceBusy] = useState(false)
  const [preferenceError, setPreferenceError] = useState<string | null>(null)
  const lookupRequest = useRef(0)
  const preferenceRequest = useRef(0)
  const preferenceOperation = useRef<number | null>(null)
  const selectedCustomerId = useRef<string | null>(null)
  const hasSecureUuid = canCreateSecureRepairId()

  useEffect(() => {
    if (!isOpen) return
    setIsAnonymous(isQuick)
    setCustomerQuery('')
    setCustomers([])
    setSelectedCustomer(null)
    selectedCustomerId.current = null
    lookupRequest.current += 1
    setDevices([])
    setSelectedDevice(null)
    setPriority(settings?.defaultPriority ?? 'normal')
    setTitle('')
    setNotes('')
    setDueAt('')
    setError(null)
    setShowDeviceForm(false)
    preferenceRequest.current += 1
    preferenceOperation.current = null
    setPreferenceWorkspace(null)
    setPreferenceBusy(false)
    setPreferenceError(null)
  }, [isOpen, isQuick, settings?.defaultPriority])

  useEffect(() => {
    const customerId = selectedCustomer?.id ?? null
    const requestId = ++preferenceRequest.current
    setPreferenceWorkspace(null)
    setPreferenceError(null)
    if (!isOpen || !customerId || connectivity !== 'online') {
      setPreferenceBusy(false)
      return
    }

    setPreferenceBusy(true)
    void customerMessagingService.history(customerId).then((nextWorkspace) => {
      if (preferenceRequest.current === requestId && selectedCustomerId.current === customerId) {
        setPreferenceWorkspace(nextWorkspace)
      }
    }).catch(() => {
      // An inactive or unavailable optional plugin must not affect repair intake.
    }).finally(() => {
      if (preferenceRequest.current === requestId) setPreferenceBusy(false)
    })
  }, [connectivity, isOpen, selectedCustomer?.id])

  const intakeUnavailable = !settings || (isQuick && !settings.quickServiceEnabled)

  const searchCustomers = async () => {
    const query = customerQuery.trim()
    if (!query || connectivity !== 'online') return
    const requestId = ++lookupRequest.current
    setIsLookingUp(true)
    setError(null)
    try {
      const nextCustomers = await onSearchCustomers(query)
      if (lookupRequest.current === requestId) setCustomers(nextCustomers)
    } catch {
      if (lookupRequest.current === requestId) setError(t('repairs.messages.customerSearchFailed'))
    } finally {
      if (lookupRequest.current === requestId) setIsLookingUp(false)
    }
  }

  const chooseCustomer = async (customer: RepairCustomerSnapshot) => {
    if (connectivity !== 'online') return
    const requestId = ++lookupRequest.current
    selectedCustomerId.current = customer.id
    setSelectedCustomer(customer)
    setSelectedDevice(null)
    setDevices([])
    setIsLookingUp(true)
    setError(null)
    try {
      const nextDevices = await onLoadDevices(customer.id)
      if (lookupRequest.current === requestId && selectedCustomerId.current === customer.id) {
        setDevices(nextDevices)
      }
    } catch {
      if (lookupRequest.current === requestId && selectedCustomerId.current === customer.id) {
        setError(t('repairs.messages.deviceLoadFailed'))
      }
    } finally {
      if (lookupRequest.current === requestId) setIsLookingUp(false)
    }
  }

  const createDevice = async () => {
    if (!selectedCustomer || !deviceType.trim() || connectivity !== 'online') return
    const customerId = selectedCustomer.id
    const requestId = ++lookupRequest.current
    const deviceId = createSecureRepairId()
    if (!deviceId) {
      setError(t('repairs.messages.secureIdUnavailable'))
      return
    }
    setIsLookingUp(true)
    setError(null)
    try {
      const nextDevices = await onCreateDevice({
        customerId,
        deviceId,
        label: nullable(deviceName),
        deviceType: deviceType.trim(),
        manufacturer: nullable(manufacturer),
        model: nullable(model),
        variant: null,
        storageCapacity: null,
        color: null,
      })
      if (lookupRequest.current === requestId && selectedCustomerId.current === customerId) {
        setDevices(nextDevices)
        setSelectedDevice(nextDevices.find((item) => item.id === deviceId) ?? null)
        setShowDeviceForm(false)
      }
    } catch {
      if (lookupRequest.current === requestId && selectedCustomerId.current === customerId) {
        setError(t('repairs.messages.deviceCreateFailed'))
      }
    } finally {
      if (lookupRequest.current === requestId) setIsLookingUp(false)
    }
  }

  const chooseAnonymousMode = () => {
    lookupRequest.current += 1
    selectedCustomerId.current = null
    setIsLookingUp(false)
    setIsAnonymous(true)
    setSelectedCustomer(null)
    setSelectedDevice(null)
    setDevices([])
    setShowDeviceForm(false)
  }

  const choosePreference = async (selection: CustomerMessagingPreferenceSelection) => {
    const customerId = selectedCustomer?.id ?? null
    if (
      !customerId
      || connectivity !== 'online'
      || !preferenceWorkspace?.permissions.link
      || preferenceWorkspace.operationalLocked
      || preferenceOperation.current !== null
    ) return

    const requestId = ++preferenceRequest.current
    preferenceOperation.current = requestId
    setPreferenceBusy(true)
    setPreferenceError(null)
    try {
      await customerMessagingService.preference({ customerId, ...selection })
      const nextWorkspace = await customerMessagingService.history(customerId)
      if (preferenceRequest.current === requestId && selectedCustomerId.current === customerId) {
        setPreferenceWorkspace(nextWorkspace)
      }
    } catch {
      if (preferenceRequest.current === requestId && selectedCustomerId.current === customerId) {
        setPreferenceError('customerMessaging.preferenceFailed')
      }
    } finally {
      if (preferenceOperation.current === requestId) preferenceOperation.current = null
      if (preferenceRequest.current === requestId) setPreferenceBusy(false)
    }
  }

  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!settings) {
      setError(t('repairs.messages.settingsUnavailable'))
      return
    }
    const intake = {
      intakeMode: isQuick ? 'quick_service' as const : 'standard' as const,
      isAnonymous: isQuick && isAnonymous,
      customerId: isQuick && isAnonymous ? null : selectedCustomer?.id ?? null,
      customerDeviceId: isQuick && isAnonymous ? null : selectedDevice?.id ?? null,
    }
    const policy = validateRepairIntakePolicy(
      intake,
      settings ? { quickServiceEnabled: settings.quickServiceEnabled } : null,
    )
    if (!policy.ok) {
      setError(policyMessage(policy.code, t))
      return
    }

    setError(null)
    const repairId = createSecureRepairId()
    if (!repairId) {
      setError(t('repairs.messages.secureIdUnavailable'))
      return
    }
    try {
      await onSubmit({
        repairId,
        command: {
          command: 'create_intake',
          payload: {
            intake_mode: intake.intakeMode,
            is_anonymous: intake.isAnonymous,
            customer_id: intake.customerId,
            customer_device_id: intake.customerDeviceId,
            priority,
          currency: settings.currency,
            title: nullable(title),
            intake_notes: nullable(notes),
            due_at: dueAt ? new Date(dueAt).toISOString() : null,
          },
        },
      })
    } catch {
      setError(t('repairs.messages.commandFailed'))
    }
  }

  return (
    <LiquidGlassModal
      isOpen={isOpen}
      onClose={onClose}
      title={isQuick ? t('repairs.quickService') : t('repairs.newRepair')}
      size="xl"
      className="max-h-[94vh]! [&_.liquid-glass-modal-header]:border-b-0"
      closeDisabled={isSubmitting}
    >
      <form className="space-y-3 p-1 liquid-glass-modal-text" onSubmit={submit}>
        <AnimatePresence initial={false}>{isQuick && (
          <motion.div key="glass-reveal-1" {...revealMotion}><fieldset className="pos-glass-form-card p-3!">
            <legend className="px-1 text-sm font-semibold">{t('repairs.intake.mode')}</legend>
            <div className="mt-2 flex flex-wrap gap-4">
              <label className="flex min-h-11 items-center gap-2">
                <input type="radio" name="quick-customer-mode" checked={isAnonymous} onChange={chooseAnonymousMode} />
                {t('repairs.intake.anonymous')}
              </label>
              <label className="flex min-h-11 items-center gap-2">
                <input type="radio" name="quick-customer-mode" checked={!isAnonymous} onChange={() => setIsAnonymous(false)} />
                {t('repairs.intake.linked')}
              </label>
            </div>
            <AnimatePresence initial={false}>{isAnonymous && <motion.div key="glass-reveal-2" {...revealMotion}><p className="mt-2 text-sm liquid-glass-modal-text-muted">{t('repairs.intake.anonymousHelp')}</p></motion.div>}</AnimatePresence>
          </fieldset></motion.div>
        )}</AnimatePresence>

        <AnimatePresence initial={false}>{intakeUnavailable && (
          <motion.div key="glass-reveal-3" {...revealMotion}><p role="status" className="pos-glass-form-card p-3! text-sm">
            {t('repairs.messages.settingsUnavailable')}
          </p></motion.div>
        )}</AnimatePresence>
        <AnimatePresence initial={false}>{!hasSecureUuid && (
          <motion.div key="glass-reveal-4" {...revealMotion}><p role="alert" className="pos-glass-form-card p-3! text-sm">
            {t('repairs.messages.secureIdUnavailable')}
          </p></motion.div>
        )}</AnimatePresence>

        <AnimatePresence initial={false}>{(!isQuick || !isAnonymous) && (
          <motion.div key="glass-reveal-5" {...revealMotion}><section aria-label={t('repairs.intake.customerDevice')} className="pos-glass-form-card space-y-3">
            <AnimatePresence initial={false}>{connectivity !== 'online' && (
              <motion.div key="glass-reveal-6" {...revealMotion}><p role="status" className="pos-glass-form-card p-3! text-sm">
                {t('repairs.messages.selectorOnline')}
              </p></motion.div>
            )}</AnimatePresence>
            <div>
              <label htmlFor="repair-customer-search" className="text-sm font-semibold liquid-glass-modal-text-muted">{t('repairs.intake.customerSearch')}</label>
              <div className="mt-1 flex gap-2">
                <input
                  id="repair-customer-search"
                  type="search"
                  value={customerQuery}
                  onChange={(event) => setCustomerQuery(event.target.value)}
                  disabled={connectivity !== 'online'}
                  className="min-h-11 min-w-0 flex-1 pos-glass-field px-3"
                />
                <button type="button" onClick={() => void searchCustomers()} disabled={connectivity !== 'online' || isLookingUp || !customerQuery.trim()} className="pos-glass-field inline-flex min-h-11 items-center gap-2 px-4 font-semibold disabled:opacity-50">
                  <Search aria-hidden className="h-4 w-4" />
                  {t('repairs.intake.searchCustomers')}
                </button>
              </div>
            </div>

            <AnimatePresence initial={false}>{customers.length > 0 && (
              <motion.div key="glass-reveal-7" {...revealMotion}><ul aria-label={t('repairs.intake.customerResults')} className="grid gap-2 sm:grid-cols-2">
                {customers.map((customer) => (
                  <li key={customer.id}>
                    <button type="button" disabled={connectivity !== 'online'} aria-pressed={selectedCustomer?.id === customer.id} onClick={() => void chooseCustomer(customer)} className="pos-glass-tap-card flex min-h-11 w-full items-center gap-2 p-3 text-left aria-pressed:border-(--pos-s-sel-bg) aria-pressed:bg-(--pos-s-sel-bg) aria-pressed:text-(--pos-s-sel-fg) disabled:opacity-50">
                      <UserRound aria-hidden className="h-4 w-4" />
                      {customer.displayName}
                    </button>
                  </li>
                ))}
              </ul></motion.div>
            )}</AnimatePresence>

            <AnimatePresence initial={false}>{selectedCustomer && (
              <motion.div key="glass-reveal-8" {...revealMotion}><div className="space-y-3">
                <div className="flex items-center justify-between gap-3">
                  <h3 className="text-sm font-semibold liquid-glass-modal-text-muted">{t('repairs.fields.device')}</h3>
                  <button type="button" disabled={connectivity !== 'online'} onClick={() => setShowDeviceForm((value) => !value)} className="pos-glass-field inline-flex min-h-11 items-center gap-2 px-3 text-sm font-semibold disabled:opacity-50">
                    <Plus aria-hidden className="h-4 w-4" />
                    {t('repairs.intake.newDevice')}
                  </button>
                </div>
                <AnimatePresence initial={false}>{devices.length > 0 && (
                  <motion.div key="glass-reveal-9" {...revealMotion}><ul aria-label={t('repairs.intake.deviceResults')} className="grid gap-2 sm:grid-cols-2">
                    {devices.map((item) => (
                      <li key={item.id}>
                        <button type="button" disabled={connectivity !== 'online'} aria-pressed={selectedDevice?.id === item.id} onClick={() => setSelectedDevice(item)} className="pos-glass-tap-card flex min-h-11 w-full items-center gap-2 p-3 text-left aria-pressed:border-(--pos-s-sel-bg) aria-pressed:bg-(--pos-s-sel-bg) aria-pressed:text-(--pos-s-sel-fg) disabled:opacity-50">
                          <Smartphone aria-hidden className="h-4 w-4" />
                          {deviceLabel(item)}
                        </button>
                      </li>
                    ))}
                  </ul></motion.div>
                )}</AnimatePresence>
                <AnimatePresence initial={false}>{showDeviceForm && (
                  <motion.div key="glass-reveal-10" {...revealMotion}><div className="pos-glass-form-card grid gap-3 p-3! sm:grid-cols-2">
                    <label className="text-sm font-semibold liquid-glass-modal-text-muted">{t('repairs.intake.deviceType')}<input required value={deviceType} onChange={(event) => setDeviceType(event.target.value)} className="mt-1 min-h-11 w-full pos-glass-field px-3" /></label>
                    <label className="text-sm font-semibold liquid-glass-modal-text-muted">{t('repairs.intake.deviceLabel')}<input value={deviceName} onChange={(event) => setDeviceName(event.target.value)} className="mt-1 min-h-11 w-full pos-glass-field px-3" /></label>
                    <label className="text-sm font-semibold liquid-glass-modal-text-muted">{t('repairs.intake.manufacturer')}<input value={manufacturer} onChange={(event) => setManufacturer(event.target.value)} className="mt-1 min-h-11 w-full pos-glass-field px-3" /></label>
                    <label className="text-sm font-semibold liquid-glass-modal-text-muted">{t('repairs.intake.model')}<input value={model} onChange={(event) => setModel(event.target.value)} className="mt-1 min-h-11 w-full pos-glass-field px-3" /></label>
                    <button type="button" onClick={() => void createDevice()} disabled={connectivity !== 'online' || isLookingUp || !deviceType.trim() || !hasSecureUuid} className="pos-glass-field min-h-11 px-4 font-semibold disabled:opacity-50 sm:col-span-2">{t('repairs.intake.saveDevice')}</button>
                  </div></motion.div>
                )}</AnimatePresence>
              </div></motion.div>
            )}</AnimatePresence>
          </section></motion.div>
        )}</AnimatePresence>

        <AnimatePresence initial={false}>{selectedCustomer && connectivity === 'online' && (
          <motion.div key="glass-reveal-11" {...revealMotion}><section className="pos-glass-form-card space-y-2" aria-label={t('customerMessaging.preferenceTitle')}>
            <AnimatePresence initial={false}>{preferenceError && (
              <motion.div key="glass-reveal-12" {...revealMotion}><p role={preferenceError === 'customerMessaging.preferenceFailed' ? 'alert' : 'status'}
                className="pos-glass-form-card p-3! text-sm">
                {t(preferenceError)}
              </p></motion.div>
            )}</AnimatePresence>
            {preferenceWorkspace && (
              <CustomerMessagingPreferencePicker workspace={preferenceWorkspace} busy={preferenceBusy}
                onSelect={(selection) => void choosePreference(selection)} />
            )}
          </section></motion.div>
        )}</AnimatePresence>

        <div className="pos-glass-form-card grid gap-3 sm:grid-cols-2">
          <label className="text-sm font-semibold liquid-glass-modal-text-muted">{t('repairs.intake.title')}<input value={title} onChange={(event) => setTitle(event.target.value)} className="mt-1 min-h-11 w-full pos-glass-field px-3" /></label>
          <label className="text-sm font-semibold liquid-glass-modal-text-muted">{t('repairs.filters.priority')}<select value={priority} onChange={(event) => setPriority(event.target.value as RepairPriority)} className="mt-1 min-h-11 w-full pos-glass-field px-3">{(['low', 'normal', 'high', 'urgent'] as RepairPriority[]).map((item) => <option key={item} value={item}>{t(`repairs.priority.${item}`)}</option>)}</select></label>
          <label className="text-sm font-semibold liquid-glass-modal-text-muted">{t('repairs.fields.dueAt')}<KitDateField type="datetime-local" value={dueAt} onChange={(event) => setDueAt(event.target.value)} className="mt-1 min-h-11 w-full pos-glass-field px-3" /></label>
          <label className="text-sm font-semibold liquid-glass-modal-text-muted sm:col-span-2">{t('repairs.fields.intakeNotes')}<textarea value={notes} onChange={(event) => setNotes(event.target.value)} rows={3} maxLength={5000} className="mt-1 min-h-11 w-full pos-glass-field p-3" /></label>
        </div>

        <AnimatePresence initial={false}>{error && <motion.div key="glass-reveal-13" {...revealMotion}><p role="alert" className="rounded-xl border border-(--pos-s-bad) bg-(--pos-s-bad-bg) p-3 text-sm text-red-800 dark:text-red-200">{error}</p></motion.div>}</AnimatePresence>

        <div className="flex flex-wrap justify-end gap-2 px-6 pb-5 pt-2">
          <AnimatePresence initial={false}>{isSubmitting && <motion.div key="glass-reveal-14" {...revealMotion}><p id="repair-intake-submit-reason" role="status" className="w-full text-right text-xs liquid-glass-modal-text-muted">{t('repairs.messages.submitInProgress')}</p></motion.div>}</AnimatePresence>
          <button type="button" disabled={isSubmitting} aria-describedby={isSubmitting ? 'repair-intake-submit-reason' : undefined} onClick={onClose} className="liquid-glass-modal-button min-h-11 px-4 font-semibold disabled:opacity-50">{t('repairs.actions.close')}</button>
          <button type="submit" disabled={isSubmitting || intakeUnavailable || !hasSecureUuid} className="liquid-glass-modal-button pos-modal-primary min-h-11 px-4 font-semibold disabled:opacity-50">{t('repairs.actions.create')}</button>
        </div>
      </form>
    </LiquidGlassModal>
  )
}
