import type { RealtimeChannel } from '@supabase/supabase-js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SupportDoorbell } from '../SupportDoorbell';
import type { RealtimeAuthHealth } from '../../RealtimeAuthService';

const ipc = vi.hoisted(() => vi.fn());
vi.mock('../../../../lib/ipc-adapter', () => ({ supportIpc: ipc }));
const sessionId = '40000000-0000-4000-a000-000000000004';
let service: SupportDoorbell | null = null;
beforeEach(() => {
  ipc.mockReset().mockImplementation((command: string) => command === 'support_banner_state'
    ? new Promise(() => {}) : Promise.resolve({}));
});
afterEach(() => { service?.stop(); service = null; });

function setup() {
  let ring: () => void = () => {};
  let status: (value: string) => void = () => {};
  let authListener: (health: RealtimeAuthHealth) => void = () => {};
  let health: RealtimeAuthHealth = { status: 'authenticated', reason: null, retryAttempt: 0, updatedAt: 0 };
  const channel = {
    on: vi.fn((_type: string, _filter: { event: string }, callback: () => void) => { ring = callback; return channel; }),
    subscribe: vi.fn((callback: (value: string) => void) => { status = callback; return channel; }),
  } as RealtimeChannel;
  const client = { channel: vi.fn(() => channel), removeChannel: vi.fn(async () => 'ok' as const) };
  const auth = {
    ensureAuthenticated: vi.fn(async () => {}), getHealth: () => health,
    subscribe: vi.fn((listener: (value: RealtimeAuthHealth) => void) => { authListener = listener; return vi.fn(); }),
  };
  service = new SupportDoorbell(client, auth); service.start();
  return { service, client, auth, ring: () => ring(), status: (value: string) => status(value),
    loseAuth: () => { health = { ...health, status: 'disconnected', reason: 'permanent-denial' }; authListener(health); } };
}

describe('private support doorbell', () => {
  it('uses the shared terminal JWT and private topic, and ignores broadcast payloads', async () => {
    const harness = setup();
    await harness.service.setSession(sessionId);
    expect(harness.auth.ensureAuthenticated).toHaveBeenCalledOnce();
    expect(harness.client.channel).toHaveBeenCalledWith(`support:session:${sessionId}`, { config: { private: true } });
    harness.status('SUBSCRIBED');
    expect(ipc).toHaveBeenCalledWith('support_doorbell', { session_id: sessionId, healthy: true });
    harness.ring();
    expect(ipc).toHaveBeenCalledWith('support_doorbell', { session_id: sessionId });
  });
  it('reports a broken channel and retires it on stop without touching other channels', async () => {
    const harness = setup();
    await harness.service.setSession(sessionId);
    harness.status('CHANNEL_ERROR');
    expect(ipc).toHaveBeenCalledWith('support_doorbell', { session_id: sessionId, healthy: false });
    harness.service.stop();
    await vi.waitFor(() => expect(harness.client.removeChannel).toHaveBeenCalledOnce());
    ipc.mockClear(); harness.ring(); harness.status('SUBSCRIBED');
    expect(ipc).not.toHaveBeenCalled();
  });
  it('auth loss fences late rings and healthy callbacks', async () => {
    const harness = setup();
    await harness.service.setSession(sessionId);
    harness.loseAuth();
    ipc.mockClear(); harness.ring(); harness.status('SUBSCRIBED');
    expect(ipc).not.toHaveBeenCalledWith('support_doorbell', { session_id: sessionId });
    expect(ipc).not.toHaveBeenCalledWith('support_doorbell', { session_id: sessionId, healthy: true });
  });
  it('does not subscribe when terminal authentication fails', async () => {
    const harness = setup();
    harness.auth.ensureAuthenticated.mockRejectedValueOnce(new Error('No JWT'));
    await expect(harness.service.setSession(sessionId)).resolves.toBeUndefined();
    expect(harness.client.channel).not.toHaveBeenCalled();
    expect(ipc).toHaveBeenCalledWith('support_doorbell', { session_id: sessionId, healthy: false });
  });
  it('does not subscribe after stop races authentication', async () => {
    const harness = setup();
    let finish: () => void = () => {};
    harness.auth.ensureAuthenticated.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const pending = harness.service.setSession(sessionId);
    await vi.waitFor(() => expect(harness.auth.ensureAuthenticated).toHaveBeenCalledOnce());
    harness.service.stop(); finish(); await pending;
    expect(harness.client.channel).not.toHaveBeenCalled();
  });
  it('refuses an arbitrary topic suffix', async () => {
    const harness = setup();
    await harness.service.setSession('other:organization');
    expect(harness.client.channel).not.toHaveBeenCalled();
  });
});
