import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks=vi.hoisted(()=>({invoke:vi.fn(),capabilities:vi.fn(),open:vi.fn(),close:vi.fn(),scope:'org|branch|terminal'}));
vi.mock('../../../lib',()=>({getBridge:()=>({invoke:mocks.invoke,externalDisplay:{getCapabilities:mocks.capabilities,open:mocks.open,close:mocks.close}})}));
vi.mock('../TwintManualQrService',()=>({currentTwintScope:()=>mocks.scope}));
import { acquireCustomerTwintQr, publishCustomerDisplaySnapshot } from '../CustomerDisplayQrOverlay';
const qr={qrImageData:'data:image/png;base64,iVBORw0KGgo=',amount:12,currency:'CHF' as const};
beforeEach(async()=>{mocks.scope='org|branch|terminal';mocks.invoke.mockReset().mockResolvedValue(undefined);mocks.capabilities.mockReset();mocks.open.mockReset();mocks.close.mockReset().mockResolvedValue({success:true});await publishCustomerDisplaySnapshot(null);});
describe('Customer display leased TWINT projection',()=>{
 it('publishes an initial QR, retains it over order refresh and restores latest orders after release',async()=>{
  const first=await acquireCustomerTwintQr(mocks.scope,qr,false);
  expect(mocks.invoke).toHaveBeenLastCalledWith('customer-display-publish',expect.objectContaining({twintQr:qr}));
  const base={displayOrders:[{order_number:'42'}],locale:'fr',isDark:false};await publishCustomerDisplaySnapshot(base);
  expect(mocks.invoke).toHaveBeenLastCalledWith('customer-display-publish',{...base,twintQr:qr});
  first.release();await publishCustomerDisplaySnapshot(base);
  expect(mocks.invoke).toHaveBeenLastCalledWith('customer-display-publish',base);
 });
 it('old lease cleanup cannot clear a newer QR',async()=>{
  const old=await acquireCustomerTwintQr(mocks.scope,qr,false);
  const newer=await acquireCustomerTwintQr(mocks.scope,{...qr,amount:20},false);
  old.release();await publishCustomerDisplaySnapshot({displayOrders:[]});
  expect(mocks.invoke).toHaveBeenLastCalledWith('customer-display-publish',expect.objectContaining({twintQr:expect.objectContaining({amount:20})}));
  newer.release();await publishCustomerDisplaySnapshot(null);
 });
 it('opens only a free external customer screen and falls back when unavailable',async()=>{
  mocks.capabilities.mockResolvedValue({success:true,supported:true,displays:[{id:'kitchen',external:true,hostsPos:false,available:false,occupiedBy:'kitchen_display'},{id:'free',external:true,hostsPos:false,available:true}],activePresentations:[]});
  mocks.open.mockResolvedValue({success:false});
  const lease=await acquireCustomerTwintQr(mocks.scope,qr,true);
  expect(lease.external).toBe(false);expect(mocks.open).toHaveBeenCalledWith({contentType:'customer_display',displayId:'free'});lease.release();
 });
 it('scope changes remove QR and a late open closes only its own native token',async()=>{
  mocks.capabilities.mockResolvedValue({success:true,supported:true,displays:[{id:'free',external:true,hostsPos:false,available:true}],activePresentations:[]});
  let finish:(value:unknown)=>void=()=>{};mocks.open.mockImplementation(()=>new Promise(resolve=>{finish=resolve}));
  const pending=acquireCustomerTwintQr(mocks.scope,qr,true);
  await vi.waitFor(()=>expect(mocks.open).toHaveBeenCalled());mocks.scope='new-org|branch|terminal';
  finish({success:true,token:'old-owned-token'});const lease=await pending;
  expect(lease.external).toBe(false);expect(mocks.close).toHaveBeenCalledWith({contentType:'customer_display',token:'old-owned-token'});
  await publishCustomerDisplaySnapshot(null);expect(mocks.invoke).toHaveBeenLastCalledWith('customer-display-publish',null);
 });
});
