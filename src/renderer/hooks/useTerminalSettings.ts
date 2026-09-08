import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { getBridge, offEvent, onEvent } from '../../lib'
import type { TerminalSettings } from '../../lib/ipc-adapter'

// Terminal settings are typically returned as a flat map like "category.key" -> value
// but we defensively support nested objects { category: { key: value } } too.
// Wave 8 H28: re-export the canonical type from ipc-adapter so consumers stay
// aligned with Rust extractor coverage and don't fall back to a permissive
// `Record<string, any>` shadow type that bypasses the typed interface.
export type { TerminalSettings }

export function useTerminalSettings() {
  const bridge = useMemo(() => getBridge(), [])
  const [settings, setSettings] = useState<TerminalSettings>({})
  const [loading, setLoading] = useState<boolean>(true)
  const [error, setError] = useState<string | null>(null)
  const loadGeneration = useRef(0)

  useEffect(() => {
    let mounted = true
    let retryTimer: ReturnType<typeof setTimeout> | undefined

    // Retry a startup race with the DB without losing a previously loaded
    // configuration. A newer notification must win over an older IPC response.
    const load = async (attempt = 0) => {
      if (retryTimer !== undefined) clearTimeout(retryTimer)
      const generation = ++loadGeneration.current
      const isCurrent = () => mounted && generation === loadGeneration.current
      try {
        if (attempt === 0) setLoading(true)
        setError(null)
        const s = await bridge.terminalConfig.getSettings()
        if (!isCurrent()) return
        setSettings(s || {})
        if ((!s || Object.keys(s).length === 0) && attempt < 5) {
          retryTimer = setTimeout(() => load(attempt + 1), 2000 * (attempt + 1))
        }
      } catch (e: any) {
        if (!isCurrent()) return
        setError(e?.message || 'Failed to load terminal settings')
        if (attempt < 5) {
          retryTimer = setTimeout(() => load(attempt + 1), 2000 * (attempt + 1))
        }
      } finally {
        if (isCurrent()) setLoading(false)
      }
    }

    load()

    const handleTerminalSettingsUpdated = (data: any) => {
      // Older native builds announce cache writes through the same channel.
      // These do not change configuration and must not trigger bulk reads.
      const updated = Array.isArray(data?.updated) ? data.updated :
        typeof data?.key === 'string' ? [data.key] : null
      if (Array.isArray(updated) && updated.length > 0 && updated.every(
        (key: unknown) => typeof key === 'string' &&
          (key.startsWith('local.') || key.startsWith('staff_auth_cache.'))
      )) return
      // Native events contain changed key names, not the settings themselves.
      // Replacing settings with { updated: [...] } used to erase branch identity.
      if (mounted) void load()
    }
    onEvent('terminal-settings-updated', handleTerminalSettingsUpdated)

    return () => {
      mounted = false
      loadGeneration.current += 1
      if (retryTimer !== undefined) clearTimeout(retryTimer)
      offEvent('terminal-settings-updated', handleTerminalSettingsUpdated)
    }
  }, [bridge])

  const refresh = useCallback(async () => {
    const generation = ++loadGeneration.current
    try {
      const res = await bridge.terminalConfig.refresh()
      let latestSettings: TerminalSettings | undefined

      if ((res as any)?.success !== false) {
        latestSettings = await bridge.terminalConfig.getSettings()
        if (generation === loadGeneration.current) setSettings(latestSettings || {})
      }

      if (res && typeof res === 'object' && !Array.isArray(res)) {
        return { ...(res as unknown as Record<string, unknown>), settings: latestSettings }
      }

      return { success: true, data: res, settings: latestSettings }
    } catch (e: any) {
      const out = { success: false, error: e?.message || 'Failed to refresh terminal settings' }
      if (generation === loadGeneration.current) setError(out.error)
      return out
    } finally {
      if (generation === loadGeneration.current) setLoading(false)
    }
  }, [bridge])

  const getSetting = useCallback(
    <T = any>(category: string, key: string, defaultValue?: T): T | undefined => {
      // Prefer flat map access first
      const flatKey = `${category}.${key}`
      if (settings && Object.prototype.hasOwnProperty.call(settings, flatKey)) {
        return settings[flatKey] as T
      }

      // Fallback to nested object shape
      const cat = settings?.[category]
      if (cat && typeof cat === 'object' && Object.prototype.hasOwnProperty.call(cat, key)) {
        return (cat as any)[key] as T
      }

      return defaultValue
    },
    [settings]
  )

  return { settings, loading, error, refresh, getSetting }
}

export default useTerminalSettings
