import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-i18next')>();
  return {
    ...actual,
    useTranslation: () => ({
      t: (key: string, fallback?: string | { defaultValue?: string }) => (
        typeof fallback === 'string' ? fallback : fallback?.defaultValue ?? key
      ),
    }),
  };
});

vi.mock('../../../contexts/i18n-context', () => ({
  useI18n: () => ({
    language: 'en',
    setLanguage: vi.fn(),
    t: (key: string) => key === 'common.actions.close' ? 'Close' : key,
  }),
}));

vi.mock('../../../hooks/useFeatures', () => ({
  useFeatures: () => ({
    isFeatureEnabled: () => true,
    isMobileWaiter: false,
    loading: false,
  }),
}));

vi.mock('../../../hooks/useAcquiredModules', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../hooks/useAcquiredModules')>();
  return {
    ...actual,
    useAcquiredModules: () => ({ hasModule: (id: string) => id === 'plugin_integrations' }),
  };
});

const toastMocks = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn() }));
vi.mock('react-hot-toast', () => ({ default: Object.assign(vi.fn(), toastMocks) }));

import { PaymentModal } from '../PaymentModal';
import { claimOrdinaryCollectionOwner, releaseOrdinaryOwnerBeforeSend } from '../../../hooks/useOrderStore';


const qrMocks=vi.hoisted(()=>{
  const configuration={scope:'org|branch|terminal',currency:'CHF',qrImageData:'data:image/png;base64,iVBORw0KGgo='};
  return {configuration,release:vi.fn(),loadReceipts:vi.fn(async()=>[]),saveReceipt:vi.fn(),
    admit:vi.fn(async()=>({admitted:true as const,configuration}))};
});
vi.mock('../../../services/TwintReceiptRecoveryService',async(importOriginal)=>({
  ...await importOriginal<typeof import('../../../services/TwintReceiptRecoveryService')>(),
  loadPendingTwintReceipts:qrMocks.loadReceipts,saveOriginalTwintReceipt:qrMocks.saveReceipt,admitTwintCollection:qrMocks.admit,
}));
vi.mock('../../../services/TwintManualQrService',()=>({loadTwintManualConfiguration:async()=>qrMocks.configuration,currentTwintScope:()=>qrMocks.configuration.scope,twintManualMetadata:(action:string)=>({provider:'twint',confirmation:'cashier',confirmation_action:action,qr_mode:'static_qr_manual'})}));
vi.mock('../../../services/CustomerDisplayQrOverlay',()=>({acquireCustomerTwintQr:async()=>({external:false,release:qrMocks.release})}));
const orderScope={organizationId:'org',terminalId:'terminal'};
const existingOrder={orderId:'existing-order',scope:orderScope} as any;
const canClaim=()=>{const claim=claimOrdinaryCollectionOwner(orderScope,'existing-order');if(claim.claimed)releaseOrdinaryOwnerBeforeSend(claim.owner);return claim.claimed;};
describe('PaymentModal distinct manual TWINT tender',()=>{
 afterEach(()=>{cleanup();qrMocks.admit.mockClear();toastMocks.error.mockClear();});
 it.each([['Confirm payment received','confirm'],['Skip — confirm receipt','skip']])('records %s explicitly as TWINT with no provider transaction',async(label,action)=>{
  const onPaymentComplete=vi.fn().mockResolvedValue(true);
  render(<PaymentModal isOpen onClose={vi.fn()} orderTotal={12.35} onPaymentComplete={onPaymentComplete} allowTips={false}/>);
  const twint=await screen.findByRole('button',{name:'TWINT'});fireEvent.click(twint);
  expect(await screen.findByAltText('Official shop TWINT QR')).toBeInTheDocument();expect(onPaymentComplete).not.toHaveBeenCalled();
  const confirm=screen.getByRole('button',{name:label});fireEvent.click(confirm);fireEvent.click(confirm);
  await waitFor(()=>expect(onPaymentComplete).toHaveBeenCalledTimes(1));
  expect(onPaymentComplete).toHaveBeenCalledWith(expect.objectContaining({method:'twint',amount:12.35,currency:'CHF',idempotencyKey:expect.any(String),metadata:{provider:'twint',confirmation:'cashier',confirmation_action:action,qr_mode:'static_qr_manual'}}));
  expect(onPaymentComplete.mock.calls[0][0].transactionId).toBeUndefined();
 });
 it('cancel and closing never record a QR payment',async()=>{
  const onPaymentComplete=vi.fn();render(<PaymentModal isOpen onClose={vi.fn()} orderTotal={12.35} onPaymentComplete={onPaymentComplete} allowTips={false}/>);
  fireEvent.click(await screen.findByRole('button',{name:'TWINT'}));fireEvent.click(await screen.findByRole('button',{name:'Cancel'}));
  expect(screen.queryByAltText('Official shop TWINT QR')).not.toBeInTheDocument();expect(onPaymentComplete).not.toHaveBeenCalled();
 });
 it('reentry saves the original retained receipt without scanning or confirming another payment',async()=>{
  qrMocks.loadReceipts.mockResolvedValueOnce([{kind:'manual_twint_checkout',method:'twint',idempotencyKey:'original',amount:12.35,currency:'CHF'}] as never[]);
  qrMocks.saveReceipt.mockResolvedValue(true);
  const onPaymentComplete=vi.fn();const onClose=vi.fn();render(<PaymentModal isOpen onClose={onClose} orderTotal={15} onPaymentComplete={onPaymentComplete}/>);
  fireEvent.click(await screen.findByRole('button',{name:'Save original TWINT receipt'}));
  await waitFor(()=>expect(onClose).toHaveBeenCalled());
  expect(qrMocks.saveReceipt).toHaveBeenCalledWith(expect.objectContaining({idempotencyKey:'original',amount:12.35}));
  expect(onPaymentComplete).not.toHaveBeenCalled();expect(screen.queryByAltText('Official shop TWINT QR')).not.toBeInTheDocument();
 });
 it('existing-order reentry offers the original receipt and remains locked when saving fails',async()=>{
  const receipt={kind:'manual_twint_payment',method:'twint',orderId:'existing-order',idempotencyKey:'original-existing',amount:12.35,currency:'CHF'};
  qrMocks.loadReceipts.mockResolvedValueOnce([receipt] as never[]);qrMocks.saveReceipt.mockResolvedValueOnce(false);
  const onPaymentComplete=vi.fn();const onClose=vi.fn();render(<PaymentModal isOpen onClose={onClose} orderTotal={15} onPaymentComplete={onPaymentComplete} existingOrder={existingOrder}/>);
  fireEvent.click(await screen.findByRole('button',{name:'Save original TWINT receipt'}));
  await waitFor(()=>expect(qrMocks.saveReceipt).toHaveBeenCalledWith(receipt));
  expect(qrMocks.loadReceipts).toHaveBeenCalledWith('existing-order');
  expect(onClose).not.toHaveBeenCalled();expect(onPaymentComplete).not.toHaveBeenCalled();expect(screen.queryByRole('button',{name:'TWINT'})).not.toBeInTheDocument();expect(screen.queryByAltText('Official shop TWINT QR')).not.toBeInTheDocument();
 });
 it('existing-order TWINT stays unavailable if durable receipt status cannot be read',async()=>{
  qrMocks.loadReceipts.mockRejectedValueOnce(new Error('storage unavailable'));
  render(<PaymentModal isOpen onClose={vi.fn()} orderTotal={15} onPaymentComplete={vi.fn()} existingOrder={{orderId:'unreadable-order',scope:orderScope} as any}/>);
  await waitFor(()=>expect(qrMocks.loadReceipts).toHaveBeenCalledWith('unreadable-order'));
  expect(screen.queryByRole('button',{name:'TWINT'})).not.toBeInTheDocument();
 });

 // Fix review 06/10/2026: the QR for an existing order was shown before any
 // admission check, so every refusal came after the customer had paid (a
 // split card portion charged and not saved left the ledger unpaid, TWINT was
 // offered, and the receipt could never be saved).
 it('asks the admission before the QR and shows no QR when it refuses, releasing the claim',async()=>{
  qrMocks.admit.mockResolvedValueOnce({admitted:false,code:'PAYMENT_NOT_SAVED_PENDING'} as never);
  const onPaymentComplete=vi.fn();
  render(<PaymentModal isOpen onClose={vi.fn()} orderTotal={15} onPaymentComplete={onPaymentComplete} existingOrder={existingOrder} allowTips={false}/>);
  fireEvent.click(await screen.findByRole('button',{name:'TWINT'}));
  await waitFor(()=>expect(qrMocks.admit).toHaveBeenCalledWith(expect.objectContaining({orderId:'existing-order',amount:15,hold:expect.anything()})));
  await waitFor(()=>expect(toastMocks.error).toHaveBeenCalledWith('A payment of this order is not saved yet. Save it again before taking TWINT. Nothing was charged.'));
  expect(screen.queryByAltText('Official shop TWINT QR')).not.toBeInTheDocument();
  expect(onPaymentComplete).not.toHaveBeenCalled();
  expect(canClaim()).toBe(true);
 });
 it('holds the order while its QR is shown and confirms under the same claim',async()=>{
  const onPaymentComplete=vi.fn().mockResolvedValue(true);
  render(<PaymentModal isOpen onClose={vi.fn()} orderTotal={15} onPaymentComplete={onPaymentComplete} existingOrder={existingOrder} allowTips={false}/>);
  fireEvent.click(await screen.findByRole('button',{name:'TWINT'}));
  await screen.findByAltText('Official shop TWINT QR');
  expect(canClaim()).toBe(false);
  fireEvent.click(screen.getByRole('button',{name:'Confirm payment received'}));
  await waitFor(()=>expect(onPaymentComplete).toHaveBeenCalledTimes(1));
  expect(onPaymentComplete.mock.calls[0][0].ordinaryOwner).toBeDefined();
  await waitFor(()=>expect(canClaim()).toBe(true));
 });
 it('a receipt this till could not retain tells the cashier to keep it, never to collect again',async()=>{
  const failure=Object.assign(new Error('TWINT_RECEIPT_NOT_RETAINED'),{twintReceipt:true,manualReceiptConfirmed:true,manualReceiptRetained:false});
  const onPaymentComplete=vi.fn().mockRejectedValue(failure);
  render(<PaymentModal isOpen onClose={vi.fn()} orderTotal={12.35} onPaymentComplete={onPaymentComplete} allowTips={false}/>);
  fireEvent.click(await screen.findByRole('button',{name:'TWINT'}));
  fireEvent.click(await screen.findByRole('button',{name:'Confirm payment received'}));
  await waitFor(()=>expect(toastMocks.error).toHaveBeenCalledWith('The cashier confirmed TWINT receipt, but this till could not retain it. Do not collect again. Keep the receipt and contact a manager before closing or restarting the POS.',expect.anything()));
  expect(onPaymentComplete).toHaveBeenCalledTimes(1);
 });
 it('cancelling the admitted QR releases the order',async()=>{
  render(<PaymentModal isOpen onClose={vi.fn()} orderTotal={15} onPaymentComplete={vi.fn()} existingOrder={existingOrder} allowTips={false}/>);
  fireEvent.click(await screen.findByRole('button',{name:'TWINT'}));
  await screen.findByAltText('Official shop TWINT QR');
  expect(canClaim()).toBe(false);
  fireEvent.click(screen.getByRole('button',{name:'Cancel'}));
  expect(canClaim()).toBe(true);
 });
});
