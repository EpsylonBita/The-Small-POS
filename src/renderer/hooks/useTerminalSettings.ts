import { useCallback, useEffect, useMemo, useState } from 'react'
import { getBridge, offEvent, onEvent } from '../../lib'

// Terminal settings are typically returned as a flat map like "category.key" -> value
// but we defensively support nested objects { category: { key: value } } too.
export type TerminalSettings = Record<string, any>

export function useTerminalSettings() {
  const bridge = useMemo(() => getBridge(), [])
  const [settings, setSettings] = useState<TerminalSettings>({})
  const [loading, setLoading] = useState<boolean>(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let mounted = true

    const load = async () => {
      try {
        setLoading(true)
        setError(null)
        const s = await bridge.terminalConfig.getSettings()
        if (mounted) setSettings(s || {})
      } catch (e: any) {
        if (mounted) setError(e?.message || 'Failed to load terminal settings')
      } finally {
        if (mounted) setLoading(false)
      }
    }

    load()

    const handleTerminalSettingsUpdated = (data: any) => {
      if (mounted) setSettings(data || {})
    }
    onEvent('terminal-settings-updated', handleTerminalSettingsUpdated)

    return () => {
      mounted = false
      offEvent('terminal-settings-updated', handleTerminalSettingsUpdated)
    }
  }, [bridge])

  const refresh = useCallback(async () => {
    try {
      const res = await bridge.terminalConfig.refresh()
      let latestSettings: TerminalSettings | undefined

      if ((res as any)?.success !== false) {
        latestSettings = await bridge.terminalConfig.getSettings()
        setSettings(latestSettings || {})
      }

      if (res && typeof res === 'object' && !Array.isArray(res)) {
        return { ...(res as unknown as Record<string, unknown>), settings: latestSettings }
      }

      return { success: true, data: res, settings: latestSettings }
    } catch (e: any) {
      const out = { success: false, error: e?.message || 'Failed to refresh terminal settings' }
      setError(out.error)
      return out
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

