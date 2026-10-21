import { beforeEach, describe, expect, it, vi } from 'vitest';
const mock=vi.hoisted(()=>({get:vi.fn(),post:vi.fn(),save:vi.fn(),force:vi.fn(),snapshot:vi.fn(),unsaved:vi.fn(),print:vi.fn(),setting:vi.fn()}));
vi.mock('../../utils/api-helpers',()=>({posApiGet:mock.get,posApiPost:mock.post}));
vi.mock('../../../lib',()=>({getBridge:()=>({orders:{saveFromRemote:mock.save},sync:{force:mock.force},payments:{getSettlementSnapshot:mock.snapshot,listUnsavedPayments:mock.unsaved},printer:{submitJob:mock.print},terminalConfig:{getBranchId:async()=>'branch'},settings:{get:mock.setting}})}));
import { prepareHotelSettlement,cancelHotelSettlement,cancelPreparedHotelSettlement,postHotelCharge,folioStatementDocument,printHotelFolio,hotelErrorCode } from '../HotelSettlementService';
const folio='33333333-3333-4333-8333-333333333333';
const local='22222222-2222-4222-8222-222222222222';
const remote='11111111-1111-4111-8111-111111111111';
const summary={success:true,folio:{id:folio,currency:'CHF',balance_cents:15000},collectible_cents:15000,open_settlement:null as any};
const prepared={success:true,total_cents:15000,order:{id:remote,client_order_id:local,folio_id:folio,order_context:'folio_settlement',currency:'CHF'},items:[{folio_line_kind:'revenue',total_price:100},{folio_line_kind:'transfer',total_price:50}]};
beforeEach(()=>{vi.clearAllMocks();localStorage.clear();mock.get.mockResolvedValue({success:true,data:summary});mock.post.mockResolvedValue({success:true,data:prepared});mock.save.mockResolvedValue({success:true,orderId:local});mock.force.mockResolvedValue(undefined);mock.snapshot.mockResolvedValue({success:true,orderTotal:150,netPaid:0,outstandingAmount:150,completedPayments:[]});mock.unsaved.mockResolvedValue({success:true,payments:[]});});
describe('hotel collection uses the ordinary local payment owner',()=>{
 it('imports the fixed server order using client identity and suppresses tickets',async()=>{
  const result=await prepareHotelSettlement(folio,15000);
  expect(result.orderId).toBe(local);expect(result.serverId).toBe(remote);
  expect(mock.post).toHaveBeenCalledWith(expect.stringContaining('/settlement'),expect.objectContaining({currency:'CHF',amountCents:15000}));
  expect(mock.save).toHaveBeenCalledWith({orderData:{...prepared.order,items:prepared.items},suppressAutoPrint:true});
  expect(mock.post.mock.calls.every(([path])=>!path.endsWith('/payments'))).toBe(true);
 });
 it('retains the exact prepare identity after a lost answer, including a remount',async()=>{
  mock.post.mockResolvedValueOnce({success:false,error:'offline'});
  await expect(prepareHotelSettlement(folio,5000)).rejects.toThrow();
  await prepareHotelSettlement(folio,5000);
  expect(mock.post.mock.calls[0][1]).toEqual(mock.post.mock.calls[1][1]);
  await expect(prepareHotelSettlement(folio,10000)).rejects.toThrow('SETTLEMENT_REQUEST_CONFLICT');
 });
 it('resumes the original open settlement and refuses collection until canonical receipts are mirrored',async()=>{
  mock.get.mockResolvedValue({success:true,data:{...summary,collectible_cents:0,open_settlement:{order_id:remote,client_order_id:local,total_cents:15000,paid_cents:5000,remaining_cents:10000}}});
  await expect(prepareHotelSettlement(folio)).rejects.toThrow('PAYMENT_MIRROR_PENDING');
  expect(mock.post.mock.calls[0][1]).toEqual({clientRequestId:local,currency:'CHF',amountCents:15000});
  mock.snapshot.mockResolvedValue({success:true,orderTotal:150,netPaid:50,outstandingAmount:100,completedPayments:[{id:'receipt'}]});
  expect((await prepareHotelSettlement(folio)).outstanding).toBe(100);
 });
 it('resolves a prepare race by reading and resuming the open original',async()=>{
  mock.post.mockResolvedValueOnce({success:false,code:'FOLIO_SETTLEMENT_OPEN'});
  mock.get.mockResolvedValueOnce({success:true,data:summary}).mockResolvedValueOnce({success:true,data:{...summary,open_settlement:{client_order_id:local,total_cents:15000,paid_cents:0}}});
  await prepareHotelSettlement(folio);
  expect(mock.post.mock.calls[1][1].clientRequestId).toBe(local);
 });
 it('cancels only an unpaid unambiguous original without preparing a replacement',async()=>{
  const settlement=await prepareHotelSettlement(folio);mock.post.mockClear();mock.get.mockClear();mock.post.mockResolvedValue({success:true,data:{success:true}});
  await cancelHotelSettlement(settlement);
  expect(mock.post).toHaveBeenCalledTimes(1);expect(mock.post.mock.calls[0][0]).toContain(`/${remote}/cancel`);
  expect(mock.get).not.toHaveBeenCalled();expect(mock.save.mock.calls.at(-1)?.[0].orderData.status).toBe('cancelled');
 });
 it('cannot cancel payments, terminal ambiguity or unsaved receipts',async()=>{
  const settlement=await prepareHotelSettlement(folio);mock.post.mockClear();
  for(const facts of [{success:true,netPaid:1},{success:true,netPaid:0,unresolvedDirectSale:{id:'sale'}}]){
   mock.snapshot.mockResolvedValue(facts);await expect(cancelHotelSettlement(settlement)).rejects.toThrow('SETTLEMENT_HAS_PAYMENTS');
  }
  mock.snapshot.mockResolvedValue({success:true,netPaid:0});mock.unsaved.mockResolvedValue({success:true,payments:[{id:'held'}]});
  await expect(cancelHotelSettlement(settlement)).rejects.toThrow('SETTLEMENT_HAS_PAYMENTS');expect(mock.post).not.toHaveBeenCalled();
 });
 it('never prepares using a stale summary',async()=>{mock.get.mockResolvedValue({success:true,stale:true,data:summary});await expect(prepareHotelSettlement(folio)).rejects.toThrow('CONNECTION_REQUIRED');expect(mock.post).not.toHaveBeenCalled();});
});
describe('manual charge replay and statements',()=>{
 it('reuses a manual charge key after an unknown answer, even when the modal generated a new key',async()=>{
  const body={clientRequestId:'attempt-1',currency:'CHF',chargeType:'service',vatCategoryCode:'gr_reduced_13',description:'Spa',amount:50,quantity:1};
  mock.post.mockResolvedValueOnce({success:false,error:'offline'}).mockResolvedValueOnce({success:true,data:{success:true}});
  await postHotelCharge(folio,body);await postHotelCharge(folio,{...body,clientRequestId:'attempt-2'});
  expect(mock.post.mock.calls[1][1]).toEqual(body);
 });
 it('refuses changed charge details while an original is unresolved',async()=>{
  mock.post.mockResolvedValue({success:false,error:'offline'});await postHotelCharge(folio,{clientRequestId:'a',amount:50});
  await expect(postHotelCharge(folio,{clientRequestId:'b',amount:60})).rejects.toThrow('CHARGE_REQUEST_CONFLICT');
 });
 it('prints charges, collections, returns and balance in the recorded unit without double multiplying quantities',()=>{
  const document=folioStatementDocument({id:folio,currency:'CHF',guestName:'Ada',roomNumber:'101',checkIn:'2026-10-20',checkOut:null},[
   {id:'stay',currency:'CHF',charge_type:'room',quantity:2,total:200,description:'Stay'},
   {id:'cash',currency:'CHF',charge_type:'payment',quantity:1,total:-150,description:'Cash'},
   {id:'return',currency:'CHF',charge_type:'payment',quantity:1,total:20,description:'Refund: Cash'},
  ],key=>key);
  expect(document.currency).toBe('CHF');expect(document.items[0].total).toBe(200);
  expect(document.payments.map(line=>line.amount)).toEqual([150,-20]);expect(document.totals.map(line=>line.amount)).toEqual([200,130,70]);
 });
 it('localizes structured and embedded refusal codes',()=>{expect(hotelErrorCode('conflict (HTTP 409): {"code":"ROOM_CHECKOUT_REQUIRED"}')).toBe('ROOM_CHECKOUT_REQUIRED');});
});

it('never collects a cancelled prepare replay after a lost cancellation acknowledgement', async()=>{
  mock.post.mockResolvedValue({success:true,data:{...prepared,order:{...prepared.order,status:'cancelled'}}});
  await expect(prepareHotelSettlement(folio)).rejects.toThrow('SETTLEMENT_REQUEST_CONFLICT');
  expect(mock.save.mock.calls.at(-1)?.[0].orderData.status).toBe('cancelled');expect(mock.snapshot).not.toHaveBeenCalled();expect(localStorage.getItem(`hotel-settlement:${folio}`)).toBeNull();
});

it('retains the original cancel retry until its local mirror succeeds', async()=>{
  const settlement=await prepareHotelSettlement(folio);
  mock.save.mockResolvedValueOnce({success:false,error:'disk busy'});
  mock.post.mockResolvedValue({success:true,data:{success:true}});
  await expect(cancelHotelSettlement(settlement)).rejects.toThrow('disk busy');
  expect(localStorage.getItem(`hotel-settlement:${folio}`)).not.toBeNull();
  await cancelHotelSettlement(settlement);
  expect(mock.post.mock.calls.at(-1)?.[0]).toContain(`/${remote}/cancel`);
  expect(localStorage.getItem(`hotel-settlement:${folio}`)).toBeNull();
});

it('freezes statement time in the authenticated branch zone before durable printing', async()=>{
  vi.useFakeTimers();vi.setSystemTime(new Date('2026-10-20T22:30:00Z'));
  mock.get.mockResolvedValue({success:true,data:{success:true,charges:[]}});
  mock.setting.mockImplementation(async(_category,key)=>key==='hotel_timezone'?'Europe/Athens':'branch');
  mock.print.mockResolvedValue({success:true});
  try {
    await printHotelFolio({id:folio,currency:'CHF',guestName:'Ada',roomNumber:'101',checkIn:'2026-10-20',checkOut:null},key=>key);
    expect(mock.print.mock.calls[0][0].document.created_at).toBe('2026-10-21T01:30:00');
    mock.setting.mockResolvedValue('foreign-branch');mock.print.mockClear();
    await expect(printHotelFolio({id:folio,currency:'CHF',guestName:'Ada',roomNumber:'101',checkIn:'2026-10-20',checkOut:null},key=>key)).rejects.toThrow('CONNECTION_REQUIRED');
    expect(mock.print).not.toHaveBeenCalled();
  } finally {vi.useRealTimers();}
});

it('back-out after a lost cancel answer mirrors the original before releasing its request', async()=>{
  localStorage.setItem(`hotel-settlement:${folio}`,JSON.stringify({clientRequestId:local,currency:'CHF',amountCents:15000}));
  mock.post.mockResolvedValue({success:true,data:{...prepared,order:{...prepared.order,status:'cancelled'}}});
  mock.save.mockResolvedValueOnce({success:false,error:'disk busy'});
  await expect(cancelPreparedHotelSettlement(folio)).rejects.toThrow('disk busy');
  expect(localStorage.getItem(`hotel-settlement:${folio}`)).not.toBeNull();
  await cancelPreparedHotelSettlement(folio);
  expect(mock.post.mock.calls.every(([,body])=>body.clientRequestId===local)).toBe(true);
  expect(localStorage.getItem(`hotel-settlement:${folio}`)).toBeNull();
  expect(mock.snapshot).not.toHaveBeenCalled();
});
