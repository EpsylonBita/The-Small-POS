import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { z } from 'zod';
import { ConsentFetchResSchema, SupportAvailabilitySchema, supportLocaleFromUi, type ConsentFetchRes } from '../../../../shared/pos/support/consent';
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
  // Kept for older natives only. Who acts comes from `support_actors`, never from here.
  staff: z.object({ staff_id: z.string(), base_role: z.string() }).nullable().default(null),
  extend_allowed: z.boolean().default(false),
  critical_op_active: z.boolean().default(false),
  write_outcome: z.enum(['committed', 'rolled_back']).nullable().default(null),
}).transform(value => ({ ...value, operator_name: value.operator_name ?? value.operator_display_name ?? null,
  current_activity_key: value.current_activity_key ?? value.activity ?? null }));
export type SupportBannerSnapshot = z.infer<typeof SupportBannerSnapshotSchema>;

/** A staff member checked in on this till with a usable session from their own server check-in.
 * `base_roles` lists every base role they hold here, the primary (`base_role`) first. */
export const SupportActorSchema = z.object({ staff_id: z.string().min(1), name: z.string().default(''), base_role: z.string().default(''),
  base_roles: z.array(z.string()).optional() });
export type SupportActor = z.infer<typeof SupportActorSchema>;
/** The server accepts consent from any base role the person holds, not only the primary one. */
export function supportActorMayAccept(actor: SupportActor, acceptingBaseRoles: readonly string[]): boolean {
  return [actor.base_role, ...(actor.base_roles ?? [])].some(role => role !== '' && acceptingBaseRoles.includes(role));
}
/** On shift here, but their sign-in for support is missing or expired: they renew it with their PIN. */
export const SupportStaffOnShiftSchema = z.object({ staff_id: z.string().min(1), name: z.string().default('') });
export type SupportStaffOnShift = z.infer<typeof SupportStaffOnShiftSchema>;
export const SupportActorsSchema = z.object({
  state: z.enum(['ready', 'staff_required', 'sign_in_again']),
  actors: z.array(SupportActorSchema).default([]),
  renewable: z.array(SupportStaffOnShiftSchema).default([]),
});
export const SupportRenewSchema = z.object({ outcome: z.enum(['renewed', 'refused', 'offline']) });
export type SupportRenewOutcome = z.infer<typeof SupportRenewSchema>['outcome'] | 'error';
export type SupportActorPurpose = 'consent' | 'request' | 'extend';
export const SUPPORT_ACTOR_PROBLEMS = ['SUPPORT_STAFF_CHOICE_REQUIRED', 'SUPPORT_STAFF_REQUIRED', 'SUPPORT_SIGN_IN_AGAIN'] as const;
export type SupportActorProblem = (typeof SUPPORT_ACTOR_PROBLEMS)[number];
/** Native rejects with a bare code string; an Error or `{ code | message }` carrying it is read the same way. */
export function supportActorProblem(error: unknown): SupportActorProblem | null {
  const record = error && typeof error === 'object' ? error as Record<string, unknown> : null;
  const text = typeof error === 'string' ? error : error instanceof Error ? error.message
    : record ? [record.code, record.message, record.error].filter((part): part is string => typeof part === 'string').join(' ') : '';
  return SUPPORT_ACTOR_PROBLEMS.find(problem => new RegExp(`(?:^|[^A-Z_])${problem}(?:$|[^A-Z_])`).test(text)) ?? null;
}

/** The server already has a session for this till (409 `SESSION_LIMIT_REACHED`, e.g. its code was
 * just used). The till waits for it: never «try again» and never offline (04/11/2026). */
export function supportSessionStarting(error: unknown): boolean {
  const record = error && typeof error === 'object' ? error as Record<string, unknown> : null;
  const text = typeof error === 'string' ? error : error instanceof Error ? error.message
    : record ? [record.code, record.message, record.error].filter((part): part is string => typeof part === 'string').join(' ') : '';
  return /(?:^|[^A-Z_])SESSION_LIMIT_REACHED(?:$|[^A-Z_])/.test(text);
}
/** A session (pending acknowledgement or live) exists for this till, so no new code is asked for. */
export function supportSessionLive(snapshot: Pick<SupportBannerSnapshot, 'session_id' | 'state'> | null): boolean {
  return Boolean(snapshot?.session_id) && snapshot?.state !== 'ended';
}

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
/** `open`: a support connection is already open or waiting here; staff may end it to ask for a new code. */
export type SupportView = 'closed' | 'loading' | 'code' | 'consent' | 'pick' | 'staff_required' | 'sign_in_again' | 'open' | 'offline' | 'error' | 'expired';
export interface SupportSessionController {
  snapshot: SupportBannerSnapshot | null;
  view: SupportView;
  code: SupportCode | null;
  consent: ConsentFetchRes | null;
  /** Who can act on this till, newest check-in first (from the last `support_actors`). */
  actors: SupportActor[];
  /** The person acting in this support flow, chosen with one tap or the only one on shift. */
  actor: SupportActor | null;
  /** On shift here without a usable sign-in for support (from the last `support_actors`). */
  renewable: SupportStaffOnShift[];
  /** What the picker or staff notice is for. `extend` belongs to the banner, the rest to Health. */
  actorPurpose: SupportActorPurpose | null;
  busy: boolean;
  remainingMs: number;
  start(): Promise<void>;
  cancel(): Promise<void>;
  choose(staffId: string): Promise<void>;
  /** Back to the picker from the consent screen when several people can act. */
  changeActor(): void;
  /** Closes the extend picker or notice without touching the session. */
  dismiss(): void;
  accept(text: NonNullable<ConsentFetchRes['text']>): Promise<void>;
  decline(): Promise<void>;
  end(): Promise<void>;
  /** «Τερματισμός σύνδεσης»: ends the connection open or waiting here, on the till and on the server. */
  endExisting(): Promise<void>;
  /** Closes the «already open» notice and keeps waiting. */
  keepWaiting(): void;
  extend(): Promise<void>;
  /** Renews someone's sign-in with their PIN (the server check-in alone: no shift, checkout or sale),
   * then carries on with what they were doing. */
  renew(staffId: string, pin: string): Promise<SupportRenewOutcome>;
}
const SupportContext = createContext<SupportSessionController | null>(null);

/** One shell owner, shared by Health and the banner. Codes live only in memory. */
export function SupportSessionProvider({ children }: { children: React.ReactNode }) {
  const [snapshot, setSnapshot] = useState<SupportBannerSnapshot | null>(null);
  const [view, setView] = useState<SupportView>('closed');
  const [code, setCode] = useState<SupportCode | null>(null);
  const [consent, setConsentState] = useState<ConsentFetchRes | null>(null);
  const [actors, setActorsState] = useState<SupportActor[]>([]);
  const [actor, setActorState] = useState<SupportActor | null>(null);
  const [renewable, setRenewable] = useState<SupportStaffOnShift[]>([]);
  const [actorPurpose, setPurposeState] = useState<SupportActorPurpose | null>(null);
  const [busy, setBusy] = useState(false);
  const [remainingMs, setRemainingMs] = useState(0);
  const generation = useRef(0);
  const alive = useRef(true);
  const mutation = useRef(false);
  const expiry = useRef<number | null>(null);
  const current = useRef(snapshot);
  current.current = snapshot;
  // Async continuations read these, never a render's stale closure.
  const consentRef = useRef<ConsentFetchRes | null>(null);
  const actorsRef = useRef<SupportActor[]>([]);
  const actorRef = useRef<SupportActor | null>(null);
  const purposeRef = useRef<SupportActorPurpose | null>(null);
  const setConsent = (next: ConsentFetchRes | null) => { consentRef.current = next; setConsentState(next); };
  const setActors = (next: SupportActor[]) => { actorsRef.current = next; setActorsState(next); };
  const setActor = (next: SupportActor | null) => { actorRef.current = next; setActorState(next); };
  const setPurpose = (next: SupportActorPurpose | null) => { purposeRef.current = next; setPurposeState(next); };
  const live = (requestGeneration: number) => alive.current && requestGeneration === generation.current;
  // A shown code keeps its deadline in `expiry`; async continuations read refs, never a render's closure.
  const codeShown = () => expiry.current !== null && performance.now() < expiry.current;
  // The consent text is shown in the language the till is set to at that moment.
  const { i18n } = useTranslation();
  const uiLocale = useRef<string | undefined>(undefined);
  uiLocale.current = supportLocaleFromUi(i18n?.resolvedLanguage || i18n?.language);

  const refresh = useCallback(async () => {
    const requestGeneration = generation.current;
    const parsed = SupportBannerSnapshotSchema.parse(await supportIpc('support_banner_state'));
    if (alive.current && requestGeneration === generation.current) {
      current.current = parsed;
      setSnapshot(parsed);
      if (purposeRef.current === 'extend') {
        // The extend picker lives while the session does.
        if (!parsed.state || parsed.state === 'ended') { purposeRef.current = null; setPurposeState(null); setView('closed'); }
      } else if (parsed.state && parsed.state !== 'waiting') {
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

  const ask = (purpose: SupportActorPurpose) => { setPurpose(purpose); setActor(null); setView('pick'); };
  /** Native names who on shift here can act; nobody is assumed. */
  const loadActors = async (requestGeneration: number): Promise<SupportActor[] | null> => {
    const roster = SupportActorsSchema.parse(await supportIpc('support_actors'));
    if (!live(requestGeneration)) { return null; }
    const ready = roster.state === 'ready' ? roster.actors : [];
    setActors(ready); setRenewable(roster.renewable);
    if (ready.length === 0) { setView(roster.state === 'sign_in_again' ? 'sign_in_again' : 'staff_required'); return null; }
    return ready;
  };
  const issue = async (requestGeneration: number, chosen: SupportActor) => {
    const issued = SupportCodeSchema.parse(await supportIpc('support_request_code', { staff_id: chosen.staff_id }));
    if (!live(requestGeneration)) { return; }
    const ttl = Date.parse(issued.expires_at) - Date.parse(issued.server_time);
    if (ttl <= 0) { setView('expired'); return; }
    expiry.current = performance.now() + ttl;
    setCode(issued); setRemainingMs(ttl); setView('code');
    await refresh();
  };
  const loadConsent = async (requestGeneration: number) => {
    const locale = uiLocale.current;
    const fetched = SupportConsentResponseSchema.parse(await supportIpc('support_consent_fetch', locale ? { locale } : undefined));
    if (!live(requestGeneration)) { return; }
    const needed = fetched.state !== 'valid' && fetched.state !== 'exempt';
    setConsent(needed ? fetched : null);
    const chosen = actorRef.current;
    if (!chosen) { ask(needed ? 'consent' : 'request'); return; }
    if (needed) { setPurpose('consent'); setView('consent'); return; }
    setPurpose('request');
    await issue(requestGeneration, chosen);
  };
  const fail = async (requestGeneration: number, error: unknown) => {
    if (!live(requestGeneration)) { return; }
    if (supportSessionStarting(error)) {
      // The server already has a connection for this till: say so and offer to end it.
      // A shown code stays, and nothing says «try again» or offline.
      setPurpose(null); setView('open');
      if (!codeShown()) { setCode(null); expiry.current = null; }
      try { await refresh(); } catch { /* The next poll reads the till again. */ }
      return;
    }
    const purpose = purposeRef.current ?? 'request';
    setCode(null); expiry.current = null;
    const problem = supportActorProblem(error);
    if (!problem) {
      if (purpose === 'extend') { setPurpose(null); setView('error'); return; }
      setView(isTillKnownOffline() ? 'offline' : 'error'); return;
    }
    // Ask native again who is on shift: the chosen person may have checked out, or another checked in.
    const chosen = actorRef.current;
    let roster: z.infer<typeof SupportActorsSchema> | null = null;
    try { roster = SupportActorsSchema.parse(await supportIpc('support_actors')); } catch { /* Native already named the problem. */ }
    if (!live(requestGeneration)) { return; }
    if (roster) { setRenewable(roster.renewable); }
    const ready = roster?.state === 'ready' ? roster.actors : roster ? [] : actorsRef.current;
    if (ready.length > 0 && (problem === 'SUPPORT_STAFF_CHOICE_REQUIRED' || !chosen || !ready.some(person => person.staff_id === chosen.staff_id))) {
      setActors(ready); ask(purpose); return;
    }
    if (roster && roster.state !== 'ready') { setView(roster.state); return; }
    setView(problem === 'SUPPORT_SIGN_IN_AGAIN' ? 'sign_in_again' : problem === 'SUPPORT_STAFF_REQUIRED' ? 'staff_required' : 'error');
  };
  const start = async () => {
    if (mutation.current) { return; }
    // One code at a time: beside a shown code or an open session, explain instead of asking again.
    if (codeShown() || supportSessionLive(current.current)) { setPurpose(null); setView('open'); return; }
    setPurpose(null);
    if (isTillKnownOffline()) { setView('offline'); return; }
    mutation.current = true; setBusy(true);
    const requestGeneration = ++generation.current;
    try {
      // Native must expose the heartbeat's SupportAvailability as `availability`.
      // Missing, withdrawn or unsupported availability never enables issuance.
      const known = await refresh();
      if (!live(requestGeneration)) { return; }
      if (!known.availability?.available || known.availability.min_protocol_version > SUPPORT_PROTOCOL_VERSION || !known.can_connect) { return; }
      if (known.state && known.state !== 'waiting' && known.state !== 'ended') { setView('closed'); return; }
      setView('loading'); setCode(null); expiry.current = null;
      setPurpose('request'); setActor(null); setConsent(null);
      const ready = await loadActors(requestGeneration);
      if (!ready) { return; }
      // Exactly one person on shift acts without a picker.
      if (ready.length === 1) { setActor(ready[0]); }
      // Fetch afresh even after valid consent; a withdrawal/new version must re-prompt.
      await loadConsent(requestGeneration);
    } catch (error) { await fail(requestGeneration, error); }
    finally { mutation.current = false; if (alive.current) { setBusy(false); } }
  };
  const cancel = async () => {
    generation.current++; setCode(null); expiry.current = null; setView('closed'); setPurpose(null); setActor(null);
    try { await supportIpc('support_cancel_code'); await refresh(); }
    catch { /* Native owns offline refusal and durable invalidation. Keep the code hidden. */ }
  };
  const choose = async (staffId: string) => {
    const picked = actorsRef.current.find(person => person.staff_id === staffId);
    const purpose = purposeRef.current;
    if (!picked || !purpose || mutation.current) { return; }
    setActor(picked);
    if (purpose === 'extend') { generation.current++; setPurpose(null); setView('closed'); await extend(); return; }
    if (purpose === 'consent' && consentRef.current) { setView('consent'); return; }
    mutation.current = true; setBusy(true);
    const requestGeneration = ++generation.current;
    try { setPurpose('request'); setView('loading'); await issue(requestGeneration, picked); }
    catch (error) { await fail(requestGeneration, error); }
    finally { mutation.current = false; if (alive.current) { setBusy(false); } }
  };
  const changeActor = () => {
    if (mutation.current || actorsRef.current.length < 2 || !consentRef.current) { return; }
    generation.current++; ask('consent');
  };
  const dismiss = () => { generation.current++; setPurpose(null); setView('closed'); };
  const accept = async (text: NonNullable<ConsentFetchRes['text']>) => {
    const chosen = actorRef.current;
    const shown = consentRef.current;
    if (mutation.current || !chosen || !shown || !supportActorMayAccept(chosen, shown.accepting_base_roles) || shown.text !== text) { return; }
    mutation.current = true; setBusy(true);
    const requestGeneration = ++generation.current;
    try {
      try {
        await supportIpc('support_consent_accept', { staff_id: chosen.staff_id, text_id: text.text_id,
          text_version: text.version, locale: text.locale, text_sha256: text.body_sha256 });
      } catch (error) {
        if (supportActorProblem(error)) { throw error; }
        // A version race is resolved by fetching the published text again, never reusing acceptance.
      }
      if (live(requestGeneration)) { await loadConsent(requestGeneration); }
    } catch (error) { await fail(requestGeneration, error); }
    finally { mutation.current = false; if (alive.current) { setBusy(false); } }
  };
  const decline = async () => {
    const text = consentRef.current?.text;
    const chosen = actorRef.current;
    generation.current++; setView('closed'); setCode(null); expiry.current = null; setPurpose(null); setActor(null);
    const notice = { ...(text ? { text_id: text.text_id, text_sha256: text.body_sha256 } : {}), ...(chosen ? { staff_id: chosen.staff_id } : {}) };
    try { await supportIpc('support_consent_decline', Object.keys(notice).length ? notice : undefined); }
    catch { /* Native must append the local decline audit before attempting transport. */ }
  };
  const end = async () => {
    generation.current++; setCode(null); expiry.current = null; setView('closed'); setPurpose(null); setActor(null);
    try { await supportIpc('support_end'); await refresh(); }
    catch { /* End remains available; no network, permission or UI mutex gates it. */ }
  };
  const endExisting = async () => {
    if (mutation.current) { return; }
    mutation.current = true; setBusy(true);
    generation.current++; setCode(null); expiry.current = null; setPurpose(null); setActor(null);
    try { await supportIpc('support_end_open'); }
    catch { /* The till's own end already happened; the server ends what it still holds at its deadline. */ }
    finally { mutation.current = false; if (alive.current) { setBusy(false); setView('closed'); } }
    try { await refresh(); } catch { /* The next poll reads the till again. */ }
  };
  const keepWaiting = () => { setView(codeShown() ? 'code' : 'closed'); };
  async function extend() {
    if (!current.current?.extend_allowed) { return; }
    const chosen = actorRef.current;
    const requestGeneration = ++generation.current;
    setPurpose('extend');
    try {
      await (chosen ? supportIpc('support_extend', { staff_id: chosen.staff_id }) : supportIpc('support_extend'));
      if (live(requestGeneration)) { setPurpose(null); }
      await refresh();
    } catch (error) { await fail(requestGeneration, error); }
  }
  const renew = async (staffId: string, pin: string): Promise<SupportRenewOutcome> => {
    if (mutation.current || pin === '') { return 'error'; }
    mutation.current = true; setBusy(true);
    let outcome: SupportRenewOutcome = 'error';
    try { outcome = SupportRenewSchema.parse(await supportIpc('support_staff_renew', { staff_id: staffId, pin })).outcome; }
    catch { /* Native named the problem; the person may try again. */ }
    finally { mutation.current = false; if (alive.current) { setBusy(false); } }
    if (outcome !== 'renewed' || !alive.current) { return outcome; }
    if (purposeRef.current !== 'extend') { await start(); return outcome; }
    const requestGeneration = ++generation.current;
    try { if (await loadActors(requestGeneration)) { ask('extend'); } }
    catch (error) { await fail(requestGeneration, error); }
    return outcome;
  };
  return React.createElement(SupportContext.Provider, { value: { snapshot, view, code, consent, actors, actor, renewable, actorPurpose, busy, remainingMs,
    start, cancel, choose, changeActor, dismiss, accept, decline, end, endExisting, keepWaiting, extend, renew } }, children);
}
export function useSupportSession() { return useContext(SupportContext); }
