import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { CallerIdCustomerSearchRequest } from '../../hooks/useCallerIdNotifications'
import { useAcquiredModules } from '../../hooks/useAcquiredModules'
import {
  enqueueCallerIdOrderIntent,
  type CallerIdOrderCustomer,
  type CallerIdRequestedOrderType,
} from '../../services/caller-id-order-flow'
import { normalizeCallerIdSearchPhone } from '../../services/caller-id-customer-search'
import { AddCustomerModal } from '../modals/AddCustomerModal'
import { CustomerSearchModal } from '../modals/CustomerSearchModal'
import { CallerIdMinimizedPanel } from './CallerIdMinimizedPanel'

interface CallerIdCustomerSearchModalHostProps {
  request: CallerIdCustomerSearchRequest | null
  onClose: () => void
  /** Optional observer used by embedded hosts/tests; the dashboard handoff remains automatic. */
  onContinueToOrderType?: (customer: CallerIdOrderCustomer | null) => void
}

/**
 * Remounts the glass modal for each queued call. The modal owns a close
 * animation state, so reusing the same instance while `isOpen` remains true
 * would leave the next queued lookup unmounted after the previous one closes.
 */
export function CallerIdCustomerSearchModalHost({
  request,
  onClose,
  onContinueToOrderType,
}: CallerIdCustomerSearchModalHostProps) {
  const { t } = useTranslation()
  const [addCustomerPhone, setAddCustomerPhone] = useState<string | null>(null)
  const [addAddressCustomer, setAddAddressCustomer] = useState<CallerIdOrderCustomer | null>(null)
  const [addedCustomer, setAddedCustomer] = useState<CallerIdOrderCustomer | null>(null)
  const [isMinimized, setIsMinimized] = useState(false)
  const addAddressGenerationRef = useRef(0)
  const activeAddAddressSessionRef = useRef<{
    generation: number
    requestKey: string
    customerId: string
  } | null>(null)
  const {
    hasDeliveryModule,
    hasTablesModule,
    hasRoomsModule,
    hasAppointmentsModule,
    hasServiceCatalogModule,
  } = useAcquiredModules()

  const enabledOrderTypes = useMemo<CallerIdRequestedOrderType[]>(() => {
    const types: CallerIdRequestedOrderType[] = []
    if (hasDeliveryModule) types.push('delivery')
    types.push('pickup')
    if (hasTablesModule) types.push('dine-in')
    if (hasRoomsModule) types.push('room')
    if (hasAppointmentsModule || hasServiceCatalogModule) types.push('service')
    return types
  }, [
    hasAppointmentsModule,
    hasDeliveryModule,
    hasRoomsModule,
    hasServiceCatalogModule,
    hasTablesModule,
  ])

  const invalidateAddAddressSession = useCallback(() => {
    addAddressGenerationRef.current += 1
    activeAddAddressSessionRef.current = null
  }, [])

  const openAddAddressSession = useCallback((customer: CallerIdOrderCustomer) => {
    if (!request) return
    const generation = addAddressGenerationRef.current + 1
    addAddressGenerationRef.current = generation
    activeAddAddressSessionRef.current = {
      generation,
      requestKey: request.requestKey,
      customerId: String(customer.id),
    }
    setAddAddressCustomer(customer)
  }, [request])

  useEffect(() => {
    invalidateAddAddressSession()
    setAddCustomerPhone(null)
    setAddAddressCustomer(null)
    setAddedCustomer(null)
    setIsMinimized(false)
  }, [invalidateAddAddressSession, request?.requestKey])

  useEffect(() => () => invalidateAddAddressSession(), [invalidateAddAddressSession])

  const finishCallerIdLookup = useCallback((
    customer: CallerIdOrderCustomer | null,
    visiblePhone = request?.displayPhone ?? '',
    canonicalPhoneOverride?: string,
    requestedOrderType?: CallerIdRequestedOrderType,
  ) => {
    if (!request) return

    const displayPhone = visiblePhone.trim() || request.displayPhone
    const canonicalPhone =
      canonicalPhoneOverride?.trim() ||
      (displayPhone === request.displayPhone
        ? request.canonicalPhone || request.displayPhone
        : displayPhone)
    onContinueToOrderType?.(customer)
    enqueueCallerIdOrderIntent({
      requestKey: request.requestKey,
      displayPhone,
      canonicalPhone,
      lookupPhone:
        displayPhone === request.displayPhone
          ? request.lookupPhone
          : normalizeCallerIdSearchPhone(displayPhone),
      customer,
      requestedOrderType,
    })
    window.dispatchEvent(
      new CustomEvent('pos:navigate-view', {
        detail: { view: 'dashboard' },
      }),
    )
    setAddCustomerPhone(null)
    setAddAddressCustomer(null)
    setAddedCustomer(null)
    setIsMinimized(false)
    onClose()
  }, [onClose, onContinueToOrderType, request])

  const closeCurrentLookup = useCallback(() => {
    invalidateAddAddressSession()
    setAddCustomerPhone(null)
    setAddAddressCustomer(null)
    setAddedCustomer(null)
    setIsMinimized(false)
    onClose()
  }, [invalidateAddAddressSession, onClose])

  const renderedAddAddressSession = activeAddAddressSessionRef.current

  return (
    <>
      <CustomerSearchModal
        key={request?.requestKey ?? 'caller-id-search-closed'}
        isOpen={Boolean(request) && addCustomerPhone === null && addAddressCustomer === null}
        lookupOnly
        initialCustomer={addedCustomer as never}
        initialSearchTerm={request?.displayPhone ?? ''}
        initialLookupTerm={request?.lookupPhone ?? ''}
        searchRequestKey={request?.requestKey}
        onDisplayed={request?.onDisplayed}
        onCustomerSelected={(customer) =>
          finishCallerIdLookup(
            customer as unknown as CallerIdOrderCustomer,
            request?.displayPhone,
          )
        }
        onAddNewCustomer={(phone) =>
          setAddCustomerPhone(
            !request
              ? phone
              : !phone || phone === request.displayPhone
                ? request.canonicalPhone || request.displayPhone
                : phone,
          )
        }
        onAddNewAddress={hasDeliveryModule
          ? (customer) => openAddAddressSession(customer as unknown as CallerIdOrderCustomer)
          : undefined}
        onContinueWithoutCustomer={(phone) =>
          finishCallerIdLookup(null, phone)
        }
        callerIdWorkspace={request ? {
          minimized: isMinimized,
          enabledOrderTypes,
          onMinimize: () => setIsMinimized(true),
          onOrderTypeSelected: (orderType, customer, phone) =>
            finishCallerIdLookup(
              customer as unknown as CallerIdOrderCustomer | null,
              phone,
              undefined,
              orderType,
            ),
        } : undefined}
        onClose={closeCurrentLookup}
      />

      {request && (addCustomerPhone !== null || addAddressCustomer !== null) && (
        <AddCustomerModal
          isOpen
          mode={addAddressCustomer ? 'addAddress' : 'new'}
          initialPhone={addCustomerPhone || request.displayPhone}
          initialCustomer={addAddressCustomer as never}
          onCustomerAdded={(customer) => {
            if (addAddressCustomer) {
              const activeSession = activeAddAddressSessionRef.current
              const savedCustomerId = String((customer as CallerIdOrderCustomer).id)
              if (
                !renderedAddAddressSession
                || !activeSession
                || activeSession.generation !== renderedAddAddressSession.generation
                || activeSession.requestKey !== renderedAddAddressSession.requestKey
                || activeSession.customerId !== renderedAddAddressSession.customerId
                || request.requestKey !== renderedAddAddressSession.requestKey
                || savedCustomerId !== renderedAddAddressSession.customerId
              ) {
                return
              }
              invalidateAddAddressSession()
            }
            setAddedCustomer(customer as unknown as CallerIdOrderCustomer)
            setAddCustomerPhone(null)
            setAddAddressCustomer(null)
          }}
          callerIdWorkspace={{
            suspended: isMinimized,
            onMinimize: () => setIsMinimized(true),
          }}
          onClose={() => {
            if (addAddressCustomer) {
              setAddedCustomer(addAddressCustomer)
              invalidateAddAddressSession()
            }
            setAddCustomerPhone(null)
            setAddAddressCustomer(null)
          }}
        />
      )}

      {request && isMinimized && (
        <CallerIdMinimizedPanel
          title={
            addedCustomer?.name ||
            addAddressCustomer?.name ||
            t('modals.customerSearch.incomingCaller', 'Incoming caller')
          }
          phone={
            addCustomerPhone ||
            (typeof addAddressCustomer?.phone === 'string' ? addAddressCustomer.phone : '') ||
            (typeof addedCustomer?.phone === 'string' ? addedCustomer.phone : '') ||
            request.displayPhone
          }
          ariaLabel={t('modals.customerSearch.callerIdWorkspace', 'Caller ID')}
          moveLabel={t('modals.customerSearch.moveCallerId', 'Move Caller ID panel')}
          restoreLabel={t('app.window.restore', 'Restore')}
          closeLabel={t('common.actions.close', 'Close')}
          onRestore={() => setIsMinimized(false)}
          onClose={closeCurrentLookup}
        />
      )}
    </>
  )
}
