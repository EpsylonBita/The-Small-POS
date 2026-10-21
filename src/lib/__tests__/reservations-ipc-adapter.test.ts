import { beforeEach, expect, it, vi } from 'vitest';
const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke }));
import { TauriBridge } from '../ipc-adapter';

beforeEach(() => invoke.mockReset());
it('sends the branch-calendar reservation range through the real native bridge', async () => {
  invoke.mockResolvedValue({success:true,data:{reservations:[]},meta:{source:'remote'}});
  const bridge = new TauriBridge();
  await bridge.reservations.list({kind:'table',date_from:'2026-10-20',date_to:'2026-10-21'});
  expect(invoke).toHaveBeenCalledWith('api_fetch_from_admin', expect.objectContaining({
    arg0:'/api/pos/reservations?kind=table&date_from=2026-10-20&date_to=2026-10-21',
  }));
});
it('keeps native local/cache provenance so arrival decoration cannot treat it as complete', async () => {
  for (const source of ['local', 'cache']) {
    const meta = {source,offlineFallback:true};
    invoke.mockResolvedValue({success:true,data:{reservations:[]},meta});
    expect(await new TauriBridge().reservations.list({date:'2026-10-21'})).toMatchObject({meta});
  }
});
