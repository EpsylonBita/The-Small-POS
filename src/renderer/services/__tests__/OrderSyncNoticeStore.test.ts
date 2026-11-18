import { beforeEach, describe, expect, it, vi } from 'vitest';
const invoke=vi.hoisted(()=>vi.fn());
vi.mock('../../../lib',()=>({getBridge:()=>({invoke})}));
const row={orderId:'order',orderNumber:'12',queueId:'q',since:'today',kind:'customer_correction_refused' as const,state:'refused' as const,actions:[]};
beforeEach(()=>{vi.resetModules();vi.clearAllMocks();});
describe('order notice evidence',()=>{
 it('marks the shift-wide view stale when a later per-order refresh fails',async()=>{
  const {renderHook,act,cleanup}=await import('@testing-library/react/pure');
  const store=await import('../OrderSyncNoticeStore');invoke.mockResolvedValue([row]);await store.refreshOrderNotices();
  const view=renderHook(()=>store.useOrderNotices(undefined,false));
  expect(view.result.current.status).toBe('fresh');
  invoke.mockRejectedValue(new Error('offline'));
  await act(()=>store.refreshOrderNotices(['order']));
  expect(view.result.current.notices).toEqual([row]);expect(view.result.current.status).toBe('stale');cleanup();
 });
 it('reads the ids directly and retains last known notices after a failed refresh',async()=>{const store=await import('../OrderSyncNoticeStore');invoke.mockResolvedValue([row]);await store.refreshOrderNotices(['order']);expect(invoke).toHaveBeenCalledWith('order_sync_notices',{orderIds:['order']});invoke.mockRejectedValue(new Error('offline'));await store.refreshOrderNotices(['order']);expect(store.readOrderNoticeSnapshot()).toEqual({notices:[row],status:'stale'});});
 it('uses unavailable for the first error and clears only on a successful fresh read',async()=>{const store=await import('../OrderSyncNoticeStore');invoke.mockRejectedValue(new Error('bad'));await store.refreshOrderNotices();expect(store.readOrderNoticeSnapshot().status).toBe('unavailable');invoke.mockResolvedValue([]);await store.refreshOrderNotices();expect(store.readOrderNoticeSnapshot()).toEqual({notices:[],status:'fresh'});});
 it('announces once per order per parking, never for waiting or pending verification',async()=>{const{newlyParkedOrders}=await import('../OrderSyncNoticeStore');const seen=new Set<string>();expect(newlyParkedOrders([row,{...row,queueId:'q2'}],seen)).toHaveLength(1);expect(newlyParkedOrders([row],seen)).toHaveLength(0);expect(newlyParkedOrders([{...row,queueId:'retry',state:'pending'},{...row,queueId:'payment',state:'waiting'}],seen)).toHaveLength(0);expect(newlyParkedOrders([{...row,queueId:'retry'}],seen)).toHaveLength(1);});
});
