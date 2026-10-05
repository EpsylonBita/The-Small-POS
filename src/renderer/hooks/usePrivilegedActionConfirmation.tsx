import React, { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { getBridge } from '../../lib'
import type { MoneyApproval, PrivilegedActionScope } from '../../lib/ipc-contracts'
import PINLoginModal from '../components/auth/PINLoginModal'
import { extractPrivilegedActionError } from '../utils/privileged-actions'

interface PrivilegedActionRequest<T> {
  scope: PrivilegedActionScope
  action: (pin?: string) => Promise<T>
  title?: string
  subtitle?: string
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

  const runWithPrivilegedConfirmation = async <T,>({
    scope,
    action,
    title,
    subtitle,
  }: PrivilegedActionRequest<T>): Promise<T> => {
    try {
      return await action()
    } catch (error) {
      const privilegedError = extractPrivilegedActionError(error, scope)

      if (!privilegedError) {
        throw error
      }

      if (privilegedError.code === 'UNAUTHORIZED') {
        if (privilegedError.reason !== 'Active session required') {
          throw new Error(privilegedError.reason || 'Unauthorized')
        }
        // Session missing/expired — fall through to show PIN modal
      } else if (privilegedError.code !== 'REAUTH_REQUIRED') {
        throw error
      }

      return await new Promise<T>((resolve, reject) => {
        setPendingAction({
          scope,
          action,
          resolve: resolve as (value: unknown) => void,
          reject,
          title,
          subtitle,
          approval: privilegedError.approval ?? null,
        })
      })
    }
  }

  const handleClose = () => {
    if (!pendingAction) {
      return
    }

    pendingAction.reject(new Error('Privileged action confirmation cancelled'))
    setPendingAction(null)
  }

  const handleSubmit = async (pin: string): Promise<boolean> => {
    if (!pendingAction) {
      return false
    }

    try {
      await bridge.auth.confirmPrivilegedAction({
        pin,
        scope: pendingAction.scope,
        ...(pendingAction.approval ? { approval: pendingAction.approval } : {}),
      })
    } catch (error) {
      const privilegedError = extractPrivilegedActionError(error, pendingAction.scope)
      if (privilegedError?.code === 'UNAUTHORIZED' && privilegedError.reason === 'Invalid PIN') {
        return false
      }

      pendingAction.reject(
        new Error(privilegedError?.reason || 'Privileged action confirmation failed')
      )
      setPendingAction(null)
      return true
    }

    try {
      // Only the current callback receives the PIN. It is never retained in
      // pending state, storage, logs, or an offline operation payload.
      const result = await pendingAction.action(pin)
      pendingAction.resolve(result)
    } catch (error) {
      pendingAction.reject(error)
    } finally {
      setPendingAction(null)
    }

    return true
  }

  // Nobody is on shift at this terminal: a manager approves with their own
  // PIN (the shared terminal PIN does not), so the prompt says so.
  const subtitle = pendingAction?.approval
    ? String(
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
    />
  )

  return {
    runWithPrivilegedConfirmation,
    confirmationModal,
  }
}
