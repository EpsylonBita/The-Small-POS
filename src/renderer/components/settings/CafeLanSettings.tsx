import React, { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { getBridge } from '../../../lib'
import { posApiGet } from '../../utils/api-helpers'
import { liquidGlassModalButton } from '../../styles/designSystem'
import { ConfirmDialog } from '../ui/ConfirmDialog'

type Child = { terminal_id: string; name: string | null; terminal_type: string }
type Status = { running: boolean; port: number }
type Pair = { secret_hex: string; source_terminal_id: string; [key: string]: unknown }
const key = (name: string) => `settings.cafeLan.${name}`

export function CafeLanSettings({ isMain }: { isMain: boolean }) {
  const { t } = useTranslation()
  const [children, setChildren] = useState<Child[]>([])
  const [childId, setChildId] = useState('')
  const [host, setHost] = useState('')
  const [status, setStatus] = useState<Status>({ running: false, port: 8765 })
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(false)
  const [confirmation, setConfirmation] = useState<'pair' | 'revoke' | null>(null)

  const refresh = useCallback(async () => {
    if (!isMain) return
    setBusy(true); setError(false)
    try {
      const response = await posApiGet<{ success: boolean; children: Child[] }>('/api/pos/lan/validate')
      if (!response.success || response.data?.success !== true || !Array.isArray(response.data.children)) throw new Error('PAIRING_UNAVAILABLE')
      setChildren(response.data.children.filter(child => child.terminal_type === 'mobile_waiter'))
      setStatus(await getBridge().invoke('lan_transport_status'))
    } catch { setError(true); setChildren([]) } finally { setBusy(false) }
  }, [isMain])
  useEffect(() => { void refresh() }, [refresh])
  useEffect(() => {
    if (!code) return
    const timeout = setTimeout(() => setCode(''), 5 * 60 * 1000)
    return () => clearTimeout(timeout)
  }, [code])
  useEffect(() => { setCode('') }, [childId, host])
  useEffect(() => { setCode('') }, [isMain])

  const run = async (action: () => Promise<void>) => {
    setBusy(true); setError(false)
    try { await action() } catch { setError(true); setCode('') } finally { setBusy(false) }
  }
  const confirm = async () => {
    const action = confirmation
    setConfirmation(null)
    await run(async () => {
      if (action === 'pair') {
        const pair: Pair = await getBridge().invoke('lan_transport_pair', { child_terminal_id: childId })
        if (!/^[0-9a-f]{64}$/.test(pair.secret_hex) || pair.source_terminal_id !== childId) throw new Error('INVALID_PAIR')
        // The enrollment secret stays in memory; the native command owns encrypted storage.
        setCode(JSON.stringify({ ...pair, parent_host: host.trim() }))
      } else if (action === 'revoke') {
        await getBridge().invoke('lan_transport_revoke', { child_terminal_id: childId })
        setCode('')
      }
    })
  }
  return <section className="rounded-2xl border liquid-glass-modal-border p-4 space-y-3" aria-labelledby="cafe-lan-title">
    <h3 id="cafe-lan-title" className="font-semibold liquid-glass-modal-text">{t(key('title'))}</h3>
    <p className="text-sm liquid-glass-modal-text-muted">{t(key('internetRequired'))}</p>
    {!isMain ? <p className="text-sm liquid-glass-modal-text">{t(key('desktopMainOnly'))}</p> : <>
      <p className="text-sm liquid-glass-modal-text">{t(key(status.running ? 'listening' : 'stopped'))} · {t(key('port'))}: {status.port}</p>
      <div className="flex gap-2 flex-wrap">
        <button type="button" disabled={busy} className={liquidGlassModalButton('secondary', 'sm')} onClick={() => void refresh()}>{t(key('refresh'))}</button>
        <button type="button" disabled={busy} className={liquidGlassModalButton('primary', 'sm')} onClick={() => void run(async () => {
          await getBridge().invoke(status.running ? 'lan_transport_stop' : 'lan_transport_start')
          setStatus(await getBridge().invoke('lan_transport_status'))
        })}>{t(key(status.running ? 'stop' : 'start'))}</button>
      </div>
      <label className="block text-sm liquid-glass-modal-text">{t(key('child'))}
        <select value={childId} onChange={event => setChildId(event.target.value)} disabled={busy} className="liquid-glass-modal-input mt-1 w-full">
          <option value="">{t(key('selectChild'))}</option>
          {children.map(child => <option key={child.terminal_id} value={child.terminal_id}>{child.name || child.terminal_id}</option>)}
        </select>
      </label>
      {!busy && !error && children.length === 0 && <p className="text-sm liquid-glass-modal-text-muted">{t(key('noChildren'))}</p>}
      <label className="block text-sm liquid-glass-modal-text">{t(key('host'))}
        <input value={host} onChange={event => setHost(event.target.value)} disabled={busy} placeholder="192.168.1.10" spellCheck={false} autoComplete="off" className="liquid-glass-modal-input mt-1 w-full" />
      </label>
      <div className="flex gap-2 flex-wrap">
        <button type="button" disabled={busy || !childId || !host.trim()} className={liquidGlassModalButton('primary', 'sm')} onClick={() => setConfirmation('pair')}>{t(key('generate'))}</button>
        <button type="button" disabled={busy || !childId} className={liquidGlassModalButton('secondary', 'sm')} onClick={() => setConfirmation('revoke')}>{t(key('revoke'))}</button>
      </div>
      {code && <div className="space-y-2">
        <p className="text-sm liquid-glass-modal-text-muted">{t(key('codeHelp'))}</p>
        <textarea aria-label={t(key('code'))} value={code} readOnly spellCheck={false} autoComplete="off" className="liquid-glass-modal-input w-full font-mono text-xs" rows={5} />
        <button type="button" className={liquidGlassModalButton('secondary', 'sm')} onClick={() => void run(async () => { await getBridge().clipboard.writeText(code) })}>{t(key('copy'))}</button>
        <button type="button" className={liquidGlassModalButton('secondary', 'sm')} onClick={() => setCode('')}>{t(key('hide'))}</button>
      </div>}
    </>}
    {error && <p role="alert" className="text-sm text-red-600 dark:text-red-300">{t(key('failed'))}</p>}
    <ConfirmDialog isOpen={confirmation !== null} title={t(key(confirmation === 'revoke' ? 'revoke' : 'generate'))}
      message={t(key('rotationHelp'))} onClose={() => setConfirmation(null)} onConfirm={() => void confirm()} />
  </section>
}
