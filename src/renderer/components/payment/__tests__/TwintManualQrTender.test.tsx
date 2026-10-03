import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TwintManualQrTender } from '../TwintManualQrTender';
const mocks=vi.hoisted(() => ({ release:vi.fn(), load:vi.fn(), scope:'org|branch|terminal' }));
vi.mock('react-i18next',async (importOriginal)=>({...await importOriginal<typeof import('react-i18next')>(),useTranslation:()=>({t:(_key:string,fallback:string)=>fallback})}));
vi.mock('../../../services/TwintManualQrService',()=>({currentTwintScope:()=>mocks.scope, loadTwintManualConfiguration:mocks.load}));
vi.mock('../../../services/CustomerDisplayQrOverlay',()=>({acquireCustomerTwintQr:async()=>({external:false,release:mocks.release})}));
vi.mock('../../../../lib',()=>({getBridge:()=>({externalDisplay:{getCapabilities:vi.fn()}})}));
const configuration={scope:'org|branch|terminal',currency:'CHF' as const,qrImageData:'data:image/png;base64,iVBORw0KGgo='};
beforeEach(()=>{mocks.scope=configuration.scope;mocks.release.mockReset();mocks.load.mockReset().mockResolvedValue(configuration)});
afterEach(cleanup);
describe('Manual TWINT QR cashier confirmation',()=>{
 it('opens QR and handles image error/cancel without completing payment',async()=>{
  const onConfirm=vi.fn();const onCancel=vi.fn();render(<TwintManualQrTender configuration={configuration} amount={12.35} externalEnabled={false} onConfirm={onConfirm} onCancel={onCancel}/>);
  expect(screen.getByAltText('Official shop TWINT QR')).toHaveAttribute('src',configuration.qrImageData);
  fireEvent.error(screen.getByAltText('Official shop TWINT QR'));
  fireEvent.click(screen.getByRole('button',{name:'Cancel'}));
  expect(onConfirm).not.toHaveBeenCalled();expect(onCancel).toHaveBeenCalledTimes(1);
 });
 it.each([['Confirm payment received','confirm'],['Skip — confirm receipt','skip']])('requires explicit %s and admits one send',async(label,action)=>{
  let finish:(value:boolean)=>void=()=>{};const onConfirm=vi.fn(()=>new Promise<boolean>(resolve=>{finish=resolve}));
  const view=render(<TwintManualQrTender configuration={configuration} amount={12.35} externalEnabled={false} onConfirm={onConfirm} onCancel={vi.fn()}/>);
  const button=screen.getByRole('button',{name:label});fireEvent.click(button);fireEvent.click(button);
  await waitFor(()=>expect(onConfirm).toHaveBeenCalledTimes(1));
  expect(onConfirm).toHaveBeenCalledWith(action,expect.any(String));
  finish(true);await waitFor(()=>expect(mocks.release).toHaveBeenCalled());
  view.unmount();expect(onConfirm).toHaveBeenCalledTimes(1);
 });
 it('does not complete after the QR closes while the configuration check is outstanding',async()=>{
  let finish:(value:unknown)=>void=()=>{};mocks.load.mockImplementation(()=>new Promise(resolve=>{finish=resolve}));
  const onConfirm=vi.fn();const view=render(<TwintManualQrTender configuration={configuration} amount={12} externalEnabled={false} onConfirm={onConfirm} onCancel={vi.fn()}/>);
  fireEvent.click(screen.getByRole('button',{name:'Confirm payment received'}));view.unmount();finish(configuration);
  await Promise.resolve();expect(onConfirm).not.toHaveBeenCalled();
 });
 it('rejects changed organization or revoked setup and retains the original key on a save retry',async()=>{
  const onConfirm=vi.fn().mockResolvedValue(false);render(<TwintManualQrTender configuration={configuration} amount={12} externalEnabled={false} onConfirm={onConfirm} onCancel={vi.fn()}/>);
  fireEvent.click(screen.getByRole('button',{name:'Confirm payment received'}));await screen.findByRole('alert');
  fireEvent.click(screen.getByRole('button',{name:'Skip — confirm receipt'}));await waitFor(()=>expect(onConfirm).toHaveBeenCalledTimes(2));
  expect(onConfirm.mock.calls[1]).toEqual(onConfirm.mock.calls[0]);
  mocks.scope='new-org|branch|terminal';fireEvent.click(screen.getByRole('button',{name:'Confirm payment received'}));expect(onConfirm).toHaveBeenCalledTimes(2);
 });
});
