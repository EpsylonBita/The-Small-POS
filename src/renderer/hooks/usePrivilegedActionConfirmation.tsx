import React, { useState } from 'react'
import { getBridge } from '../../lib'
import type { PrivilegedActionScope } from '../../lib/ipc-contracts'
import PINLoginModal from '../components/auth/PINLoginModal'
import { extractPrivilegedActionError } from '../utils/privileged-actions'

interface PrivilegedActionRequest<T> {
  scope: PrivilegedActionScope
  action: () => Promise<T>
  title?: string
  subtitle?: string
}

interface PendingPrivilegedAction<T> extends PrivilegedActionRequest<T> {
  resolve: (value: T) => void
  reject: (error: unknown) => void
}

export function usePrivilegedActionConfirmation() {
  const bridge = getBridge()
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
      const result = await pendingAction.action()
      pendingAction.resolve(result)
    } catch (error) {
      pendingAction.reject(error)
    } finally {
      setPendingAction(null)
    }

    return true
  }

  const confirmationModal = (
    <PINLoginModal
      isOpen={Boolean(pendingAction)}
      onClose={handleClose}
      onSubmit={handleSubmit}
      title={pendingAction?.title}
      subtitle={pendingAction?.subtitle}
    />
  )

  return {
    runWithPrivilegedConfirmation,
    confirmationModal,
  }
}
