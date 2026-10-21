import React from 'react';
import { cleanup,fireEvent,render,screen,waitFor } from '@testing-library/react';
import { afterEach,beforeEach,expect,it,vi } from 'vitest';
const mock=vi.hoisted(()=>({prepare:vi.fn(),cancel:vi.fn(),cancelPrepared:vi.fn(),finish:vi.fn(),paymentProps:null as any,splitProps:null as any}));
vi.mock('react-i18next',()=>({useTranslation:()=>({t:(key:string)=>key})}));
vi.mock('../../../../../lib',()=>({getBridge:()=>({terminalConfig:{getOrganizationId:async()=> 'org',getTerminalId:async()=> 'terminal',getBranchId:async()=> 'branch'}})}));
vi.mock('../../../../utils/active-cashier',()=>({resolveActiveCashierShift:async()=>({id:'shift',staff_id:'staff'})}));
vi.mock('../../../../services/HotelSettlementService',()=>({prepareHotelSettlement:mock.prepare,cancelHotelSettlement:mock.cancel,cancelPreparedHotelSettlement:mock.cancelPrepared,finishHotelSettlement:mock.finish,hotelErrorCode:(error:Error)=>error.message}));
vi.mock('../../../../components/modals/PaymentModal',()=>({PaymentModal:(props:any)=>{mock.paymentProps=props;return props.isOpen?<div><button onClick={()=>props.onPaymentComplete({method:'card'})}>Card</button><button onClick={props.onClose}>Back</button></div>:null;}}));
vi.mock('../../../../components/modals/SplitPaymentModal',()=>({SplitPaymentModal:(props:any)=>{mock.splitProps=props;return <button onClick={()=>props.onSplitComplete({paymentStatus:'paid'})}>Collect</button>;}}));
vi.mock('../../../../components/ui/pos-glass-components',()=>({LiquidGlassModal:({children,onClose}:any)=><div>{children}<button onClick={onClose}>Back</button></div>}));
import { HotelSettlementModal } from '../HotelSettlementModal';
const settlement={folioId:'folio',orderId:'client',serverId:'server',currency:'CHF',total:150,outstanding:100,items:[{menu_item_name:'Stay',quantity:1,total_price:100}],payments:[{id:'existing'}],order:{}};
beforeEach(()=>{vi.clearAllMocks();mock.prepare.mockResolvedValue(settlement);mock.cancel.mockResolvedValue(undefined);mock.cancelPrepared.mockResolvedValue(undefined);mock.paymentProps=null;mock.splitProps=null;});
afterEach(cleanup);
it('hands the server-born order to normal tender collection with native scope, without tips, room charge or discounts',async()=>{
 const onCollected=vi.fn();render(<HotelSettlementModal folioId="folio" amountCents={10000} onClose={vi.fn()} onCollected={onCollected}/>);
 fireEvent.click(await screen.findByText('Card'));
 expect(mock.prepare).toHaveBeenCalledWith('folio',10000,{staffId:'staff',staffShiftId:'shift'});
 expect(mock.paymentProps.allowTips).toBe(false);expect(mock.paymentProps.allowTwint).toBe(false);expect(mock.paymentProps.roomChargeContext).toBeUndefined();
 expect(mock.splitProps).toMatchObject({orderId:'client',orderTotal:150,initialTender:'card',allowDiscounts:false,currency:'CHF',collectionScope:{organizationId:'org',terminalId:'terminal'}});
 fireEvent.click(screen.getByText('Collect'));await waitFor(()=>expect(onCollected).toHaveBeenCalledTimes(1));
 expect(mock.finish).toHaveBeenCalledWith('folio');expect(mock.cancel).not.toHaveBeenCalled();
});
it('cancels an unpaid original before backing out',async()=>{
 const close=vi.fn();render(<HotelSettlementModal folioId="folio" onClose={close} onCollected={vi.fn()}/>);
 await screen.findByText('Card');fireEvent.click(screen.getByText('Back'));await waitFor(()=>expect(close).toHaveBeenCalledTimes(1));
 expect(mock.cancel).toHaveBeenCalledWith(settlement);
});
