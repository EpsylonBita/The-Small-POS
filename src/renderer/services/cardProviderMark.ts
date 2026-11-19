import { getBridge, offEvent, onEvent } from '../../lib';
import { getCachedTerminalCredentials } from './terminal-credentials';

type Answer = {
  admitted: boolean;
  fetchedAt: string;
  organizationId: string;
  branchId: string;
  terminalId: string;
};

let answer: Answer | null = null;
let generation = 0;
const row = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const nonblank = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
const identityKeys = ['organizationId', 'branchId', 'terminalId'] as const;

function inScope(candidate: Answer): boolean {
  let current: ReturnType<typeof getCachedTerminalCredentials>;
  try {
    current = getCachedTerminalCredentials();
  } catch {
    return false;
  }
  return identityKeys.every(key =>
    nonblank(current?.[key]) && current[key] === candidate[key]);
}

/** The in-memory answer counts only for a complete, matching identity. */
export function cardProviderState(): 'unknown' | 'none' | 'connected' {
  if (!answer || !inScope(answer)) return 'unknown';
  return answer.admitted ? 'connected' : 'none';
}

export function cardProviderConnected(): boolean {
  return cardProviderState() === 'connected';
}

export function lastNoProviderAnswerAt(): string | null {
  return cardProviderState() === 'none' ? answer?.fetchedAt ?? null : null;
}

/**
 * The only snapshot writer. A snapshot with no card answer clears the mark.
 * An answer for another complete identity, or one older than the answer held
 * for the same identity, is ignored: a late event cannot replace a newer one.
 */
export function applyCardProviderSnapshot(raw: unknown): void {
  const card = row(raw) && raw.success === true && row(raw.cardTerminal) ? raw.cardTerminal : null;
  if (!card || typeof card.admitted !== 'boolean' || !nonblank(card.fetchedAt)
    || !Number.isFinite(Date.parse(card.fetchedAt)) || !nonblank(card.organizationId)
    || !nonblank(card.branchId) || !nonblank(card.terminalId)) {
    generation += 1;
    answer = null;
    return;
  }
  const candidate: Answer = { admitted: card.admitted, fetchedAt: card.fetchedAt, organizationId: card.organizationId,
    branchId: card.branchId, terminalId: card.terminalId };

  try {
    const current = getCachedTerminalCredentials();
    if (identityKeys.every(key => nonblank(current?.[key]))
      && identityKeys.some(key => current[key] !== candidate[key])) return;
  } catch {
    // Unreadable credentials leave the candidate's scope undecided.
  }

  const previous = answer;
  if (previous && identityKeys.every(key => previous[key] === candidate[key])
    && Date.parse(candidate.fetchedAt) < Date.parse(previous.fetchedAt)) return;

  generation += 1;
  answer = candidate;
}

export function clearCardProviderMark(): void {
  applyCardProviderSnapshot(null);
}

/** Ignore an older local read if a newer update has arrived. */
export function beginCardProviderSnapshotRead(): (raw: unknown) => void {
  const started = ++generation;
  return raw => { if (started === generation) applyCardProviderSnapshot(raw); };
}

/** Read the stored native snapshot: at start and after a re-pair. Never awaited by the UI. */
export async function loadCardProviderMark(): Promise<void> {
  const applySnapshot = beginCardProviderSnapshotRead();
  try {
    applySnapshot(await getBridge().ecr.getDeviceAdmission());
  } catch {
    applySnapshot(null);
  }
}

export function startCardProviderMark(): () => void {
  const rePair = () => { clearCardProviderMark(); void loadCardProviderMark(); };
  const subscriptions: Array<[string, (raw: unknown) => void]> = [
    ['ecr:device-admission-updated', applyCardProviderSnapshot],
    ['terminal-credentials-updated', rePair],
    ['app:reset', clearCardProviderMark],
    ['terminal-disabled', clearCardProviderMark],
  ];
  subscriptions.forEach(([name, listener]) => onEvent(name, listener));
  // The stored answer arrives when it arrives; until then the mark is unknown
  // and a card records manually. It counts only for the cached identity.
  void loadCardProviderMark();
  return () => subscriptions.forEach(([name, listener]) => offEvent(name, listener));
}
