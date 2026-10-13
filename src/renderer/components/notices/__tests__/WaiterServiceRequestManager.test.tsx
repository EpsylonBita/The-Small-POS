import React from 'react'
import { render,fireEvent,cleanup,act } from '@testing-library/react'
import { afterEach,it,expect,vi } from 'vitest'
import { WaiterServiceRequestManager } from '../WaiterServiceRequestManager'
const mocks=vi.hoisted(()=>({inbox:null as any}))
vi.mock('../../../hooks/useWaiterServiceInbox',()=>({useWaiterServiceInbox:()=>mocks.inbox}))
vi.mock('../../../contexts/shift-context',()=>({useShift:()=>({staff:{staffId:'Cashier'}})}))
vi.mock('../../../lib/secure-session-cache',()=>({getSecureSessionSync:()=>null,setSecureSession:vi.fn()}))
vi.mock('../../../utils/api-helpers',()=>({posApiPost:vi.fn()}))
vi.mock('react-i18next',()=>({useTranslation:()=>({t:(key:string)=>key})}))
vi.mock('../../ui/pos-glass-components',()=>({LiquidGlassModal:({isOpen,children}:any)=>isOpen?<div>{children}</div>:null}))
afterEach(()=>cleanup())
it.each(['reject_final','reassign','main_items'])('keeps confirmed %s history visible without offering a second action',action=>{
 const resolve=vi.fn()
 mocks.inbox={available:true,isMain:true,current:null,mainCurrent:null,requests:[],decisions:{},stale:false,busy:false,resolve,
  resolutionHistory:[{id:'receipt',action,actor_name:'Main Cashier',reason:'Reviewed request',summary:{table_number:'3',order_label:'ORD',
   order_created_at:'2026-10-11T18:00:00Z',items:[{name:'Beer',quantity:2,notes:'Terrace'}]}}]}
 const ui=render(<WaiterServiceRequestManager enabled/>);
 expect(ui.queryByTestId('waiter-service-overview')).toBeNull()
 act(()=>{window.dispatchEvent(new CustomEvent('waiter-service-overview-open'))})
 expect(ui.getByTestId('main-service-resolution-history')).toBeTruthy()
 expect(ui.getByText(`waiterService.resolutionStatus.${action}`)).toBeTruthy()
 expect(ui.getByText('Main Cashier')).toBeTruthy();expect(ui.getByText('Reviewed request')).toBeTruthy()
 expect(ui.getByText('2 × Beer · Terrace')).toBeTruthy()
 expect(ui.queryByText('waiterService.empty')).toBeNull();expect(ui.queryByTestId('main-service-actions')).toBeNull()
 expect(resolve).not.toHaveBeenCalled()
})
it('automatically opens Main resolution with request takeover and reasoned final rejection',()=>{
 const resolve=vi.fn(),acknowledgeRejection=vi.fn()
 const request={id:'returned',recipient_staff_id:'Ana',resolution_required:true,status:'rejected',kind:'append_items',
  summary:{table_number:'3',order_label:'ORD',requester_name:'Luca',recipient_name:'Ana',items:[{name:'Beer',quantity:2}]}}
 mocks.inbox={available:true,isMain:true,current:null,mainCurrent:request,requests:[request],decisions:{},resolutions:{},
  recipientStaffId:'Main',rejections:[request],stale:false,busy:false,canResolve:true,waiters:[{id:'Ana',name:'Ana'},{id:'Luca',name:'Luca'},{id:'Main',name:'Main actor'}],resolve,acknowledgeRejection}
 const ui=render(<WaiterServiceRequestManager enabled/>);
 expect(ui.queryByTestId('main-service-check')).toBeNull();
 expect(ui.queryByRole('option',{name:'Main actor'})).toBeNull()
 expect(ui.getByTestId('main-service-actions')).toBeTruthy();expect(ui.queryByTestId('waiter-service-ack-returned')).toBeNull()
 fireEvent.click(ui.getByTestId('main-service-items'));expect(resolve).toHaveBeenCalledWith('returned','main_items')
 fireEvent.click(ui.getByTestId('main-service-final-reject'));expect(resolve).toHaveBeenCalledTimes(1)
 fireEvent.change(ui.getByTestId('main-service-reason'),{target:{value:'Unavailable'}})
 fireEvent.click(ui.getByTestId('main-service-final-reject'));expect(resolve).toHaveBeenLastCalledWith('returned','reject_final',null,'Unavailable')
 fireEvent.change(ui.getByTestId('main-service-recipient'),{target:{value:'Luca'}})
 fireEvent.click(ui.getByTestId('main-service-reassign'));expect(resolve).toHaveBeenLastCalledWith('returned','reassign','Luca')
 expect(acknowledgeRejection).not.toHaveBeenCalled()
})
it('shows a persistent rejection notice and acknowledges only the reviewed receipt',()=>{
 const acknowledgeRejection=vi.fn(),choose=vi.fn(),assign=vi.fn()
 const rejected={id:'rejected-round',status:'rejected',kind:'append_items',summary:{table_number:'B02',order_label:'ORD 17:29',requester_name:'Luca',recipient_name:'Ana',items:[{name:'Beer',quantity:2}]}}
 mocks.inbox={available:true,actionable:true,current:null,requests:[rejected],overviewRequests:[rejected],rejections:[rejected],decisions:{},stale:false,busy:false,acknowledgeRejection,choose,assign}
 const ui=render(<WaiterServiceRequestManager enabled/>);
 expect(ui.getByTestId('waiter-service-rejection-alert')).toBeTruthy()
 fireEvent.click(ui.getByTestId('waiter-service-rejection-alert'))
 expect(acknowledgeRejection).not.toHaveBeenCalled()
 expect(ui.getByText('2 × Beer')).toBeTruthy();expect(ui.getByText('waiterService.status.rejected')).toBeTruthy()
 fireEvent.click(ui.getByTestId('waiter-service-ack-rejected-round'))
 expect(acknowledgeRejection).toHaveBeenCalledWith('rejected-round')
 expect(choose).not.toHaveBeenCalled();expect(assign).not.toHaveBeenCalled()
 mocks.inbox={...mocks.inbox,rejections:[]};ui.rerender(<WaiterServiceRequestManager enabled/>)
 expect(ui.queryByTestId('waiter-service-rejection-alert')).toBeNull()
 expect(ui.getByText('waiterService.status.rejected')).toBeTruthy()
})
it('keeps an incoming recipient decision in front of rejection history',()=>{
 const pending={id:'incoming',status:'pending',kind:'append_items',summary:{table_number:'3',order_label:'ORD',requester_name:'B',recipient_name:'A',items:[]}}
 mocks.inbox={available:true,actionable:true,current:pending,requests:[pending],rejections:[{...pending,id:'old',status:'rejected'}],decisions:{},stale:false,busy:false}
 const ui=render(<WaiterServiceRequestManager enabled/>);fireEvent.click(ui.getByTestId('waiter-service-rejection-alert'))
 expect(ui.getByTestId('waiter-service-accept')).toBeTruthy()
 expect(ui.queryByTestId('waiter-service-ack-old')).toBeNull()
})
it('Main reviews the QR request and explicitly chooses its waiter',()=>{
 const assign=vi.fn()
 mocks.inbox={available:true,actionable:true,current:null,requests:[{id:'intake',intake_id:'intake',assignment_required:true,recipient_staff_id:'',status:'pending',kind:'append_items',
   summary:{table_number:'3',order_label:'ORD',requester_name:'QR',recipient_name:'',customer_notes:'Terrace please',items:[{name:'Beer',quantity:2}]}}],
  decisions:{},assignments:{},waiters:[{id:'Ana',name:'Ana Novak'},{id:'Luca',name:'Luca Weiss'}],stale:false,busy:false,assign,canAssign:true}
 const ui=render(<WaiterServiceRequestManager enabled/>);fireEvent.click(ui.getByTestId('waiter-service-overview'))
 expect(ui.getByText('2 × Beer')).toBeTruthy();expect(ui.getByText('Terrace please')).toBeTruthy()
 expect(ui.queryByTestId('waiter-service-accept')).toBeNull()
 fireEvent.change(ui.getByTestId('waiter-intake-recipient-intake'),{target:{value:'Luca'}})
 fireEvent.click(ui.getByTestId('waiter-intake-assign-intake'))
 expect(assign).toHaveBeenCalledWith('intake','Luca')
})

it('shows no chip for an unverified, empty or not-applicable inbox (founder, 13/10/2026)',()=>{
 for (const state of [{stale:true},{stale:false},{stale:false,serviceEnabled:false}]) {
  mocks.inbox={available:true,actionable:false,current:null,mainCurrent:null,requests:[],decisions:{},busy:false,resolutionHistory:[],...state}
  const ui=render(<WaiterServiceRequestManager enabled/>)
  expect(ui.queryByTestId('waiter-service-overview')).toBeNull();expect(ui.queryByText('…',{exact:false})).toBeNull()
  cleanup()
 }
})
it('opens the full list from the settings event and never shows an ellipsis count',()=>{
 const pending={id:'p1',recipient_staff_id:'Ana',status:'pending',kind:'append_items',created_at:'2026-10-13T08:00:00Z',
  summary:{table_number:'3',order_label:'ORD',requester_name:'Luca',recipient_name:'Ana',items:[{name:'Beer',quantity:2}]}}
 mocks.inbox={available:true,actionable:true,current:null,mainCurrent:null,requests:[pending],overviewRequests:[pending],decisions:{},stale:true,busy:false,resolutionHistory:[]}
 const ui=render(<WaiterServiceRequestManager enabled/>)
 expect(ui.getByTestId('waiter-service-overview').textContent).toBe('waiterService.requests · 1')
 cleanup()
 mocks.inbox={...mocks.inbox,actionable:false,requests:[],overviewRequests:[],stale:false}
 const settings=render(<WaiterServiceRequestManager enabled/>)
 expect(settings.queryByTestId('waiter-service-dialog')).toBeNull()
 act(()=>{window.dispatchEvent(new CustomEvent('waiter-service-overview-open'))})
 expect(settings.getByTestId('waiter-service-dialog')).toBeTruthy()
})
