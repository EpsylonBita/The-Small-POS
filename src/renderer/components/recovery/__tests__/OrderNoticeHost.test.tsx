// @vitest-environment jsdom
import React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
const mocks=vi.hoisted(()=>({custom:vi.fn(),dismiss:vi.fn(),rows:[] as any[]}));
vi.mock('react-hot-toast',()=>({default:{custom:mocks.custom,dismiss:mocks.dismiss}}));
vi.mock('../../modals/OrderDetailsModal',()=>({default:({orderId}:any)=><div>Opened order {orderId}</div>}));
vi.mock('../../../services/support/SupportRemedyRunner',()=>({listenSupportEvent:()=>()=>{}}));
vi.mock('../../../../lib',()=>({getBridge:()=>({invoke:vi.fn(async()=>[])})}));
vi.mock('../../../services/OrderSyncNoticeStore',async importOriginal=>({...await importOriginal<any>(),useOrderNotices:()=>({notices:mocks.rows,status:'fresh'}),refreshOrderNotices:vi.fn()}));
vi.mock('react-i18next',()=>({useTranslation:()=>({t:(_key:string,options:any)=>options.defaultValue.replace('{{number}}',options.number)})}));
import { OrderNoticeHost } from '../OrderNoticeHost';
afterEach(()=>{cleanup();vi.clearAllMocks();});
it('shows one toast per parking and its tap opens that order window',()=>{
 mocks.rows=[{orderId:'order-1',orderNumber:'125',queueId:'q1',state:'refused',since:'now'}];
 const view=render(<OrderNoticeHost/>);expect(mocks.custom).toHaveBeenCalledTimes(1);
 view.rerender(<OrderNoticeHost/>);expect(mocks.custom).toHaveBeenCalledTimes(1);
 render(mocks.custom.mock.calls[0][0]({id:'toast'}));fireEvent.click(screen.getByRole('button',{name:/Order 125 needs attention/}));
 expect(screen.getByText('Opened order order-1')).toBeTruthy();expect(mocks.dismiss).toHaveBeenCalledWith('toast');
 mocks.rows=[{...mocks.rows[0],queueId:'q2'}];view.rerender(<OrderNoticeHost/>);expect(mocks.custom).toHaveBeenCalledTimes(2);
});
