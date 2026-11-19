import React, { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { getBridge } from '../../lib'
import type { MoneyApproval, PrivilegedActionScope } from '../../lib/ipc-contracts'
import PINLoginModal from '../components/auth/PINLoginModal'
import { extractPrivilegedActionError } from '../utils/privileged-actions'
import { managerApprovalAvailable } from '../services/manager-approval'

interface PrivilegedActionRequest<T> {
  scope: PrivilegedActionScope
  action: (pin?: string) => Promise<T>
  title?: string
  subtitle?: string
  /**
   * Why a manager's own PIN is asked, when the caller knows better than the
   * default "nobody is checked in" (07/10/2026: a paid cancellation asks it
   * while a cashier without the right is on shift).
   */
  approvalSubtitle?: string
  onPinRefused?: () => Promise<void> | void
}

interface PendingPrivilegedAction<T> extends PrivilegedActionRequest<T> {
  resolve: (value: T) => void
  reject: (error: unknown) => void
  /**
   * The till asked for a manager's own PIN (nobody is on shift at this
   * terminal, fix review 30/09/2026): what the manager approves.
   */
  approval?: MoneyApproval | null
}

export function usePrivilegedActionConfirmation() {
  const bridge = getBridge()
  const { t } = useTranslation()
  const [pendingAction, setPendingAction] = useState<PendingPrivilegedAction<unknown> | null>(null)
  const pendingRef = useRef<PendingPrivilegedAction<unknown> | null>(null)
  const [approvalState, setApprovalState] = useState<'checking' | 'ready' | 'noApprover' | 'paused'>('checking')
  const [permission, setPermission] = useState('')
  const [pinRefused, setPinRefused] = useState(false)
  const [pausedUntil, setPausedUntil] = useState(0)
  const [minutes, setMinutes] = useState(0)

  useEffect(() => {
    if (!pendingAction?.approval) return
    let cancelled = false
    setApprovalState('checking')
    managerApprovalAvailable(pendingAction.approval).then(result => {
      if (cancelled) return
      setPermission(result.permission)
      setApprovalState(result.available ? 'ready' : 'noApprover')
    }, () => {
      // Confirmation refreshes and checks the directory again. A failed
      // preflight must not invent a missing right or retain a PIN.
      if (!cancelled) setApprovalState('ready')
    })
    return () => { cancelled = true }
  }, [pendingAction])

  useEffect(() => {
    if (approvalState !== 'paused' || !pendingAction) return
    const update = () => {
      const remaining = Math.max(0, Math.ceil((pausedUntil - Date.now()) / 60_000))
      setMinutes(remaining)
      if (!remaining) {
        setPinRefused(false)
        setApprovalState('ready')
      }
    }
    update()
    const timer = setInterval(update, 1000)
    return () => clearInterval(timer)
  }, [approvalState, pausedUntil, pendingAction])

  const runWithPrivilegedConfirmation = async <T,>({
    scope,
    action,
    title,
    subtitle,
    approvalSubtitle,
    onPinRefused,
  }: PrivilegedActionRequest<T>): Promise<T> => {
    try {
      return await action()
    } catch (error) {
      const privilegedError = extractPrivilegedActionError(error, scope)

      if (!privilegedError) {
        throw error
      }

      if (privilegedError.code === 'UNAUTHORIZED') {
        if (privilegedError.reason === 'Active session required') {
          throw { ...privilegedError, code: 'AUTH_SESSION_REQUIRED' }
        }
        throw new Error(privilegedError.reason || 'Unauthorized')
      } else if (privilegedError.code !== 'REAUTH_REQUIRED' && privilegedError.code !== 'AUTH_SESSION_EXPIRED' && privilegedError.code !== 'AUTH_GRANT_EXPIRED') {
        throw error
      }

      return await new Promise<T>((resolve, reject) => {
        setPinRefused(false)
        setApprovalState('checking')
        setPermission(privilegedError.approval === 'void_orders' ? 'pos.orders.cancel' : 'pos.refunds.process')
        const pending: PendingPrivilegedAction<unknown> = {
          scope,
          action,
          resolve: resolve as (value: unknown) => void,
          reject,
          title,
          subtitle: privilegedError.code === 'AUTH_SESSION_EXPIRED'
            ? t('orderSyncNotice.sessionExpired', { defaultValue: 'The till sign-in has expired. Enter the till PIN again.' })
            : privilegedError.code === 'AUTH_GRANT_EXPIRED'
              ? t('recovery.actionStatus.grantExpired')
              : subtitle,
          approvalSubtitle,
          onPinRefused,
          approval: privilegedError.approval ?? null,
        }
        pendingRef.current = pending
        setPendingAction(pending)
      })
    }
  }

  const handleClose = () => {
    if (!pendingAction || pendingRef.current !== pendingAction) {
      return
    }

    pendingRef.current = null
    pendingAction.reject(new Error('AUTH_CONFIRMATION_CANCELLED'))
    setPendingAction(null)
  }

  const handleSubmit = async (pin: string): Promise<boolean> => {
    if (!pendingAction || (pendingAction.approval && approvalState !== 'ready')) {
      return false
    }

    try {
      await bridge.auth.confirmPrivilegedAction({
        pin,
        scope: pendingAction.scope,
        ...(pendingAction.approval ? { approval: pendingAction.approval } : {}),
      })
    } catch (error) {
      if (pendingRef.current !== pendingAction) return true
      const privilegedError = extractPrivilegedActionError(error, pendingAction.scope)
      if (pendingAction.approval) {
        if (privilegedError?.permission) setPermission(privilegedError.permission)
        if (privilegedError?.code === 'NO_APPROVER_IN_STORE') {
          setApprovalState('noApprover')
          return false
        }
        if (privilegedError?.code === 'APPROVALS_PAUSED') {
          const remaining = privilegedError.minutes ?? 5
          setMinutes(remaining)
          setPausedUntil(Date.now() + remaining * 60_000)
          setApprovalState('paused')
          return false
        }
        if (privilegedError?.code === 'MANAGER_PIN_REFUSED' ||
            (privilegedError?.code === 'UNAUTHORIZED' && privilegedError.reason === 'Invalid PIN')) {
          setPinRefused(true)
          return false
        }
      }
      if (privilegedError?.code === 'AUTH_PIN_WRONG' ||
          (privilegedError?.code === 'UNAUTHORIZED' && privilegedError.reason === 'Invalid PIN')) {
        await pendingAction.onPinRefused?.()
        return false
      }

      pendingAction.reject(privilegedError ?? error)
      pendingRef.current = null
      setPendingAction(null)
      return true
    }

    if (pendingRef.current !== pendingAction) return true
    // Once the PIN is accepted, the action may commit. Dismiss the prompt
    // before starting it so closing the prompt cannot report a cancellation.
    pendingRef.current = null
    setPendingAction(null)
    try {
      // Only the current callback receives the PIN. It is never retained in
      // pending state, storage, logs, or an offline operation payload.
      const result = await pendingAction.action(pin)
      pendingAction.resolve(result)
    } catch (error) {
      pendingAction.reject(error)
    }

    return true
  }

  // Nobody is on shift at this terminal: a manager approves with their own
  // PIN (the shared terminal PIN does not), so the prompt says so, unless the
  // caller says why it is asked.
  const subtitle = pendingAction?.approval
    ? pendingAction.approvalSubtitle ??
      String(
        t('auth.managerApproval.subtitle', {
          defaultValue:
            'Nobody is checked in on this till. A manager with the right to approve it enters their own PIN. Nothing is charged.',
        })
      )
    : pendingAction?.subtitle

  const confirmationModal = (
    <PINLoginModal
      isOpen={Boolean(pendingAction)}
      onClose={handleClose}
      onSubmit={handleSubmit}
      title={pendingAction?.title}
      subtitle={subtitle}
      blockedMessage={pendingAction?.approval && approvalState !== 'ready'
        ? String(t(`auth.managerApproval.${approvalState === 'checking' ? 'checking' : approvalState === 'paused' ? 'paused' : 'noApprover'}`, {
            right: t(permission === 'pos.orders.cancel' ? 'auth.managerApproval.rights.cancelOrders' : 'auth.managerApproval.rights.voidPayments'),
            minutes,
          }))
        : undefined}
      errorMessage={pendingAction?.approval && pinRefused
        ? String(t('auth.managerApproval.pinRefused', {
            right: t(permission === 'pos.orders.cancel' ? 'auth.managerApproval.rights.cancelOrders' : 'auth.managerApproval.rights.voidPayments'),
          })) : undefined}
    />
  )

  return {
    runWithPrivilegedConfirmation,
    confirmationModal,
    confirmationOpen: Boolean(pendingAction),
  }
}
