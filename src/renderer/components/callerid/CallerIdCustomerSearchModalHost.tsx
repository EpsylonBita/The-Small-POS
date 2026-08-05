import { useCallback, useEffect, useMemo, useState } from 'react'
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
  const [addedCustomer, setAddedCustomer] = useState<CallerIdOrderCustomer | null>(null)
  const [isMinimized, setIsMinimized] = useState(false)
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

  useEffect(() => {
    setAddCustomerPhone(null)
    setAddedCustomer(null)
    setIsMinimized(false)
  }, [request?.requestKey])

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
    setAddedCustomer(null)
    setIsMinimized(false)
    onClose()
  }, [onClose, onContinueToOrderType, request])

  const closeCurrentLookup = useCallback(() => {
    setAddCustomerPhone(null)
    setAddedCustomer(null)
    setIsMinimized(false)
    onClose()
  }, [onClose])

  return (
    <>
      <CustomerSearchModal
        key={request?.requestKey ?? 'caller-id-search-closed'}
        isOpen={Boolean(request) && addCustomerPhone === null}
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

      {request && addCustomerPhone !== null && (
        <AddCustomerModal
          isOpen
          mode="new"
          initialPhone={addCustomerPhone || request.displayPhone}
          onCustomerAdded={(customer) => {
            setAddedCustomer(customer as unknown as CallerIdOrderCustomer)
            setAddCustomerPhone(null)
          }}
          callerIdWorkspace={{
            suspended: isMinimized,
            onMinimize: () => setIsMinimized(true),
          }}
          onClose={() => setAddCustomerPhone(null)}
        />
      )}

      {request && isMinimized && (
        <CallerIdMinimizedPanel
          title={
            addedCustomer?.name ||
            t('modals.customerSearch.incomingCaller', 'Incoming caller')
          }
          phone={
            addCustomerPhone ||
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
