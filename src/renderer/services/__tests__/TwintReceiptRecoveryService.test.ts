import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks=vi.hoisted(()=>({scope:'org|branch|terminal',list:vi.fn(),save:vi.fn(),owner:vi.fn(),view:vi.fn(),probe:vi.fn(),snapshot:vi.fn()}));
vi.mock('../../../lib',()=>({getBridge:()=>({payments:{listUnsavedPayments:mocks.list,saveUnsavedPayments:mocks.save,getSettlementSnapshot:mocks.snapshot}})}));
vi.mock('../../hooks/useOrderStore',()=>({retainedOrdinaryOwner:mocks.owner,ordinaryCollectionView:mocks.view,probeOrdinaryOwner:mocks.probe}));
vi.mock('../TwintManualQrService',()=>({currentTwintScope:()=>mocks.scope}));
import { loadPendingTwintReceipts, saveOriginalTwintReceipt } from '../TwintReceiptRecoveryService';
const receipt={idempotencyKey:'original-receipt',orderId:'original-checkout',kind:'manual_twint_checkout',method:'twint',manualScope:'org|branch|terminal',manualReceiptConfirmed:true,currency:'CHF',amount:12,amountCents:1200,capturedAt:'now',attempts:1,canSaveAgain:true};
beforeEach(()=>{mocks.scope=receipt.manualScope;mocks.list.mockReset().mockResolvedValue({success:true,payments:[receipt,{...receipt,kind:'new_order_checkout',method:'card'}]});mocks.save.mockReset().mockResolvedValue({success:true,saved:1,unsaved:[]});mocks.owner.mockReset();mocks.view.mockReset();mocks.probe.mockReset();mocks.snapshot.mockReset();});
describe('Durable manual TWINT receipt recovery',()=>{
 it('finds manual receipts after a remount without treating card approval as TWINT',async()=>{expect(await loadPendingTwintReceipts()).toEqual([receipt]);});
 it('saves only the original key and never requests another provider payment or confirmation',async()=>{expect(await saveOriginalTwintReceipt(receipt)).toBe(true);expect(mocks.save).toHaveBeenCalledExactlyOnceWith({idempotencyKey:'original-receipt'});});
 it.each(['scope','currency','confirmation'])('refuses changed %s before replay',async(reason)=>{const changed={...receipt};if(reason==='scope')mocks.scope='other-org|branch|terminal';if(reason==='currency')changed.currency='EUR';if(reason==='confirmation')changed.manualReceiptConfirmed=false;expect(await saveOriginalTwintReceipt(changed)).toBe(false);expect(mocks.save).not.toHaveBeenCalled();});
 it('does not report recovery after a scope change during the save',async()=>{mocks.save.mockImplementation(async()=>{mocks.scope='other-org|branch|terminal';return {success:true,saved:1,unsaved:[]};});expect(await saveOriginalTwintReceipt(receipt)).toBe(false);});
 it('fails closed when receipt state is unavailable',async()=>{mocks.list.mockRejectedValue(new Error('native store unavailable'));await expect(loadPendingTwintReceipts()).rejects.toThrow();});
 it('loads only the retained receipt of the selected existing order',async()=>{
  const existing={...receipt,kind:'manual_twint_payment',orderId:'existing-order'};
  mocks.list.mockResolvedValue({success:true,payments:[receipt,existing,{...existing,orderId:'other-order',idempotencyKey:'other-key'}]});
  expect(await loadPendingTwintReceipts('existing-order')).toEqual([existing]);
  expect(await loadPendingTwintReceipts()).toEqual([receipt]);
 });
 it('reconciles the same ordinary owner only from the canonical saved TWINT row',async()=>{
  const existing={...receipt,kind:'manual_twint_payment',orderId:'existing-order'};const owner={key:'owner'};
  const snapshot={success:true,completedPayments:[{idempotencyKey:receipt.idempotencyKey,method:'twint'}]};
  mocks.owner.mockReturnValue(owner);mocks.view.mockReturnValue({original:{idempotencyKey:receipt.idempotencyKey}});mocks.snapshot.mockResolvedValue(snapshot);mocks.probe.mockImplementation(async(_owner,read)=>read());
  expect(await saveOriginalTwintReceipt(existing)).toBe(true);
  expect(mocks.save).toHaveBeenCalledExactlyOnceWith({idempotencyKey:receipt.idempotencyKey});
  expect(mocks.owner).toHaveBeenCalledWith({organizationId:'org',terminalId:'terminal'},'existing-order');
  expect(mocks.probe).toHaveBeenCalledWith(owner,expect.any(Function));expect(mocks.snapshot).toHaveBeenCalledWith('existing-order');
 });
 it('does not resolve an ordinary owner belonging to another original key',async()=>{
  mocks.owner.mockReturnValue({key:'owner'});mocks.view.mockReturnValue({original:{idempotencyKey:'other-key'}});
  expect(await saveOriginalTwintReceipt({...receipt,kind:'manual_twint_payment',orderId:'existing-order'})).toBe(true);expect(mocks.probe).not.toHaveBeenCalled();
 });
});
