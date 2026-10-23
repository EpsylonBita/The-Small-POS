/**
 * Appointment checkout claim: claim before money (vertical salon follow-ups,
 * 21/10/2026; contract §1, identical on Android).
 *
 * Before a till opens the cart of an appointment it asks the office for the
 * checkout claim (`POST /api/pos/appointments/{id}/checkout-claim`). Only the
 * till that holds a live claim may sell the appointment; the office refuses a
 * second till, and its order trigger refuses that till's order line too. The
 * claim lives 15 minutes on the office and is renewed every 5 minutes while
 * the cart is open. It is released when the cart closes without an order and
 * consumed by the office when the order arrives.
 *
 * Offline, a till may only continue with a claim it already holds and whose
 * lease has not run out (for example, the connection dropped mid-checkout).
 * An office without the route (404 without a code) is an older server: the
 * till continues as before.
 */
import { posApiFetch, type PosApiResult } from '../utils/api-helpers';
import { getResolvedTerminalIdentity } from './terminal-credentials';

export interface AppointmentCheckoutClaim {
  appointmentId: string;
  claimId: string;
  leaseExpiresAt: string;
}

export type AppointmentClaimOutcome =
  /** The office gave this till the claim (new or renewed). */
  | { kind: 'claimed'; claim: AppointmentCheckoutClaim }
  /** No connection, but this till still holds an unexpired claim. */
  | { kind: 'offline'; claim: AppointmentCheckoutClaim }
  /** An older office without the route: continue as before, without a claim. */
  | { kind: 'legacy' }
  | { kind: 'claimed_elsewhere'; terminal: string | null; leaseExpiresAt: string | null }
  | { kind: 'settled' }
  | { kind: 'not_found' }
  | { kind: 'needs_connection' }
  | { kind: 'failed'; error: string | null };

/** The cart may open: a claim is held, or the office predates claims. */
export function claimAllowsCheckout(outcome: AppointmentClaimOutcome): boolean {
  return outcome.kind === 'claimed' || outcome.kind === 'offline' || outcome.kind === 'legacy';
}

export const APPOINTMENT_CLAIM_RENEW_MS = 5 * 60_000;
/**
 * Stored leases are scoped to this till's canonical organization, branch and
 * terminal (codex review of PR #379, 22/10/2026; Android scopes its leases the
 * same way). After a re-pairing an old lease is never read, so it cannot
 * authorize an offline checkout on another terminal or tenant.
 */
const STORAGE_PREFIX = 'pos.appointmentCheckoutClaims.v2:';
/** Leases from before the scoping carry no identity and can prove nothing. */
const LEGACY_STORAGE_KEY = 'pos.appointmentCheckoutClaims.v1';

const memory = new Map<string, AppointmentCheckoutClaim>();
/** The storage key of the identity the memory belongs to; undefined until bound. */
let scopeKey: string | null | undefined;
/** Bumped on every identity change: an answer for an older identity is not kept. */
let scopeRevision = 0;

const isClaim = (value: unknown): value is AppointmentCheckoutClaim => {
  const claim = value as AppointmentCheckoutClaim | null;
  return Boolean(claim) && typeof claim!.appointmentId === 'string' && typeof claim!.claimId === 'string' &&
    typeof claim!.leaseExpiresAt === 'string' && Number.isFinite(Date.parse(claim!.leaseExpiresAt));
};

function hydrate(key: string): void {
  try {
    const stored = JSON.parse(localStorage.getItem(key) || '{}') as Record<string, unknown>;
    for (const value of Object.values(stored ?? {})) {
      if (isClaim(value) && !memory.has(value.appointmentId)) memory.set(value.appointmentId, value);
    }
  } catch {
    // Unreadable or blocked storage: memory still holds this session's claims.
  }
}

/**
 * Binds the store to the till's current identity. A different identity starts
 * from its own (possibly empty) leases; an incomplete identity reuses none.
 */
async function bindScope(): Promise<string | null> {
  let key: string | null = null;
  try {
    const { organizationId, branchId, terminalId } = await getResolvedTerminalIdentity();
    if (organizationId && branchId && terminalId) key = `${STORAGE_PREFIX}${JSON.stringify([organizationId, branchId, terminalId])}`;
  } catch {
    key = null;
  }
  if (key !== scopeKey) {
    scopeKey = key;
    scopeRevision += 1;
    memory.clear();
    try {
      localStorage.removeItem(LEGACY_STORAGE_KEY);
    } catch {
      // Blocked storage: nothing older can be read either.
    }
    if (key) hydrate(key);
  }
  return key;
}

function persist(): void {
  if (!scopeKey) return;
  try {
    if (memory.size === 0) localStorage.removeItem(scopeKey);
    else localStorage.setItem(scopeKey, JSON.stringify(Object.fromEntries(memory)));
  } catch {
    // Durable storage unavailable: the claim stays in memory for this session.
  }
}

/** This till's claim for the appointment while its lease runs; expired claims are dropped. */
export async function readStoredClaim(appointmentId: string, now = Date.now()): Promise<AppointmentCheckoutClaim | null> {
  if (!await bindScope()) return null;
  const claim = memory.get(appointmentId);
  if (!claim) return null;
  if (Date.parse(claim.leaseExpiresAt) <= now) {
    memory.delete(appointmentId);
    persist();
    return null;
  }
  return claim;
}

/** Keeps a claim for this till's identity; without a known identity nothing is kept. */
export async function rememberClaim(claim: AppointmentCheckoutClaim): Promise<void> {
  if (!await bindScope()) return;
  memory.set(claim.appointmentId, claim);
  persist();
}

export async function forgetClaim(appointmentId: string): Promise<void> {
  await bindScope();
  if (!memory.delete(appointmentId)) return;
  persist();
}

/** The terminal was reset or re-paired: every stored lease, of every identity, goes. */
export function clearStoredAppointmentClaims(): void {
  memory.clear();
  scopeKey = undefined;
  scopeRevision += 1;
  try {
    for (let index = localStorage.length - 1; index >= 0; index -= 1) {
      const key = localStorage.key(index);
      if (key && (key.startsWith(STORAGE_PREFIX) || key === LEGACY_STORAGE_KEY)) localStorage.removeItem(key);
    }
  } catch {
    // Blocked storage: nothing was persisted either.
  }
}

/** Tests only: forget the in-memory copy so the next read hydrates from storage. */
export function resetClaimMemoryForTests(): void {
  memory.clear();
  scopeKey = undefined;
}

const newClaimId = (): string => crypto.randomUUID();
const claimPath = (appointmentId: string) => `/api/pos/appointments/${encodeURIComponent(appointmentId)}/checkout-claim`;

const text = (value: unknown): string | null => (typeof value === 'string' && value.trim() ? value.trim() : null);

/**
 * The holder named by a 409 `APPOINTMENT_CHECKOUT_CLAIMED`. The browser
 * transport keeps the body in `errorBody`; the native one appends the body
 * JSON to its error text (`... (HTTP 409): {...}`).
 */
function claimHolder(result: PosApiResult): { terminal: string | null; leaseExpiresAt: string | null } {
  const read = (body: any) => {
    const claim = body?.claim;
    return claim && typeof claim === 'object'
      ? { terminal: text(claim.terminal_name) ?? text(claim.terminal_id), leaseExpiresAt: text(claim.lease_expires_at) }
      : null;
  };
  const fromBody = read(result.errorBody);
  if (fromBody) return fromBody;
  const raw = String(result.error ?? '');
  const marker = raw.indexOf('): {');
  const start = marker >= 0 ? marker + 3 : raw.indexOf('{');
  if (start >= 0) {
    try {
      const parsed = read(JSON.parse(raw.slice(start)));
      if (parsed) return parsed;
    } catch {
      // Not the office's JSON body: no holder details to show.
    }
  }
  return { terminal: null, leaseExpiresAt: null };
}

async function offlineOutcome(appointmentId: string, now: number): Promise<AppointmentClaimOutcome> {
  const stored = await readStoredClaim(appointmentId, now);
  return stored ? { kind: 'offline', claim: stored } : { kind: 'needs_connection' };
}

/**
 * Claims (or renews) the checkout of an appointment for this till. A new
 * checkout sends a fresh claim id; a renewal sends the claim id it holds.
 */
export async function claimAppointmentCheckout(
  appointmentId: string,
  options: { renew?: boolean; now?: () => number } = {},
): Promise<AppointmentClaimOutcome> {
  const now = options.now ?? Date.now;
  await bindScope();
  const revision = scopeRevision;
  const held = options.renew ? await readStoredClaim(appointmentId, now()) : null;
  const claimId = held?.claimId ?? newClaimId();
  let result: PosApiResult<{ success?: boolean; claim?: Record<string, unknown> }>;
  try {
    result = await posApiFetch(claimPath(appointmentId), { method: 'POST', body: JSON.stringify({ claim_id: claimId }) });
  } catch {
    return offlineOutcome(appointmentId, now());
  }

  if (result.success) {
    const body = result.data?.claim ?? {};
    const leaseExpiresAt = text(body.lease_expires_at);
    if (result.data?.success === false || !leaseExpiresAt || !Number.isFinite(Date.parse(leaseExpiresAt))) {
      return { kind: 'failed', error: null };
    }
    const claim = { appointmentId, claimId: text(body.claim_id) ?? claimId, leaseExpiresAt };
    // The till was reset or re-paired while the office answered: that claim
    // belongs to the old identity and must not open this identity's cart.
    await bindScope();
    if (revision !== scopeRevision) return { kind: 'failed', error: null };
    await rememberClaim(claim);
    return { kind: 'claimed', claim };
  }

  switch (result.code) {
    case 'APPOINTMENT_CHECKOUT_CLAIMED':
      await forgetClaim(appointmentId);
      return { kind: 'claimed_elsewhere', ...claimHolder(result) };
    case 'APPOINTMENT_ALREADY_SETTLED':
      await forgetClaim(appointmentId);
      return { kind: 'settled' };
    case 'APPOINTMENT_NOT_FOUND':
      await forgetClaim(appointmentId);
      return { kind: 'not_found' };
    default:
      break;
  }
  if (result.status === 404 && !result.code) return { kind: 'legacy' };
  // No answer from the office: the connection, a timeout or an office outage.
  if (result.status === undefined || result.status === 408 || result.status === 429 || result.status >= 500) {
    return offlineOutcome(appointmentId, now());
  }
  return { kind: 'failed', error: result.error ?? null };
}

/** The appointments a cart's lines settle (`appointment_id`), each once. */
export function appointmentIdsOfLines(lines: readonly unknown[]): string[] {
  const ids = lines.map(line => {
    const value = line as { appointment_id?: unknown; appointmentId?: unknown } | null;
    return value?.appointment_id ?? value?.appointmentId;
  });
  return [...new Set(ids.filter((id): id is string => typeof id === 'string' && id.length > 0))];
}

/**
 * Right before money moves, renews the claim of every appointment the cart
 * settles (codex review of PR #379, 22/10/2026; Android renews in
 * `confirmBeforePayment`). The first outcome that no longer allows the
 * checkout is returned and no payment may start; null means go on.
 */
export async function confirmAppointmentClaimsBeforePayment(
  lines: readonly unknown[],
): Promise<{ appointmentId: string; outcome: AppointmentClaimOutcome } | null> {
  for (const appointmentId of appointmentIdsOfLines(lines)) {
    const outcome = await claimAppointmentCheckout(appointmentId, { renew: true });
    if (!claimAllowsCheckout(outcome)) return { appointmentId, outcome };
  }
  return null;
}

/**
 * Releases this till's claim when the cart closes without an order (best
 * effort; the lease runs out by itself) and forgets it locally.
 */
export async function releaseAppointmentCheckout(appointmentId: string): Promise<void> {
  const held = await readStoredClaim(appointmentId);
  await forgetClaim(appointmentId);
  if (!held) return;
  try {
    await posApiFetch(`${claimPath(appointmentId)}?claim_id=${encodeURIComponent(held.claimId)}`, { method: 'DELETE' });
  } catch {
    // Best effort: the office drops the claim when its lease runs out.
  }
}
