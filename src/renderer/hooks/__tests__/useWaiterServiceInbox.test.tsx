import { cleanup, renderHook, waitFor, act } from '@testing-library/react'
import { beforeEach, afterEach, it, expect, vi } from 'vitest'
import { useWaiterServiceInbox } from '../useWaiterServiceInbox'
import { emitCompatEvent } from '../../../lib'
const mocks = vi.hoisted(() => ({ staff: null as any, shift: null as any, session:null as any, get: vi.fn(), post: vi.fn(), events: new Map<string, any>() }))
vi.mock('../../contexts/shift-context', () => ({ useShift: () => ({ staff: mocks.staff, activeShift: mocks.shift }) }))
vi.mock('../../lib/secure-session-cache', () => ({ getSecureSessionSync: () => mocks.session }))
vi.mock('../../services/terminal-credentials', () => ({ getResolvedTerminalIdentity: async () => ({ organizationId:'org', branchId:'branch', terminalId:'main' }) }))
vi.mock('../../utils/api-helpers', () => ({ posApiGet: mocks.get, posApiFetch: mocks.post, posApiPost:mocks.post }))
vi.mock('../../../lib', () => ({ onEvent:(e:string,f:any)=>mocks.events.set(e,f),offEvent:(e:string)=>mocks.events.delete(e),emitCompatEvent:vi.fn() }))
const request = { id:'request', table_session_id:'check', recipient_staff_id:'Ana', actor_staff_id:'Luca', source_terminal_id:'phone-b', kind:'append_items', status:'pending', created_at:'2026-10-10', decided_at:null,
 summary:{table_number:'3',order_label:'ORD 18:29',requester_name:'Luca',recipient_name:'Ana',items:[{name:'Beer',quantity:2}]} }
beforeEach(()=>{ localStorage.clear(); mocks.staff=null; mocks.shift=null; mocks.session=null;mocks.events.clear(); mocks.get.mockReset(); mocks.post.mockReset();
 mocks.get.mockResolvedValue({success:true,data:{success:true,requests:[request],recipient_staff_id:null}}) })
afterEach(()=>cleanup())
it('refreshes Main table views when polling observes a remote acceptance, without a mutation or realtime event', async()=>{
 vi.mocked(emitCompatEvent).mockClear()
 const {result}=renderHook(()=>useWaiterServiceInbox(true))
 await waitFor(()=>expect(result.current.requests[0]?.status).toBe('pending'))
 expect(emitCompatEvent).not.toHaveBeenCalled()
 mocks.get.mockResolvedValue({success:true,data:{success:true,requests:[{...request,status:'accepted'}],recipient_staff_id:null}})
 await act(async()=>{await result.current.retry()})
 expect(emitCompatEvent).toHaveBeenCalledExactlyOnceWith('table-session-balance-updated',{})
 await act(async()=>{await result.current.retry()})
 expect(emitCompatEvent).toHaveBeenCalledTimes(1)
 expect(mocks.post).not.toHaveBeenCalled()
})
it.each(['TABLE_SERVICE_RESOLUTION_STALE','TABLE_SERVICE_VERIFIED_MAIN_REQUIRED'])('recognizes native top-level refusal %s without losing the original resolution',async code=>{
 mocks.staff={staffId:'Cashier',name:'Main',role:'cashier',organizationId:'org',branchId:'branch',terminalId:'main'};mocks.shift={id:'shift',status:'active'}
 const returned={...request,status:'rejected',resolution_required:true}
 mocks.get.mockResolvedValue({success:true,data:{success:true,is_main:true,requests:[returned],recipient_staff_id:'Cashier',resolution_source_terminal_id:'main-public'}})
 mocks.post.mockResolvedValue({success:false,status:code==='TABLE_SERVICE_RESOLUTION_STALE'?409:403,code,error:'Canonical refusal'})
 const {result}=renderHook(()=>useWaiterServiceInbox(true));await waitFor(()=>expect(result.current.canResolve).toBe(true))
 await act(async()=>{await result.current.resolve(request.id,'reject_final',null,'No stock')})
 expect(mocks.post).toHaveBeenCalledTimes(1)
 if(code==='TABLE_SERVICE_RESOLUTION_STALE') expect(result.current.resolutions[request.id].refusal).toBe(code)
 else {expect(result.current.failure).toBe('SERVICE_LOGIN_REQUIRED');expect(result.current.resolutions[request.id].eventId).toBeTruthy()}
})
it('offers the active cashier PIN for legacy Main login without replacing identity, shift or submitting a resolution',async()=>{
 const login='6968dc6c-bf21-499c-85a8-f4d596003d58'
 mocks.staff={staffId:'admin-user',name:'Terminal',role:'admin',organizationId:'org',branchId:'branch',terminalId:'main'}
 mocks.shift={id:'shift',status:'active',staff_id:'Cashier',staff_name:'Main Cashier',role_type:'cashier',branch_id:'branch',terminal_id:'main'}
 const originalStaff=mocks.staff,originalShift=mocks.shift
 mocks.get.mockImplementation(async(_path,options)=>({success:true,data:{success:true,is_main:true,
  requests:[{...request,status:'rejected',resolution_required:true}],recipient_staff_id:options.headers?.['x-staff-session-id']===login?'Cashier':null}}))
 mocks.post.mockResolvedValue({success:true,data:{session_id:login}})
 const {result,unmount}=renderHook(()=>useWaiterServiceInbox(true))
 await waitFor(()=>expect(result.current.failure).toBe('SERVICE_LOGIN_REQUIRED'))
 expect(result.current.mainCurrent?.id).toBe(request.id);expect(result.current.canResolve).toBe(false)
 expect(result.current.mainLogin?.name).toBe('Main Cashier')
 await act(async()=>{await result.current.authorizeMain('1111')})
 await waitFor(()=>expect(result.current.canResolve).toBe(true))
 expect(mocks.post).toHaveBeenCalledExactlyOnceWith('pos/staff-auth/check-in',{staffId:'Cashier',pin:'1111',sessionHours:8})
 expect(mocks.staff).toBe(originalStaff);expect(mocks.shift).toBe(originalShift)
 expect(JSON.stringify(localStorage)).not.toContain(login)
 unmount();const restarted=renderHook(()=>useWaiterServiceInbox(true))
 await waitFor(()=>expect(restarted.result.current.failure).toBe('SERVICE_LOGIN_REQUIRED'))
 expect(restarted.result.current.canResolve).toBe(false)
})
it('discards delayed Main PIN authorization after the current shift closes',async()=>{
 mocks.staff={staffId:'admin-user',name:'Terminal',role:'admin',organizationId:'org',branchId:'branch',terminalId:'main'}
 mocks.shift={id:'shift',status:'active',staff_id:'Cashier',staff_name:'Main Cashier',role_type:'cashier',branch_id:'branch',terminal_id:'main'}
 mocks.get.mockResolvedValue({success:true,data:{success:true,is_main:true,requests:[{...request,status:'rejected',resolution_required:true}],recipient_staff_id:null}})
 let finish!:(value:any)=>void;mocks.post.mockImplementation(()=>new Promise(resolve=>{finish=resolve}))
 const {result,rerender}=renderHook(()=>useWaiterServiceInbox(true));await waitFor(()=>expect(result.current.mainLogin).toBeTruthy())
 let attempt!:Promise<unknown>;await act(async()=>{attempt=result.current.authorizeMain('1111').catch(e=>e.message)})
 mocks.shift={...mocks.shift,status:'closed'};rerender()
 await act(async()=>{finish({success:true,data:{session_id:'6968dc6c-bf21-499c-85a8-f4d596003d58'}});expect(await attempt).toBe('SERVICE_LOGIN_REQUIRED')})
 expect(result.current.canResolve).toBe(false);expect(result.current.mainCurrent).toBeNull()
 expect(mocks.get.mock.calls.every(([,options])=>!options.headers)).toBe(true)
})
it('a legacy observer acknowledges a rejection locally, retaining the result after refresh and remount',async()=>{
 mocks.get.mockResolvedValue({success:true,data:{success:true,requests:[{...request,status:'rejected',decided_at:'2026-10-11T17:00:00Z'}],recipient_staff_id:null}})
 const one=renderHook(()=>useWaiterServiceInbox(true));await waitFor(()=>expect(one.result.current.rejections).toHaveLength(1))
 await act(async()=>{await one.result.current.acknowledgeRejection(request.id)})
 expect(one.result.current.rejections).toEqual([]);expect(mocks.post).not.toHaveBeenCalled();one.unmount()
 const two=renderHook(()=>useWaiterServiceInbox(true));await waitFor(()=>expect(two.result.current.stale).toBe(false))
 expect(two.result.current.rejections).toEqual([]);expect(two.result.current.requests[0].status).toBe('rejected')
})
it('keeps Main history readable without an active shift without trapping it in a disabled modal',async()=>{
 mocks.get.mockResolvedValue({success:true,data:{success:true,is_main:true,requests:[{...request,status:'rejected',resolution_required:true}],recipient_staff_id:null}})
 const {result}=renderHook(()=>useWaiterServiceInbox(true));await waitFor(()=>expect(result.current.isMain).toBe(true))
 expect(result.current.mainCurrent).toBeNull();expect(result.current.canResolve).toBe(false);expect(result.current.requests).toHaveLength(1)
})
it('sends final rejection with the device-bound Main PIN and exact reason',async()=>{
 const login='6968dc6c-bf21-499c-85a8-f4d596003d58'
 mocks.staff={staffId:'Cashier',organizationId:'org',branchId:'branch',terminalId:'main'};mocks.shift={id:'shift',status:'active'};mocks.session={sessionId:login}
 const returned={...request,id:'main-returned',status:'rejected',resolution_required:true}
 mocks.get.mockResolvedValue({success:true,data:{success:true,is_main:true,requests:[returned],recipient_staff_id:'Cashier',resolution_source_terminal_id:'main-public'}})
 mocks.post.mockImplementation(async(_path:string,options:any)=>{
  const body=JSON.parse(options.body)
  return {success:true,data:{success:true,resolution:{id:'resolution',request_id:body.request_id,intake_id:null,action:body.resolution,
   recipient_staff_id:null,actor_staff_id:'Cashier',actor_shift_id:'shift',source_terminal_id:'main-public',client_event_id:body.client_event_id,
   reason:body.reason,created_at:'2026-10-11',successor_request_id:null,affected_session_ids:[]}}}
 })
 const {result}=renderHook(()=>useWaiterServiceInbox(true));await waitFor(()=>expect(result.current.mainCurrent?.id).toBe('main-returned'))
 await act(async()=>{await result.current.resolve('main-returned','reject_final',null,'No stock')})
 expect(mocks.post).toHaveBeenCalledTimes(1)
 expect(mocks.post.mock.calls[0][1].headers).toEqual({'x-staff-session-id':login})
 expect(JSON.parse(mocks.post.mock.calls[0][1].body)).toEqual({action:'resolve',request_id:'main-returned',resolution:'reject_final',recipient_staff_id:null,reason:'No stock',client_event_id:expect.any(String)})
 expect(result.current.mainCurrent).toBeNull();expect(result.current.resolutions).toEqual({})
})
it('Main reads and displays request history without a personal staff shift',async()=>{
 const {result}=renderHook(()=>useWaiterServiceInbox(true))
 await waitFor(()=>expect(result.current.requests).toEqual([request]))
 expect(result.current.available).toBe(true); expect(result.current.current).toBeNull()
 await act(async()=>{await result.current.choose(request.id,'accepted')}); expect(mocks.post).not.toHaveBeenCalled()
})
it('a closed recipient shift can view pending requests but cannot accept',async()=>{
 mocks.staff={staffId:'Ana',organizationId:'org',branchId:'branch',terminalId:'main'}; mocks.shift={id:'old',status:'closed'}
 mocks.get.mockResolvedValue({success:true,data:{success:true,requests:[request],recipient_staff_id:'Ana'}})
 const {result}=renderHook(()=>useWaiterServiceInbox(true)); await waitFor(()=>expect(result.current.stale).toBe(false))
 expect(result.current.current).toBeNull();await act(async()=>{await result.current.choose(request.id,'accepted')});expect(mocks.post).not.toHaveBeenCalled()
})
it('an active verified recipient gets the modal, and logout stops the observer',async()=>{
 mocks.staff={staffId:'Ana',organizationId:'org',branchId:'branch',terminalId:'main'};mocks.shift={id:'shift',status:'active'}
 mocks.get.mockResolvedValue({success:true,data:{success:true,requests:[request],recipient_staff_id:'Ana'}})
 const {result,rerender}=renderHook(({enabled})=>useWaiterServiceInbox(enabled),{initialProps:{enabled:true}})
 await waitFor(()=>expect(result.current.current?.id).toBe('request'));rerender({enabled:false})
 expect(result.current.available).toBe(false);expect(result.current.current).toBeNull();expect(mocks.events.size).toBe(0)
})
it('Main sends one retained assignment using the server canonical source and its active roster',async()=>{
 mocks.staff={staffId:'Cashier',organizationId:'org',branchId:'branch',terminalId:'main'};mocks.shift={id:'shift',status:'active'}
 const intake={...request,id:'intake',intake_id:'intake',assignment_required:true,recipient_staff_id:'',source_terminal_id:'main-canonical'}
 mocks.get.mockResolvedValue({success:true,data:{success:true,requests:[intake],recipient_staff_id:'Cashier',request_source_terminal_id:'main-canonical',waiters:[{id:'Ana',name:'Ana'}]}})
 mocks.post.mockImplementation(async(_path:string,options:any)=>({success:true,data:{success:true,service_request:{...request,id:'assignment',intake_id:'intake',source_terminal_id:'main-canonical',assignment_event_id:JSON.parse(options.body).client_event_id}}}))
 const {result}=renderHook(()=>useWaiterServiceInbox(true));await waitFor(()=>expect(result.current.stale).toBe(false))
 await act(async()=>{await (result.current as any).assign('intake','Ana')})
 expect(mocks.post).toHaveBeenCalledTimes(1)
 expect(JSON.parse(mocks.post.mock.calls[0][1].body)).toEqual({action:'assign_intake',intake_id:'intake',recipient_staff_id:'Ana',client_event_id:expect.any(String)})
})
