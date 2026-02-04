import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'react-hot-toast'
import { getApiUrl, API_TIMEOUT_MS, environment } from '../../config/environment'
import { posApiGet } from '../utils/api-helpers'
import { menuService } from '../services/MenuService'
import useTerminalSettings from './useTerminalSettings'

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

export function useMenuVersionPolling(options?: { intervalMs?: number; enabled?: boolean }) {
  const intervalMs = options?.intervalMs ?? 30000
  const enabled = options?.enabled ?? true

  const { getSetting } = useTerminalSettings()
  const [state, setState] = useState<PollState>({ isPolling: false, lastSeen: null, error: null, checks: 0 })
  const mountedRef = useRef(true)

  // Resolve credentials (prefer terminal settings; fallback to env)
  const creds = useMemo(() => {
    const lsTerminal = (typeof localStorage !== 'undefined' ? localStorage.getItem('terminal_id') : '') || ''
    const lsApi = (typeof localStorage !== 'undefined' ? localStorage.getItem('pos_api_key') : '') || ''

    const terminalId = (
      getSetting<string>('terminal', 'terminal_id', lsTerminal || environment.TERMINAL_ID) ||
      lsTerminal ||
      environment.TERMINAL_ID ||
      ''
    ).trim()

    const sharedKey = (
      getSetting<string>('pos', 'shared_key', environment.POS_API_SHARED_KEY) ||
      environment.POS_API_SHARED_KEY ||
      ''
    ).trim()

    const apiKeyFromPos = (
      getSetting<string>('pos', 'api_key', environment.POS_API_KEY) ||
      environment.POS_API_KEY ||
      lsApi ||
      ''
    ).trim()

    const apiKeyFromTerminal = (
      getSetting<string>('terminal', 'pos_api_key', lsApi || '') ||
      lsApi ||
      ''
    ).trim()

    const apiKey = (apiKeyFromTerminal || apiKeyFromPos || lsApi).trim()
    return { terminalId, sharedKey, apiKey }
  }, [getSetting])

  // Load persisted version on mount
  useEffect(() => {
    const v = localStorage.getItem('pos.menu.latest_updated_at')
    if (v) setState(prev => ({ ...prev, lastSeen: v }))
    return () => { mountedRef.current = false }
  }, [])

  const triggerMenuSync = useCallback(async (latest: string | null) => {
    // Always re-resolve from localStorage to avoid stale values
    const lsTerminal = (typeof localStorage !== 'undefined' ? localStorage.getItem('terminal_id') : '') || ''
    const lsApi = (typeof localStorage !== 'undefined' ? localStorage.getItem('pos_api_key') : '') || ''
    // Prioritize localStorage over creds (which may be stale from useMemo initialization)
    const terminalId = (lsTerminal || creds.terminalId || environment.TERMINAL_ID || '').trim()
    if (!terminalId) return
    try {
      const params = new URLSearchParams()
      params.set('terminal_id', terminalId)
      if (state.lastSeen) params.set('last_sync', state.lastSeen)

      const headers: Record<string, string> = { 'Content-Type': 'application/json', 'x-terminal-id': terminalId }
      // Prioritize localStorage over creds (which may be stale from useMemo initialization)
      const apiKey = (lsApi || creds.apiKey || environment.POS_API_KEY || '').trim()
      if (apiKey) headers['x-pos-api-key'] = apiKey
      else if (creds.sharedKey) headers['x-pos-sync-key'] = creds.sharedKey

      // Debug logging for troubleshooting auth issues
      console.log('[triggerMenuSync] auth debug:', {
        hasApiKey: !!apiKey,
        apiKeyLen: apiKey?.length || 0,
        apiKeyLast4: apiKey?.slice(-4) || '',
        terminalId,
        lsApiLen: lsApi?.length || 0,
        credsApiLen: creds.apiKey?.length || 0
      })

      const endpoint = `/pos/menu-sync?${params.toString()}`
      const result = await posApiGetWithTimeout(endpoint, { headers })
      if (!result.success) {
        const msg = result.error || 'Unknown error'
        throw new Error(`menu-sync failed: ${msg}`)
      }
      // We don’t currently use the payload; we refresh caches from Supabase directly
      // to keep sources consistent with MenuService.
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

      // Notify UI listeners that a background menu refresh completed
      try {
        window.dispatchEvent(new CustomEvent('menu-sync:refreshed', { detail: { latest } }))
      } catch {}

      toast.success('Menu updated')
    } catch (e: any) {
      console.warn('[useMenuVersionPolling] triggerMenuSync error:', e?.message || e)
      if (mountedRef.current) setState(prev => ({ ...prev, error: e?.message || 'Menu sync failed' }))
    }
  }, [creds.apiKey, creds.sharedKey, creds.terminalId, state.lastSeen])

  const debugCountRef = useRef(0)
  const fallbackUsedRef = useRef(false)
  const checkOnce = useCallback(async () => {
    if (!enabled) return
    try {
      if (mountedRef.current) setState(prev => ({ ...prev, isPolling: true, error: null }))
      const headers: Record<string, string> = { 'Content-Type': 'application/json' }
      // Re-resolve latest creds on each poll - prioritize localStorage (freshest source)
      const lsTerminal = (typeof localStorage !== 'undefined' ? localStorage.getItem('terminal_id') : '') || ''
      const lsApi = (typeof localStorage !== 'undefined' ? localStorage.getItem('pos_api_key') : '') || ''
      // Prioritize localStorage over creds (which may be stale from useMemo initialization)
      const terminalId = (lsTerminal || creds.terminalId || environment.TERMINAL_ID || '').trim()
      const apiKey = (lsApi || creds.apiKey || environment.POS_API_KEY || '').trim()

      if (terminalId) headers['x-terminal-id'] = terminalId
      if (apiKey) headers['x-pos-api-key'] = apiKey
      if (!apiKey && creds.sharedKey) headers['x-pos-sync-key'] = creds.sharedKey

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
            apiKeyLen: headers['x-pos-api-key']?.length || 0,
            apiKeyLast4: headers['x-pos-api-key']?.slice(-4) || '',
            hasSyncKey: !!headers['x-pos-sync-key'],
            syncKeyLen: headers['x-pos-sync-key']?.length || 0
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
  }, [enabled, creds.sharedKey, creds.apiKey, creds.terminalId, state.lastSeen, triggerMenuSync])

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

