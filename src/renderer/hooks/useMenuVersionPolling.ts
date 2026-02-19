import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'react-hot-toast'
import { getApiUrl, API_TIMEOUT_MS, environment } from '../../config/environment'
import { posApiGet } from '../utils/api-helpers'
import { menuService } from '../services/MenuService'
import useTerminalSettings from './useTerminalSettings'
import {
  getCachedTerminalCredentials,
  refreshTerminalCredentialCache,
} from '../services/terminal-credentials'

interface PollState {
  isPolling: boolean
  lastSeen: string | null
  error: string | null
  checks: number
}

function posApiGetWithTimeout<T>(
  endpoint: string,
  options: RequestInit = {},
  timeoutMs: number = API_TIMEOUT_MS
) {
  const controller = new AbortController()
  const id = setTimeout(() => controller.abort(), timeoutMs)
  return posApiGet<T>(endpoint, { ...options, signal: controller.signal })
    .finally(() => clearTimeout(id))
}

type IpcInvoke = (channel: string, ...args: any[]) => Promise<any>

function getIpcInvoke(): IpcInvoke | null {
  if (typeof window === 'undefined') return null

  const w = window as any
  if (typeof w?.electronAPI?.invoke === 'function') {
    return w.electronAPI.invoke.bind(w.electronAPI)
  }
  if (typeof w?.electronAPI?.ipcRenderer?.invoke === 'function') {
    return w.electronAPI.ipcRenderer.invoke.bind(w.electronAPI.ipcRenderer)
  }
  if (typeof w?.electron?.ipcRenderer?.invoke === 'function') {
    return w.electron.ipcRenderer.invoke.bind(w.electron.ipcRenderer)
  }
  return null
}

export function useMenuVersionPolling(options?: { intervalMs?: number; enabled?: boolean }) {
  const intervalMs = options?.intervalMs ?? 30000
  const enabled = options?.enabled ?? true

  const { getSetting } = useTerminalSettings()
  const [state, setState] = useState<PollState>({ isPolling: false, lastSeen: null, error: null, checks: 0 })
  const mountedRef = useRef(true)

  // Resolve credentials (prefer terminal settings + in-memory credential cache)
  const creds = useMemo(() => {
    const cached = getCachedTerminalCredentials()
    const lsTerminal = (typeof localStorage !== 'undefined' ? localStorage.getItem('terminal_id') : '') || ''

    const terminalId = (
      getSetting<string>('terminal', 'terminal_id', lsTerminal || environment.TERMINAL_ID) ||
      lsTerminal ||
      environment.TERMINAL_ID ||
      ''
    ).trim()

    const apiKeyFromPos = (
      getSetting<string>('pos', 'api_key', '') ||
      ''
    ).trim()

    const apiKeyFromTerminal = (
      getSetting<string>('terminal', 'pos_api_key', cached.apiKey || '') ||
      ''
    ).trim()

    const apiKey = (apiKeyFromTerminal || apiKeyFromPos || cached.apiKey || '').trim()
    return { terminalId, apiKey }
  }, [getSetting])

  // Load persisted version on mount
  useEffect(() => {
    const v = localStorage.getItem('pos.menu.latest_updated_at')
    if (v) setState(prev => ({ ...prev, lastSeen: v }))
    void refreshTerminalCredentialCache()
    return () => { mountedRef.current = false }
  }, [])

  const triggerMenuSync = useCallback(async (latest: string | null) => {
    const invoke = getIpcInvoke()
    if (!invoke) throw new Error('IPC bridge unavailable for menu sync')

    try {
      const result = await invoke('menu:sync')
      if (!result?.success) {
        const code = result?.errorCode || 'menu_sync_failed'
        const msg = result?.error || 'Unknown error'
        throw new Error(`${code}: ${msg}`)
      }

      await Promise.allSettled([
        (async () => { menuService.clearCache(); })(),
        menuService.getMenuCategories(),
        menuService.getMenuItems(),
        menuService.getIngredients(),
      ])

      if (latest) {
        localStorage.setItem('pos.menu.latest_updated_at', latest)
        if (mountedRef.current) setState(prev => ({ ...prev, lastSeen: latest }))
      }

      console.log('[useMenuVersionPolling] menu cache refreshed via IPC menu:sync', {
        latest,
        version: result?.version,
        counts: result?.counts,
        updated: result?.updated,
      })

      // Notify UI listeners that a background menu refresh completed
      try {
        window.dispatchEvent(new CustomEvent('menu-sync:refreshed', { detail: { latest } }))
      } catch {}

      toast.success('Menu updated')
    } catch (e: any) {
      console.warn('[useMenuVersionPolling] triggerMenuSync error:', e?.message || e)
      if (mountedRef.current) setState(prev => ({ ...prev, error: e?.message || 'Menu sync failed' }))
    }
  }, [])

  const debugCountRef = useRef(0)
  const fallbackUsedRef = useRef(false)
  const checkOnce = useCallback(async () => {
    if (!enabled) return
    try {
      if (mountedRef.current) setState(prev => ({ ...prev, isPolling: true, error: null }))
      const headers: Record<string, string> = { 'Content-Type': 'application/json' }
      // Re-resolve latest creds on each poll
      const cached = getCachedTerminalCredentials()
      const lsTerminal = (typeof localStorage !== 'undefined' ? localStorage.getItem('terminal_id') : '') || ''
      const terminalId = (lsTerminal || cached.terminalId || creds.terminalId || environment.TERMINAL_ID || '').trim()
      const apiKey = (cached.apiKey || creds.apiKey || '').trim()

      if (terminalId) headers['x-terminal-id'] = terminalId
      if (apiKey) headers['x-pos-api-key'] = apiKey
      if (!apiKey) throw new Error('Missing per-terminal POS API key for menu version polling')

      const since = state.lastSeen
      const params = new URLSearchParams()
      if (since) params.set('since', since)
      if (terminalId) params.set('terminal_id', terminalId)
      const endpoint = `/pos/menu-version${params.toString() ? `?${params.toString()}` : ''}`
      const url = getApiUrl(endpoint)

      // Lightweight debug (first 2 attempts)
      try {
        if (debugCountRef.current < 2) {
          debugCountRef.current += 1
          // avoid logging secrets in full
          console.log('[MenuVersionPolling] request', {
            url,
            hasTerminalId: !!headers['x-terminal-id'],
            terminalId: headers['x-terminal-id'],
            hasApiKey: !!headers['x-pos-api-key'],
            usingCachedApiKey: !!cached.apiKey
          })
        }
      } catch {}

      const result = await posApiGetWithTimeout<{ latest_updated_at?: string }>(endpoint, { headers })
      if (!result.success) {
        const msg = result.error || 'Unknown error'

        // Opportunistic fallback: if unauthorized once, try a full sync to self-heal
        if (result.status === 401 && !fallbackUsedRef.current) {
          fallbackUsedRef.current = true
          console.warn('[useMenuVersionPolling] 401 from menu-version, triggering full menu-sync once...')
          await triggerMenuSync(state.lastSeen)
        }
        throw new Error(`menu-version failed: ${msg}`)
      }
      const latest: string | null = result.data?.latest_updated_at || null

      if (latest && latest !== state.lastSeen) {
        await triggerMenuSync(latest)
      }

      if (mountedRef.current) setState(prev => ({ ...prev, isPolling: false, checks: prev.checks + 1 }))
    } catch (e: any) {
      if (mountedRef.current) setState(prev => ({ ...prev, isPolling: false, error: e?.message || 'Check failed', checks: prev.checks + 1 }))
    }
  }, [enabled, creds.apiKey, creds.terminalId, state.lastSeen, triggerMenuSync])

  // Interval loop
  useEffect(() => {
    if (!enabled) return

    // STARTUP DELAY: Wait before first poll to allow main process heartbeat to complete
    // This prevents 401 errors when the terminal hasn't been registered yet
    // The heartbeat creates/updates the terminal record with api_key_hash
    let intervalId: ReturnType<typeof setInterval> | null = null

    const startupTimer = setTimeout(() => {
      // First poll after delay
      checkOnce()
      // Then set up regular interval
      intervalId = setInterval(checkOnce, intervalMs)
    }, 5000) // 5 second delay on startup to allow heartbeat to complete

    return () => {
      clearTimeout(startupTimer)
      if (intervalId) clearInterval(intervalId)
    }
  }, [enabled, intervalMs, checkOnce])

  return { ...state, checkNow: checkOnce }
}

export default useMenuVersionPolling

