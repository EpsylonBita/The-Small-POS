// @vitest-environment jsdom
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import en from '../../../../locales/en.json';
import { OrderSyncMark, OrderSyncNotice, ShiftOrderSyncNotices } from '../OrderSyncNotice';
const mocks=vi.hoisted(()=>({ snapshot:{notices:[] as any[],status:'fresh'}, execute:vi.fn(), refresh:vi.fn(), open:vi.fn(), release:vi.fn(), remedy:vi.fn(), invoke:vi.fn() }));
vi.mock('../../../../lib',()=>({getBridge:()=>({invoke:mocks.invoke})}));
vi.mock('../../../services/OrderNoticeRemedy',()=>({readOrderNoticeRemedy:mocks.remedy}));
vi.mock('../../../services/OrderSyncNoticeStore',()=>({useOrderNotices:(ids?:string[])=>({...mocks.snapshot,notices:ids?mocks.snapshot.notices.filter(n=>ids.includes(n.orderId)):mocks.snapshot.notices}),refreshOrderNotices:mocks.refresh,openOrderNotice:mocks.open}));
vi.mock('../../../hooks/usePrivilegedActionConfirmation',()=>({usePrivilegedActionConfirmation:()=>({runWithPrivilegedConfirmation:vi.fn(),confirmationModal:null})}));
vi.mock('../../../services/support/SupportRemedyRunner',()=>({acquireRecoveryAction:()=>mocks.release,buildRecoveryActionRequest:(issue:any,action:any)=>({actionId:action.id,...issue}),executeHealthRecoveryAction:mocks.execute}));
vi.mock('../SyncRecoveryModal',()=>({SyncRecoveryModal:({isOpen,orderId}:any)=>isOpen?<div>Guided order {orderId}</div>:null}));
vi.mock('react-i18next',()=>({useTranslation:()=>({t:(key:string,options:any={})=>{const text=key.split('.').reduce((value:any,k)=>value?.[k],en)??options.defaultValue??key;return text.replace('{{number}}',options.number??'');}})}));
const notice={orderId:'order-1',orderNumber:'125',queueId:'queue-1',since:'2026-11-17',kind:'customer_correction_refused',state:'refused',actions:['resendOrderCustomerCorrection','keepServerOrderCustomerDetails']};
beforeEach(()=>{cleanup();vi.clearAllMocks();mocks.remedy.mockResolvedValue(null);mocks.invoke.mockImplementation(async(command:string)=>command==='order_sync_notices'?mocks.snapshot.notices:'attempt');mocks.snapshot={notices:[{...notice}],status:'fresh'};Object.defineProperty(navigator,'onLine',{configurable:true,value:true});mocks.execute.mockResolvedValue({success:true,verification:{status:'pending'}});});

describe('staff order sync notices',()=>{
 it('shows words on the card, without a pill, fill or border; opens on a tap',()=>{
  render(<OrderSyncMark orderId="order-1"/>);const button=screen.getByRole('button',{name:'Needs attention'});
  expect(button.className).toContain('min-h-11');expect(button.className).toContain('focus-visible');expect(button.className).not.toMatch(/bg-|border|rounded/);
  fireEvent.click(button);expect(mocks.open).toHaveBeenCalledWith('order-1');
 });
 it('has no card mark or order notice after a fresh empty read',()=>{mocks.snapshot.notices=[];render(<><OrderSyncMark orderId="order-1"/><OrderSyncNotice orderId="order-1"/></>);expect(screen.queryByRole('button')).toBeNull();});
 it('explains the customer correction and has exactly one yellow primary',()=>{
  const{container}=render(<OrderSyncNotice orderId="order-1"/>);
  expect(screen.getByText(/sale and the payment are not affected/)).toBeTruthy();
  expect(screen.getByText('Until it is solved, the order stays in the active orders.')).toBeTruthy();
  expect(container.querySelectorAll('button.bg-yellow-400')).toHaveLength(1);
  expect(screen.getAllByRole('button')).toHaveLength(1);expect(screen.getByRole('button',{name:'Save again'})).toBeTruthy();expect(screen.getByText('Press the button to save it again.')).toBeTruthy();
  expect(container.textContent).not.toMatch(/queue-1|UNKNOWN_CONFLICT|ORDER_EDIT/);
 });
 it('shows several notices without several primary actions',()=>{mocks.snapshot.notices.push({...notice,queueId:'payment',kind:'payment_not_on_server',actions:[]});const{container}=render(<OrderSyncNotice orderId="order-1"/>);expect(screen.getByText(/Do not charge the customer again/)).toBeTruthy();expect(container.querySelectorAll('button.bg-yellow-400')).toHaveLength(1);});
 it('always saves again even if Health actions arrive in a different order',async()=>{
  mocks.snapshot.notices=[{...notice,actions:[...notice.actions].reverse()}];render(<OrderSyncNotice orderId="order-1"/>);
  fireEvent.click(screen.getByRole('button',{name:'Save again'}));
  await waitFor(()=>expect(mocks.execute).toHaveBeenCalled());
  expect(mocks.execute.mock.calls[0][0].action.id).toBe('resendOrderCustomerCorrection');
  expect(screen.getAllByRole('button')).toHaveLength(1);
 });
 it('does not show a separate confirmed message after a completed action',async()=>{
  mocks.execute.mockResolvedValue({success:true,verification:{status:'passed'}});
  mocks.invoke.mockImplementation(async(command:string)=>command==='order_sync_notices'?[]:'attempt');
  render(<OrderSyncNotice orderId="order-1"/>);fireEvent.click(screen.getByRole('button',{name:'Save again'}));
  await waitFor(()=>expect(mocks.refresh).toHaveBeenCalledWith(['order-1']));
  expect(screen.queryByRole('status')).toBeNull();expect(screen.queryByText(/confirmed|server/i)).toBeNull();
 });
 it('disables the single save action offline and explains why',()=>{Object.defineProperty(navigator,'onLine',{value:false});render(<OrderSyncNotice orderId="order-1"/>);expect((screen.getByRole('button',{name:'Save again'})as HTMLButtonElement).disabled).toBe(true);expect(screen.getAllByRole('button')).toHaveLength(1);expect(screen.getByText(/There is no internet connection/)).toBeTruthy();});
 it.each(['stale','unavailable'])('retains the notice and disables changes when %s',status=>{mocks.snapshot.status=status;render(<OrderSyncNotice orderId="order-1"/>);expect(screen.getByText(/last known one is shown/)).toBeTruthy();expect(screen.getByText(/sale and the payment/)).toBeTruthy();expect((screen.getByRole('button',{name:'Save again'})as HTMLButtonElement).disabled).toBe(true);});
 it('shows loading without claiming the order is healthy',()=>{mocks.snapshot={notices:[],status:'loading'};render(<OrderSyncNotice orderId="order-1"/>);expect(screen.getByRole('status').textContent).toContain('Checking this order');});
 it('keeps pending distinct from confirmation',async()=>{render(<OrderSyncNotice orderId="order-1"/>);fireEvent.click(screen.getByRole('button',{name:'Save again'}));await waitFor(()=>expect(screen.getByText(/Please wait a moment/)).toBeTruthy());expect(mocks.execute.mock.calls[0][0].action.requiresSnapshot).toBe(true);expect(mocks.refresh).toHaveBeenCalledWith(['order-1']);expect(screen.queryByText(/confirmed/i)).toBeNull();});
 it('disables actions while the remedy runs',()=>{mocks.execute.mockReturnValue(new Promise(()=>{}));render(<OrderSyncNotice orderId="order-1"/>);fireEvent.click(screen.getByRole('button',{name:'Save again'}));expect((screen.getByRole('button',{name:'Checking…'})as HTMLButtonElement).disabled).toBe(true);});
 it('removes a pending notice only after a fresh read proves it is gone',async()=>{
  const view=render(<OrderSyncNotice orderId="order-1"/>);
  fireEvent.click(screen.getByRole('button',{name:'Save again'}));
  await waitFor(()=>expect(screen.getByText(/Please wait a moment/)).toBeTruthy());
  mocks.snapshot={notices:[{...notice,state:'pending',actions:[]}],status:'fresh'};
  view.rerender(<OrderSyncNotice orderId="order-1"/>);
  expect(screen.queryByRole('button',{name:'Save again'})).toBeNull();
  expect(screen.queryByText('Press the button to save it again.')).toBeNull();
  mocks.snapshot={notices:[],status:'fresh'};view.rerender(<OrderSyncNotice orderId="order-1"/>);
  await waitFor(()=>expect(screen.queryByRole('region')).toBeNull());
 });
 it('shows a second refusal and offers the guided next step again',()=>{
  mocks.snapshot.notices=[{...notice,failedAgain:true}];render(<OrderSyncNotice orderId="order-1"/>);
  expect(screen.getByText(/not saved this time either/)).toBeTruthy();
  expect(screen.getByRole('button',{name:'Save again'})).toBeTruthy();
 });
 it('explains the native critical-operation guard without affecting other order controls',()=>{
  mocks.snapshot.notices=[{...notice,unavailableReason:'busy'}];render(<OrderSyncNotice orderId="order-1"/>);
  expect(screen.getByText(/Finish the sale, the payment/)).toBeTruthy();
  expect((screen.getByRole('button',{name:'Save again'})as HTMLButtonElement).disabled).toBe(true);
 });
 it('reports failure and retains the notice',async()=>{mocks.execute.mockRejectedValue(new Error('SECRET SERVER ERROR'));const{container}=render(<OrderSyncNotice orderId="order-1"/>);fireEvent.click(screen.getByRole('button',{name:'Save again'}));await waitFor(()=>expect(screen.getByText(/change was not saved/)).toBeTruthy());expect(screen.getByText(/sale and the payment/)).toBeTruthy();expect(container.textContent).not.toContain('SECRET');expect(screen.getAllByRole('button')).toHaveLength(1);});
 it.each(['change_refused','payment_not_on_server'])('shows no button or technical assistant without a safe remedy for %s',async kind=>{mocks.snapshot.notices=[{...notice,kind,actions:[]}];render(<OrderSyncNotice orderId="order-1"/>);await waitFor(()=>expect(screen.getByText('This cannot be solved from here. Tell the manager.')).toBeTruthy());expect(screen.queryByText('Press the button to save it again.')).toBeNull();expect(screen.queryByRole('button')).toBeNull();expect(screen.queryByText('Guided order order-1')).toBeNull();});
 it('shows neutral automatic saving with no action and returns to amber on failure',()=>{
  mocks.snapshot.notices=[{...notice,automatic:true,state:'pending',actions:[]}];
  const view=render(<><OrderSyncMark orderId="order-1"/><OrderSyncNotice orderId="order-1"/></>);
  expect(screen.getAllByText('Saving…')).toHaveLength(2);expect(screen.queryByText('Needs attention')).toBeNull();expect(screen.queryByRole('button')).toBeNull();
  expect(view.container.querySelector('.text-amber-800')).toBeNull();
  mocks.snapshot.notices=[{...notice,failedAgain:true,automatic:false}];
  view.rerender(<><OrderSyncMark orderId="order-1"/><OrderSyncNotice orderId="order-1"/></>);
  expect(screen.getByRole('button',{name:'Save again'})).toBeTruthy();
  mocks.snapshot.notices=[];view.rerender(<><OrderSyncMark orderId="order-1"/><OrderSyncNotice orderId="order-1"/></>);
  expect(screen.queryByText('Saving…')).toBeNull();expect(screen.queryByRole('button')).toBeNull();
 });
 it('runs an exact shipped remedy with one plain button, and says when it failed',async()=>{
  mocks.snapshot.notices=[{...notice,kind:'change_refused',actions:[]}];
  mocks.remedy.mockResolvedValue({issue:{id:'q',actions:[]},action:{id:'repairInvalidDriverOrderUpdate',recipeId:'invalid-driver-order-update.repair',recipeVersion:1,requiresSnapshot:true}});
  mocks.execute.mockRejectedValue(new Error('PRIVATE TECHNICAL MESSAGE'));
  const view=render(<OrderSyncNotice orderId="order-1"/>);
  await waitFor(()=>expect(screen.getByRole('button',{name:'Try again'})).toBeTruthy());
  expect(screen.getAllByRole('button')).toHaveLength(1);fireEvent.click(screen.getByRole('button',{name:'Try again'}));
  await waitFor(()=>expect(screen.getByText('It was not solved. Tell the manager.')).toBeTruthy());
  expect(mocks.execute.mock.calls[0][0].action.id).toBe('repairInvalidDriverOrderUpdate');expect(view.container.textContent).not.toContain('PRIVATE');
 });
 it('lists each order once at shift close and never disables closing',()=>{mocks.snapshot.notices.push({...notice,queueId:'other'});render(<ShiftOrderSyncNotices/>);expect(screen.getAllByRole('button')).toHaveLength(1);expect(screen.getByText(/do not stop you closing/)).toBeTruthy();fireEvent.click(screen.getByRole('button',{name:'Order 125'}));expect(mocks.open).toHaveBeenCalledWith('order-1');});
});
