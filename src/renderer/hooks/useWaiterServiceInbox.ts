import { useEffect, useRef, useState } from 'react'
import { useShift } from '../contexts/shift-context'
import { getSecureSessionSync } from '../lib/secure-session-cache'
import { getResolvedTerminalIdentity } from '../services/terminal-credentials'
import { posApiGet, posApiFetch, posApiPost } from '../utils/api-helpers'
import { onEvent, offEvent, emitCompatEvent } from '../../lib'
import { WaiterServiceInbox, emptyServiceInbox, pendingRecipientRequest, pendingMainResolution, unreadServiceRejections, serviceRequestOverview } from '../../../../shared/pos/tables/WaiterServiceInbox'
import { buildCustomerIntakeAssignment } from '../../../../shared/pos/tables/service-request-assignment'
import { buildMainServiceResolution, MainServiceResolutionRefused, mainResolutionRefusalCodes } from '../../../../shared/pos/tables/service-request-resolution'
import type { MainServiceResolutionAction } from '../../../../shared/types/waiter-service-request'
import { serviceRequestActor, serviceRequestIdentityMatches } from '../../../../shared/pos/tables/service-request-actor'

export function useWaiterServiceInbox(enabled: boolean) {
  const { staff, activeShift } = useShift()
  const [state, setState] = useState(emptyServiceInbox)
  const [available, setAvailable] = useState(false)
  const [observerStaffId, setObserverStaffId] = useState('')
  const ref = useRef<WaiterServiceInbox | null>(null)
  const session = getSecureSessionSync()
  const actor = serviceRequestActor(staff, activeShift)
  const loginKey = JSON.stringify([enabled, staff, activeShift?.id, activeShift?.status, actor?.staffId])
  const loginScope = useRef(loginKey); loginScope.current = loginKey
  const [mainCredential, setMainCredential] = useState<{ key: string; sessionId: string } | null>(null)
  useEffect(() => { setMainCredential(null) }, [loginKey])
  const authorizeMain = async (pin: string) => {
    if (!enabled || !state.isMain || !actor?.cashierPin || !/^\d{4,8}$/.test(pin)) throw new Error('SERVICE_LOGIN_REQUIRED')
    const key = loginKey
    if (!serviceRequestIdentityMatches(staff, await getResolvedTerminalIdentity()) || loginScope.current !== key) throw new Error('SERVICE_LOGIN_REQUIRED')
    const result = await posApiPost('pos/staff-auth/check-in', { staffId: actor.staffId, pin, sessionHours: 8 })
    if (!serviceRequestIdentityMatches(staff, await getResolvedTerminalIdentity()) || loginScope.current !== key
      || !result.success || !/^[a-f0-9-]{36}$/i.test(result.data?.session_id || '')) throw new Error('SERVICE_LOGIN_REQUIRED')
    // Session is held only in this surface's memory; terminal/admin identity and
    // the existing financial shift are never replaced by a service decision.
    setMainCredential({ key, sessionId: result.data.session_id })
  }
  useEffect(() => () => { loginScope.current = '' }, [])
  useEffect(() => {
    setState(emptyServiceInbox()); setAvailable(false); setObserverStaffId(''); let cancelled = false; let cleanup = () => {}
    if (!enabled) return
    void (async () => {
      const identity = await getResolvedTerminalIdentity()
      if (cancelled || !identity.organizationId || !identity.branchId || !identity.terminalId) return
      // Main's terminal credential can observe its whole inbox without a personal
      // shift. A recipient's decision still needs the exact staff scope and shift.
      const staffId = staff && identity.organizationId === staff.organizationId && identity.branchId === staff.branchId
        && identity.terminalId === staff.terminalId ? actor?.staffId || '' : ''
      const personalCredential = !actor?.cashierPin && typeof session?.sessionId === 'string' && /^[a-f0-9-]{36}$/i.test(session.sessionId) ? session.sessionId : null
      const credential = staffId ? mainCredential?.key === loginKey ? mainCredential.sessionId : personalCredential : null
      const options = credential ? { headers: { 'x-staff-session-id': credential } } : {}
      const inbox = new WaiterServiceInbox({ organizationId: identity.organizationId, branchId: identity.branchId, terminalId: identity.terminalId, staffId }, {
        read: async key => localStorage.getItem(key), write: async (key,value) => { localStorage.setItem(key,value) },
        publish: next => { if (!cancelled) setState(next) }, eventId: () => `waiter-decision:${crypto.randomUUID()}`,
        onCanonicalChange: () => { if (!cancelled) emitCompatEvent('table-session-balance-updated', {}) },
        onConfirmed: receipt => { if (!cancelled && receipt.status === 'accepted') emitCompatEvent('table-session-balance-updated', {}) },
        fetch: async () => { const result = await posApiGet('pos/waiter-service-requests', options)
          if (!result.success || result.stale || result.data?.success !== true) throw new Error('SERVICE_INBOX_UNAVAILABLE')
          if (result.data.requires_staff_login) throw new Error('SERVICE_LOGIN_REQUIRED')
          return { requests: result.data.requests, recipientStaffId: result.data.recipient_staff_id,waiters:result.data.waiters||[],sourceTerminalId:result.data.request_source_terminal_id,
            isMain:result.data.is_main,resolutionSourceTerminalId:result.data.resolution_source_terminal_id,resolutionHistory:result.data.resolutions||[] } },
        onResolutionConfirmed:receipt=>{if(receipt.affected_session_ids.some(id=>typeof id==='string'))emitCompatEvent('table-session-balance-updated',{})},
        resolve:async intent=>{
          const result=await posApiFetch('pos/waiter-service-requests',{...options,method:'POST',body:JSON.stringify(buildMainServiceResolution(intent))})
          const code = result.code || result.data?.code
          if(code==='TABLE_SERVICE_VERIFIED_MAIN_REQUIRED')throw new Error('SERVICE_LOGIN_REQUIRED')
          if((!result.success||result.data?.success===false)&&mainResolutionRefusalCodes.has(code))throw new MainServiceResolutionRefused(code)
          if(!result.success||result.data?.success!==true)throw new Error('SERVICE_RESOLUTION_UNCONFIRMED')
          return result.data.resolution
        },
        assign:async intent=>{
          const result=await posApiFetch('pos/waiter-service-requests',{...options,method:'POST',
            body:JSON.stringify(buildCustomerIntakeAssignment(intent.intakeId,intent.recipientStaffId,intent.eventId))})
          if(!result.success||result.data?.success!==true)throw new Error('SERVICE_ASSIGNMENT_UNCONFIRMED')
          return result.data.service_request
        },
        decide: async intent => { const result = await posApiFetch('pos/waiter-service-requests', { ...options, method: 'POST', body: JSON.stringify({
          request_id: intent.requestId, decision: intent.decision, client_event_id: intent.eventId }) })
          if ((result.code || result.data?.code) === 'TABLE_SERVICE_VERIFIED_RECIPIENT_REQUIRED') throw new Error('SERVICE_LOGIN_REQUIRED')
          if (!result.success || result.data?.success !== true) throw new Error('SERVICE_DECISION_UNCONFIRMED')
          return result.data.service_request },
      })
      ref.current = inbox
      setObserverStaffId(staffId)
      setAvailable(true)
      let refreshing = false
      const refresh = () => { if (cancelled || refreshing || document.visibilityState === 'hidden') return
        refreshing = true; void inbox.refresh().finally(() => { refreshing = false }) }
      const interval = setInterval(refresh, 3000)
      window.addEventListener('online', refresh); document.addEventListener('visibilitychange', refresh)
      const hint = () => refresh(); const subscriptions = ['table_realtime_update','order_realtime_update']
      for (const event of subscriptions) onEvent(event, hint)
      cleanup = () => { clearInterval(interval); window.removeEventListener('online',refresh); document.removeEventListener('visibilitychange',refresh)
        for (const event of subscriptions) offEvent(event,hint); inbox.stop(); if (ref.current === inbox) ref.current = null }
      refresh()
    })().catch(() => { if (!cancelled) setState(current => ({ ...current, stale: true })) })
    return () => { cancelled = true; cleanup() }
  }, [enabled, staff?.staffId, staff?.databaseStaffId, staff?.organizationId, staff?.branchId, staff?.terminalId, activeShift?.id, activeShift?.status, session?.sessionId, actor?.staffId, loginKey, mainCredential])
  const canDecide = enabled && !!staff && !!observerStaffId && activeShift?.status === 'active'
  return { ...state, available: enabled && available, current: canDecide ? pendingRecipientRequest(state, staff?.databaseStaffId || staff?.staffId || '') : null,
    mainCurrent:canDecide?pendingMainResolution(state):null,canResolve:canDecide&&state.isMain&&!state.stale&&state.recipientStaffId===observerStaffId&&!!observerStaffId,
    mainLogin: state.isMain && actor?.cashierPin ? actor : null, authorizeMain,
    resolve:(id:string,action:MainServiceResolutionAction,recipient:string|null=null,reason='')=>canDecide?ref.current?.resolve(id,action,recipient,reason):undefined,
    rejections: enabled ? unreadServiceRejections(state, observerStaffId) : [],
    overviewRequests: serviceRequestOverview(state, observerStaffId),
    acknowledgeRejection: (id: string) => enabled ? ref.current?.acknowledgeRejection(id) : undefined,
    choose: (id: string, decision: 'accepted' | 'rejected') => canDecide ? ref.current?.choose(id,decision) : undefined, retry: () => ref.current?.refresh(),
    assign:(id:string,recipient:string)=>canDecide?ref.current?.assign(id,recipient):undefined,canAssign:canDecide }
}
