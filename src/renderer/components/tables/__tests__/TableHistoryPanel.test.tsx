import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { TableHistoryPanel } from '../TableHistoryPanel';
import { posApiGet } from '../../../utils/api-helpers';
vi.mock('../../../utils/api-helpers',()=>({posApiGet:vi.fn()}));
vi.mock('../../../contexts/i18n-context',()=>({useI18n:()=>({t:(key:string)=>key})}));
afterEach(()=>{cleanup();vi.clearAllMocks();});
describe('canonical table history',()=>{
  it('shows closed orders with original currency without an active table binding',async()=>{
    vi.mocked(posApiGet).mockResolvedValue({success:true,data:{orders:[{id:'order',order_number:'0029',created_at:'2026-10-09',status:'completed',payment_status:'paid',total_amount:38,currency:'CHF'}],has_more:false}});
    render(<TableHistoryPanel tableId="p04" />);
    expect(await screen.findByText('CHF 38.00')).toBeTruthy();
    expect(posApiGet).toHaveBeenCalledWith('/api/pos/tables/p04/history?limit=50&offset=0');
  });
  it('distinguishes failure from empty history and recovers with retry',async()=>{
    vi.mocked(posApiGet).mockResolvedValueOnce({success:false}).mockResolvedValue({success:true,data:{orders:[],has_more:false}});
    render(<TableHistoryPanel tableId="p04" />);
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.queryByText('tables.noHistory')).toBeNull();
    fireEvent.click(screen.getByRole('button',{name:'common.retry'}));
    await waitFor(()=>expect(screen.getByText('tables.noHistory')).toBeTruthy());
  });
});
