import React, { useEffect, useReducer, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import useTerminalSettings from './useTerminalSettings'
import { posApiGet } from '../utils/api-helpers'
// Informational only. No work-card write is ever sent by a till.
export const WORK_CARD_POLL_MS = 60_000
export const WORK_CARD_MAX_AGE_MS = 5 * 60_000
export const WORK_CARD_TIMEOUT_MS = 2_000
export type WorkCardState = 'sent' | 'pending' | 'dry_run' | 'late' | 'missing_exit' | 'needs_action' | 'none'
export interface WorkCardStaff {
  staff_id: string
  state: WorkCardState
  punch: 'start' | 'end' | null
  at: string | null
  sent_at: string | null
  protocol: string | null
  action_required: string | null
  at_risk: boolean
}
export type WorkCardStatus = { enabled: false } | {
  enabled: true
  mode: 'dry_run' | 'trial' | 'live'
  staff: WorkCardStaff[]
  attention_count: number
}
export function parseWorkCardStatus(value: unknown): WorkCardStatus | null {
  if (!value || typeof value !== 'object') return null
  const data = value as Record<string, unknown>
  if (data.enabled === false) return { enabled: false }
  if (data.success !== true || data.enabled !== true ||
      !['dry_run', 'trial', 'live'].includes(String(data.mode)) ||
      !Number.isInteger(data.attention_count) || Number(data.attention_count) < 0 || !Array.isArray(data.staff)) return null
  const states = ['sent', 'pending', 'dry_run', 'late', 'missing_exit', 'needs_action', 'none']
  if (data.staff.some(row => !row || typeof row.staff_id !== 'string' || !states.includes(row.state) ||
    !['start', 'end', null].includes(row.punch) || typeof row.at_risk !== 'boolean' ||
    ['at', 'sent_at', 'protocol', 'action_required'].some(key => row[key] !== null && typeof row[key] !== 'string'))) return null
  return data as unknown as WorkCardStatus
}
// Keep only display data, in memory, isolated by canonical terminal/org/branch.
export function createWorkCardCache() {
  const entries = new Map<string, { data: WorkCardStatus; at: number; people: Map<string, { row: WorkCardStaff; at: number }> }>()
  return {
    put(scope: string, data: WorkCardStatus, now = Date.now()) {
      const people = data.enabled ? new Map(entries.get(scope)?.people) : new Map()
      if (data.enabled) data.staff.forEach(row => people.set(row.staff_id, { row, at: now }))
      entries.set(scope, { data, at: now, people })
    },
    read(scope: string, now = Date.now()): WorkCardStatus | null {
      const entry = entries.get(scope)
      if (!entry || now - entry.at >= WORK_CARD_MAX_AGE_MS) return null
      if (!entry.data.enabled) return entry.data
      return { ...entry.data, staff: [...entry.people.values()].filter(person => now - person.at < WORK_CARD_MAX_AGE_MS).map(person => person.row) }
    },
    // Expiry hides display data; it does not mean the admin switched the branch off.
    isEnabled(scope: string) { return entries.get(scope)?.data.enabled === true },
    clear() { entries.clear() },
  }
}
const cache = createWorkCardCache()
const listeners = new Set<() => void>()
const publish = () => listeners.forEach(listener => listener())
export function workCardStaffBatches(ids: readonly string[]): string[][] {
  const unique = [...new Set(ids)].filter(id => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)).sort()
  const batches: string[][] = []
  for (let i = 0; i < unique.length; i += 50) batches.push(unique.slice(i, i + 50))
  return batches.length ? batches : [[]]
}
export function workCardLineKey(data: WorkCardStatus | null, staffId: string | null | undefined, offline: boolean): string | null {
  if (!data?.enabled || !staffId) return null
  if (offline) return 'workCard.offline'
  const person = data.staff.find(row => row.staff_id === staffId)
  return person && person.state !== 'none' ? `workCard.${person.state}` : null
}

export function useWorkCardStatus(active: boolean, staffIds: readonly string[] = [], enabledPollingOnly = false) {
  const { getSetting } = useTerminalSettings()
  const scope = JSON.stringify(['organization_id', 'branch_id', 'terminal_id'].map(key => getSetting('terminal', key)))
  const ready = ['organization_id', 'branch_id', 'terminal_id'].every(key => Boolean(getSetting('terminal', key)))
  const [offline, setOffline] = useState(() => typeof navigator !== 'undefined' && navigator.onLine === false)
  const [, render] = useReducer(n => n + 1, 0)
  const ids = JSON.stringify(workCardStaffBatches(staffIds))
  const generation = useRef(0)
  useEffect(() => {
    if (!active) return
    listeners.add(render)
    return () => { listeners.delete(render) }
  }, [active])
  useEffect(() => {
    if (!active || !ready) return
    let disposed = false
    let busy = false
    const current = ++generation.current
    const refresh = async (initial = false) => {
      render() // Expire the old value even when no request is allowed.
      if (disposed || busy || document.visibilityState === 'hidden' || navigator.onLine === false) return
      if (!initial && enabledPollingOnly && !cache.isEnabled(scope)) return
      busy = true
      const controller = new AbortController()
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        // IPC does not forward AbortSignal: the race also bounds waiting and drops a late answer.
        const result = await Promise.race([
          Promise.all((JSON.parse(ids) as string[][]).map(batch => posApiGet<unknown>(
            `/api/pos/work-card/status?staff_ids=${batch.join(',')}`,
            { signal: controller.signal, cache: 'no-store', headers: { 'Cache-Control': 'no-store' } },
          ))),
          new Promise<null>(resolve => { timer = setTimeout(() => { controller.abort(); resolve(null) }, WORK_CARD_TIMEOUT_MS) }),
        ])
        if (disposed || current !== generation.current || !result) return
        for (const response of result) {
          if (!response.success || response.stale || response.source === 'cache') continue
          const data = parseWorkCardStatus(response.data)
          if (data) { cache.put(scope, data); publish(); setTimeout(publish, WORK_CARD_MAX_AGE_MS) }
        }
      } catch { /* An informational read never changes shift actions. */ }
      finally { clearTimeout(timer); busy = false }
    }
    const connection = () => { setOffline(navigator.onLine === false); void refresh(true) }
    const visibility = () => { if (document.visibilityState !== 'hidden') void refresh(true) }
    void refresh(true)
    const interval = setInterval(() => { void refresh() }, WORK_CARD_POLL_MS)
    window.addEventListener('online', connection)
    window.addEventListener('offline', connection)
    window.addEventListener('focus', visibility)
    document.addEventListener('visibilitychange', visibility)
    return () => {
      disposed = true
      clearInterval(interval)
      window.removeEventListener('online', connection)
      window.removeEventListener('offline', connection)
      window.removeEventListener('focus', visibility)
      document.removeEventListener('visibilitychange', visibility)
    }
  }, [active, ready, scope, ids, enabledPollingOnly])
  return { data: ready ? cache.read(scope) : null, offline, scope }
}
export function WorkCardLine({ status, staffId }: { status: ReturnType<typeof useWorkCardStatus>; staffId?: string | null }) {
  const { t, i18n } = useTranslation()
  const key = workCardLineKey(status.data, staffId, status.offline)
  if (!key) return null
  const person = status.data?.enabled ? status.data.staff.find(row => row.staff_id === staffId) : null
  const date = person?.sent_at ? new Date(person.sent_at) : null
  const time = date && Number.isFinite(date.getTime()) ? date.toLocaleTimeString(i18n.language, { hour: '2-digit', minute: '2-digit', hour12: false }) : '--'
  return <p role="status" data-testid="work-card-status" className="mt-2 rounded-lg bg-slate-100 px-3 py-2 text-sm text-slate-800 dark:bg-slate-800 dark:text-slate-100">{t(key, { time })}</p>
}
