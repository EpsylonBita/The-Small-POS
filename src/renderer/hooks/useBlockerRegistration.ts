import { useEffect } from 'react'
import {
  registerUiBlocker,
  unregisterUiBlocker,
} from '../services/uiBlockerRegistry'

interface UseBlockerRegistrationOptions {
  id: string
  label: string
  source: string
  active: boolean
  metadata?: Record<string, unknown>
}

export function useBlockerRegistration({
  id,
  label,
  source,
  active,
  metadata,
}: UseBlockerRegistrationOptions): void {
  useEffect(() => {
    if (active) {
      registerUiBlocker({
        id,
        label,
        source,
        metadata,
      })
    } else {
      unregisterUiBlocker(id)
    }

    return () => {
      unregisterUiBlocker(id)
    }
  }, [active, id, label, metadata, source])
}
