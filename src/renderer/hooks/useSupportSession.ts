import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import { ConsentFetchResSchema, SupportAvailabilitySchema, type ConsentFetchRes } from '../../../../shared/pos/support/consent';
import { SUPPORT_PROTOCOL_VERSION } from '../../../../shared/pos/support/protocol';
import { supportIpc } from '../../lib/ipc-adapter';
import { isTillKnownOffline } from '../services/server-reachability';

export const SUPPORT_BANNER_STATES = ['waiting', 'connected', 'executing', 'awaitingOnsite', 'deferredPayment', 'pausedOffline', 'restarting', 'ended'] as const;
const nativeStates = {
  none: null, code_pending: 'waiting', pending_ack: 'waiting', paused: 'pausedOffline', deferred: 'deferredPayment',
  awaiting_onsite: 'awaitingOnsite', waiting: 'waiting', connected: 'connected', executing: 'executing',
  awaitingOnsite: 'awaitingOnsite', deferredPayment: 'deferredPayment', pausedOffline: 'pausedOffline', restarting: 'restarting', ended: 'ended',
} as const;
export const SupportBannerSnapshotSchema = z.object({
  availability: SupportAvailabilitySchema.nullable().default(null),
  state: z.enum(Object.keys(nativeStates) as [keyof typeof nativeStates, ...(keyof typeof nativeStates)[]]).nullable()
    .transform(state => state === null ? null : nativeStates[state]),
  session_id: z.string().nullable().default(null),
  operator_name: z.string().nullable().optional(), operator_display_name: z.string().nullable().optional(),
  remaining_ms: z.number().nonnegative().default(0),
  current_activity_key: z.string().nullable().optional(), activity: z.string().nullable().optional(),
  can_connect: z.boolean().default(false),
  staff: z.object({ staff_id: z.string(), base_role: z.string() }).nullable().default(null),
  extend_allowed: z.boolean().default(false),
  critical_op_active: z.boolean().default(false),
  write_outcome: z.enum(['committed', 'rolled_back']).nullable().default(null),
}).transform(value => ({ ...value, operator_name: value.operator_name ?? value.operator_display_name ?? null,
  current_activity_key: value.current_activity_key ?? value.activity ?? null }));
export type SupportBannerSnapshot = z.infer<typeof SupportBannerSnapshotSchema>;

export const SupportCodeSchema = z.object({
  code_id: z.string().guid(), code: z.string().regex(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/),
  expires_at: z.iso.datetime(), server_time: z.iso.datetime(), terminal_name: z.string(),
  qr_url: z.url().refine(value => {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !url.search
      && url.pathname === '/admin/support/connect' && /^#(?:c=)?[A-Z0-9-]{8,9}$/.test(url.hash);
  }),
});
export type SupportCode = z.infer<typeof SupportCodeSchema>;
export const SupportConsentResponseSchema = ConsentFetchResSchema.extend({ server_time: z.iso.datetime().optional() });
export type SupportView = 'closed' | 'loading' | 'code' | 'consent' | 'offline' | 'error' | 'expired';
export interface SupportSessionController {
  snapshot: SupportBannerSnapshot | null;
  view: SupportView;
  code: SupportCode | null;
  consent: ConsentFetchRes | null;
  busy: boolean;
  remainingMs: number;
  start(): Promise<void>;
  cancel(): Promise<void>;
  accept(text: NonNullable<ConsentFetchRes['text']>): Promise<void>;
  decline(): Promise<void>;
  end(): Promise<void>;
  extend(): Promise<void>;
}
const SupportContext = createContext<SupportSessionController | null>(null);

/** One shell owner, shared by Health and the banner. Codes live only in memory. */
export function SupportSessionProvider({ children }: { children: React.ReactNode }) {
  const [snapshot, setSnapshot] = useState<SupportBannerSnapshot | null>(null);
  const [view, setView] = useState<SupportView>('closed');
  const [code, setCode] = useState<SupportCode | null>(null);
  const [consent, setConsent] = useState<ConsentFetchRes | null>(null);
  const [busy, setBusy] = useState(false);
  const [remainingMs, setRemainingMs] = useState(0);
  const generation = useRef(0);
  const alive = useRef(true);
  const mutation = useRef(false);
  const expiry = useRef<number | null>(null);
  const current = useRef(snapshot);
  current.current = snapshot;

  const refresh = useCallback(async () => {
    const requestGeneration = generation.current;
    const parsed = SupportBannerSnapshotSchema.parse(await supportIpc('support_banner_state'));
    if (alive.current && requestGeneration === generation.current) {
      current.current = parsed;
      setSnapshot(parsed);
      if (parsed.state && parsed.state !== 'waiting') {
        setCode(null); expiry.current = null; setView('closed');
      }
    }
    return parsed;
  }, []);

  useEffect(() => {
    alive.current = true;
    let reading = false;
    const poll = async () => {
      if (reading) { return; }
      reading = true;
      try { await refresh(); } catch {
        // Retain the visible session and its End control during IPC failures.
        if (alive.current) {
          setSnapshot(previous => previous ? { ...previous, availability: null, can_connect: false } : null);
        }
      } finally { reading = false; }
    };
    void poll();
    const timer = window.setInterval(() => { void poll(); }, 1000);
    return () => { alive.current = false; generation.current++; window.clearInterval(timer); };
  }, [refresh]);

  useEffect(() => {
    if (!code || expiry.current === null) { return; }
    const tick = () => {
      const left = Math.max(0, (expiry.current ?? 0) - performance.now());
      setRemainingMs(left);
      if (left === 0) { setCode(null); expiry.current = null; setView('expired'); }
    };
    tick();
    const timer = window.setInterval(tick, 250);
    return () => window.clearInterval(timer);
  }, [code]);

  const issue = async (requestGeneration: number) => {
    const staff = current.current?.staff;
    const response = staff ? await supportIpc('support_request_code', { staff_ref: { staff_id: staff.staff_id } })
      : await supportIpc('support_request_code');
    const issued = SupportCodeSchema.parse(response);
    if (!alive.current || requestGeneration !== generation.current) { return; }
    const ttl = Date.parse(issued.expires_at) - Date.parse(issued.server_time);
    if (ttl <= 0) { setView('expired'); return; }
    expiry.current = performance.now() + ttl;
    setCode(issued); setRemainingMs(ttl); setView('code');
    await refresh();
  };
  const loadConsent = async (requestGeneration: number) => {
    const fetched = SupportConsentResponseSchema.parse(await supportIpc('support_consent_fetch'));
    if (!alive.current || requestGeneration !== generation.current) { return; }
    if (fetched.state === 'valid' || fetched.state === 'exempt') { await issue(requestGeneration); return; }
    setConsent(fetched); setView('consent');
  };
  const failure = (requestGeneration: number) => {
    if (alive.current && requestGeneration === generation.current) {
      setCode(null); expiry.current = null; setView(isTillKnownOffline() ? 'offline' : 'error');
    }
  };
  const start = async () => {
    if (mutation.current) { return; }
    if (isTillKnownOffline()) { setView('offline'); return; }
    mutation.current = true; setBusy(true);
    const requestGeneration = ++generation.current;
    try {
      // Native must expose the heartbeat's SupportAvailability as `availability`.
      // Missing, withdrawn or unsupported availability never enables issuance.
      const known = await refresh();
      if (!alive.current || requestGeneration !== generation.current) { return; }
      if (!known.availability?.available || known.availability.min_protocol_version > SUPPORT_PROTOCOL_VERSION || !known.can_connect) { return; }
      if (known.state && known.state !== 'waiting' && known.state !== 'ended') { setView('closed'); return; }
      setView('loading'); setCode(null); expiry.current = null;
      // Fetch afresh even after valid consent; a withdrawal/new version must re-prompt.
      await loadConsent(requestGeneration);
    } catch { failure(requestGeneration); }
    finally { mutation.current = false; if (alive.current) { setBusy(false); } }
  };
  const cancel = async () => {
    generation.current++; setCode(null); expiry.current = null; setView('closed');
    try { await supportIpc('support_cancel_code'); await refresh(); }
    catch { /* Native owns offline refusal and durable invalidation. Keep the code hidden. */ }
  };
  const accept = async (text: NonNullable<ConsentFetchRes['text']>) => {
    const staff = current.current?.staff;
    if (mutation.current || !staff || !consent?.accepting_base_roles.includes(staff.base_role) || consent.text !== text) { return; }
    mutation.current = true; setBusy(true);
    const requestGeneration = ++generation.current;
    try {
      await supportIpc('support_consent_accept', { staff_id: staff.staff_id, text_id: text.text_id,
        text_version: text.version, locale: text.locale, text_sha256: text.body_sha256 });
      if (alive.current && requestGeneration === generation.current) { await loadConsent(requestGeneration); }
    } catch {
      // A version race is resolved by fetching the published text again, never reusing acceptance.
      try { await loadConsent(requestGeneration); } catch { failure(requestGeneration); }
    } finally { mutation.current = false; if (alive.current) { setBusy(false); } }
  };
  const decline = async () => {
    const text = consent?.text;
    generation.current++; setView('closed'); setCode(null); expiry.current = null;
    try { await supportIpc('support_consent_decline', text ? { text_id: text.text_id, text_sha256: text.body_sha256 } : undefined); }
    catch { /* Native must append the local decline audit before attempting transport. */ }
  };
  const end = async () => {
    generation.current++; setCode(null); expiry.current = null; setView('closed');
    try { await supportIpc('support_end'); await refresh(); }
    catch { /* End remains available; no network, permission or UI mutex gates it. */ }
  };
  const extend = async () => {
    if (!current.current?.extend_allowed) { return; }
    try { await supportIpc('support_extend'); await refresh(); }
    catch { if (alive.current) { setView('error'); } }
  };
  return React.createElement(SupportContext.Provider, { value: { snapshot, view, code, consent, busy, remainingMs,
    start, cancel, accept, decline, end, extend } }, children);
}
export function useSupportSession() { return useContext(SupportContext); }
