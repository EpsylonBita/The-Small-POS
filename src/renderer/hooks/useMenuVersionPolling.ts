import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'react-hot-toast'
import { getBridge, isTauri, offEvent, onEvent } from '../../lib'

interface PollState {
  isPolling: boolean
  lastSeen: string | null
  error: string | null
  checks: number
}

function normalizeVersion(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

function emitMenuRefreshed(latest: string | null) {
  try {
    window.dispatchEvent(new CustomEvent('menu-sync:refreshed', { detail: { latest } }))
  } catch {}
}

export function useMenuVersionPolling(options?: { intervalMs?: number; enabled?: boolean }) {
  const enabled = options?.enabled ?? true
  const bridge = getBridge()
  const [state, setState] = useState<PollState>({
    isPolling: false,
    lastSeen: null,
    error: null,
    checks: 0,
  })
  const mountedRef = useRef(true)
  const lastToastedVersionRef = useRef<string | null>(null)

  useEffect(() => {
    return () => {
      mountedRef.current = false
    }
  }, [])

  useEffect(() => {
    if (!enabled || !isTauri()) return

    const handleVersionChecked = (payload: any) => {
      if (!mountedRef.current) return

      const success = payload?.success !== false
      const updated = payload?.updated === true
      const source = typeof payload?.source === 'string' ? payload.source : ''
      const isMonitorUpdate = source === 'menu_version_monitor'
      const version =
        normalizeVersion(payload?.version) ??
        normalizeVersion(payload?.timestamp) ??
        null
      const error = success
        ? null
        : (typeof payload?.error === 'string' ? payload.error : 'Menu check failed')

      setState((prev) => ({
        isPolling: false,
        lastSeen: version ?? prev.lastSeen,
        error,
        checks: prev.checks + 1,
      }))

      if (updated) {
        emitMenuRefreshed(version)
        if (isMonitorUpdate && (!version || lastToastedVersionRef.current !== version)) {
          lastToastedVersionRef.current = version
          toast.success('Menu updated')
        }
      }
    }

    onEvent('menu:version-checked', handleVersionChecked)
    return () => {
      offEvent('menu:version-checked', handleVersionChecked)
    }
  }, [enabled])

  const checkNow = useCallback(async () => {
    if (!enabled) return

    setState((prev) => ({ ...prev, isPolling: true, error: null }))
    try {
      const result = await bridge.menu.sync()
      const success = result?.success !== false
      const updated = result?.updated === true
      const version =
        normalizeVersion(result?.version) ??
        normalizeVersion(result?.timestamp) ??
        null
      const error = success
        ? null
        : (typeof result?.error === 'string' ? result.error : 'Menu sync failed')

      if (!mountedRef.current) return

      setState((prev) => ({
        isPolling: false,
        lastSeen: version ?? prev.lastSeen,
        error,
        checks: prev.checks + 1,
      }))
    } catch (error: any) {
      if (!mountedRef.current) return
      setState((prev) => ({
        ...prev,
        isPolling: false,
        checks: prev.checks + 1,
        error: error?.message || 'Menu check failed',
      }))
    }
  }, [bridge.menu, enabled])

  return { ...state, checkNow }
}

export default useMenuVersionPolling
