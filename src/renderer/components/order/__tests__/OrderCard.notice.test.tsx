import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
vi.mock('react-i18next',async()=>{const{useTranslationEn}=await import('../../../test/en-translate');return{useTranslation:useTranslationEn,initReactI18next:{type:'3rdParty',init:()=>{}}};});
vi.mock('../../../contexts/theme-context',()=>({useTheme:()=>({theme:'dark',resolvedTheme:'dark',setTheme:()=>{}})}));
vi.mock('../../../../lib',()=>({getBridge:()=>({customers:{lookupByPhone:vi.fn(async()=>null)}})}));
vi.mock('../../../utils/plugin-icons',()=>({PluginIcon:()=>null,isExternalPlatform:()=>false}));
vi.mock('../OrderStatusControls',()=>({OrderStatusControls:()=>null}));
vi.mock('../../../services/OrderSyncNoticeStore',()=>({useOrderNotices:()=>({status:'fresh',notices:[{orderId:'order',kind:'customer_correction_refused',queueId:'q',state:'refused',actions:[]}]}),openOrderNotice:vi.fn()}));
import OrderCard from '../OrderCard';
afterEach(cleanup);
it('the real order card opens its refused-correction notice with one tap',()=>{
 const open=vi.fn(),select=vi.fn();
 render(<OrderCard order={{id:'order',order_number:'125',order_type:'pickup',status:'pending',items:[],total_amount:10,created_at:new Date().toISOString()}} isSelected={false} onSelect={select} onDoubleClick={open}/>);
 fireEvent.click(screen.getByRole('button',{name:'Needs attention'}));
 expect(open).toHaveBeenCalledWith('order');expect(select).not.toHaveBeenCalled();
});
