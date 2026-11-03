import type { RealtimeChannel } from '@supabase/supabase-js';
import { supportIpc } from '../../../lib/ipc-adapter';
import type { RealtimeAuthService } from '../RealtimeAuthService';
import type { TerminalRealtimeClient } from '../terminal-realtime-client';

/** Shares the terminal JWT/lifecycle used by RealtimeManager. A ring carries no command. */
export class SupportDoorbell {
  private channel: RealtimeChannel | null = null;
  private sessionId: string | null = null;
  private generation = 0;
  private stopped = true;
  private timer: ReturnType<typeof setInterval> | null = null;
  private unsubscribeAuth: (() => void) | null = null;

  constructor(private readonly client: Pick<TerminalRealtimeClient, 'channel' | 'removeChannel'>,
    private readonly auth: Pick<RealtimeAuthService, 'ensureAuthenticated' | 'getHealth' | 'subscribe'>) {}

  start(): void {
    if (!this.stopped) { return; }
    this.stopped = false;
    this.unsubscribeAuth = this.auth.subscribe(health => {
      if (health.status !== 'authenticated') { void this.setSession(null); }
    });
    let reading = false;
    const poll = async () => {
      if (this.stopped || reading) { return; }
      reading = true;
      const generation = this.generation;
      try {
        const value = await supportIpc('support_banner_state');
        if (this.stopped || generation !== this.generation) { return; }
        const state = value as { session_id?: unknown; state?: unknown } | null;
        const id = typeof state?.session_id === 'string' && state.state !== 'ended' ? state.session_id : null;
        await this.setSession(id);
      } catch { await this.setSession(null); }
      finally { reading = false; }
    };
    void poll();
    this.timer = setInterval(() => { void poll(); }, 3000);
  }

  async setSession(sessionId: string | null): Promise<void> {
    if (sessionId !== null && !/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(sessionId)) { return; }
    if (this.sessionId === sessionId && (sessionId === null || this.channel)) { return; }
    const generation = ++this.generation;
    const oldId = this.sessionId;
    const oldChannel = this.channel;
    this.sessionId = sessionId; this.channel = null;
    if (oldId) { await this.reportHealth(oldId, false); }
    if (oldChannel) {
      try { await this.client.removeChannel(oldChannel); } catch { /* Polling remains authoritative. */ }
    }
    if (!sessionId || this.stopped || generation !== this.generation) { return; }
    await this.reportHealth(sessionId, false);
    try {
      await this.auth.ensureAuthenticated();
      if (this.stopped || generation !== this.generation || this.auth.getHealth().status !== 'authenticated') { return; }
      const channel = this.client.channel(`support:session:${sessionId}`, { config: { private: true } });
      this.channel = channel;
      channel.on('broadcast', { event: '*' }, () => {
        if (!this.stopped && generation === this.generation && this.auth.getHealth().status === 'authenticated') {
          void supportIpc('support_doorbell', { session_id: sessionId }).catch(() => {});
        }
      }).subscribe(status => {
        if (!this.stopped && generation === this.generation) {
          void this.reportHealth(sessionId, status === 'SUBSCRIBED' && this.auth.getHealth().status === 'authenticated');
        }
      });
    } catch { await this.reportHealth(sessionId, false); }
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    this.unsubscribeAuth?.(); this.unsubscribeAuth = null;
    void this.setSession(null);
  }
  private async reportHealth(sessionId: string, healthy: boolean): Promise<void> {
    try { await supportIpc('support_doorbell', { session_id: sessionId, healthy }); }
    catch { /* An unreachable support service cannot affect other realtime features. */ }
  }
}
