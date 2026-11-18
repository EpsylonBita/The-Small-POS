// @vitest-environment jsdom
import { renderHook, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { useOrderNoticeEditing } from '../useOrderNoticeEditing';
const invoke=vi.hoisted(()=>vi.fn().mockResolvedValue(null));
vi.mock('../../../lib',()=>({getBridge:()=>({invoke})}));
it('keeps one native window lease for all edited orders and releases on close',()=>{
  const hook=renderHook(({ids})=>useOrderNoticeEditing(ids),{initialProps:{ids:['first','first','second']}});
  const session=invoke.mock.calls[0][1].session;
  expect(invoke).toHaveBeenLastCalledWith('order_notice_editing',{session,orderIds:['first','second']});
  hook.rerender({ids:['third']});
  expect(invoke).toHaveBeenLastCalledWith('order_notice_editing',{session,orderIds:['third']});
  hook.unmount();
  expect(invoke).toHaveBeenLastCalledWith('order_notice_editing',{session,orderIds:[]});
});
it.each(['synchronous', 'rejected'] as const)('contains a %s bridge failure on mount and close', async kind => {
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
  invoke.mockImplementation(() => {
    if (kind === 'synchronous') throw new Error('bridge unavailable');
    return Promise.reject(new Error('bridge unavailable'));
  });
  const hook = renderHook(() => useOrderNoticeEditing(['order']));
  await waitFor(() => expect(warning).toHaveBeenCalledTimes(1));
  hook.unmount();
  await waitFor(() => expect(warning).toHaveBeenCalledTimes(2));
  invoke.mockResolvedValue(null);
});
