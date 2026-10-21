import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';

const mocks=vi.hoisted(()=>({
  status:vi.fn(), retry:vi.fn(), items:vi.fn(), snapshot:vi.fn(),
}));
vi.mock('react-i18next',()=>({useTranslation:()=>({t:(key:string)=>key})}));
vi.mock('../../../lib',()=>({getBridge:()=>({
  sync:{getStatus:mocks.status,retryAllFailedFinancial:mocks.retry},
  recovery:{createPreActionSnapshot:mocks.snapshot},
}),onEvent:vi.fn(),offEvent:vi.fn()}));
vi.mock('../../services/SyncQueueBridge',()=>({getSyncQueueBridge:()=>({listItems:mocks.items})}));
vi.mock('../../hooks/useBlockerRegistration',()=>({useBlockerRegistration:vi.fn()}));
import { FinancialSyncPanel } from '../FinancialSyncPanel';
afterEach(()=>{cleanup();vi.resetAllMocks();});

it('retained incoming payments remain visible and can resume without an outgoing charge',async()=>{
  mocks.items.mockResolvedValue([]);
  mocks.status.mockResolvedValue({unresolvedRemotePayments:2,unresolvedRemotePaymentsPaused:2});
  mocks.snapshot.mockResolvedValue({id:'before-retry'});
  mocks.retry.mockResolvedValue({success:true});
  render(<FinancialSyncPanel isOpen onClose={()=>{}} onRefresh={()=>{}} />);
  await screen.findByText('sync.financial.incomingRecovery');
  expect(screen.queryByText('sync.financial.allClear')).toBeNull();
  fireEvent.click(screen.getByRole('button',{name:'sync.financial.incomingRetry'}));
  await waitFor(()=>expect(mocks.retry).toHaveBeenCalledTimes(1));
  expect(mocks.retry).toHaveBeenCalledWith({incomingOnly:true});
  expect(mocks.snapshot).toHaveBeenCalledTimes(1);
});

it('an unreadable incoming journal never reports financial all clear',async()=>{
  mocks.items.mockResolvedValue([]);
  mocks.status.mockRejectedValue(new Error('read unavailable'));
  render(<FinancialSyncPanel isOpen onClose={()=>{}} onRefresh={()=>{}} />);
  await screen.findByRole('alert');
  expect(screen.queryByText('sync.financial.allClear')).toBeNull();
});

it('snapshot failure leaves incoming recovery paused',async()=>{
  mocks.items.mockResolvedValue([]);
  mocks.status.mockResolvedValue({unresolvedRemotePayments:1,unresolvedRemotePaymentsPaused:1});
  mocks.snapshot.mockRejectedValue(new Error('snapshot unavailable'));
  render(<FinancialSyncPanel isOpen onClose={()=>{}} onRefresh={()=>{}} />);
  fireEvent.click(await screen.findByRole('button',{name:'sync.financial.incomingRetry'}));
  await waitFor(()=>expect(mocks.snapshot).toHaveBeenCalled());
  expect(mocks.retry).not.toHaveBeenCalled();
});

it('overlapping retry requests share one pre-action snapshot', async () => {
  mocks.items.mockResolvedValue([]);
  mocks.status.mockResolvedValue({ unresolvedRemotePayments: 1 });
  let finishSnapshot!: (value: { id: string }) => void;
  mocks.snapshot.mockReturnValue(new Promise((resolve) => { finishSnapshot = resolve; }));
  mocks.retry.mockResolvedValue({ success: true });
  render(<FinancialSyncPanel isOpen onClose={() => {}} onRefresh={() => {}} />);
  const button = await screen.findByRole('button', { name: 'sync.financial.incomingRetry' });
  // Both handlers run before React commits the disabled state.
  act(() => {
    button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  expect(mocks.snapshot).toHaveBeenCalledTimes(1);
  await act(async () => { finishSnapshot({ id: 'one-original' }); });
  await waitFor(() => expect(mocks.retry).toHaveBeenCalledTimes(1));
});
