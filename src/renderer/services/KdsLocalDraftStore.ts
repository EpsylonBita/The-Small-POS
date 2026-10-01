/**
 * Live cart drafts for the Windows kitchen display. Memory only, in the POS
 * renderer: the order-entry modal publishes, the persistent KDS owner projects.
 * Drafts are display-only (never bumpable), never persisted and never sent to
 * the cloud. Every draft is keyed by the `organizationId|branchId|terminalId`
 * scope and its cart session.
 */
export interface KdsLocalDraftItem {
  id: string;
  name: string;
  quantity: number;
  station: string;
  notes?: string;
  modifiers?: string[];
}

export interface KdsLocalDraft {
  scope: string;
  sessionId: string;
  orderType: string;
  items: KdsLocalDraftItem[];
  updatedAt: string;
}

const MAX_LOCAL_DRAFTS = 20;
const MAX_MODIFIER_LABELS = 20;
const MODIFIER_LABEL_KEYS = ['name', 'label', 'optionName', 'option_name', 'title'];

let drafts: readonly KdsLocalDraft[] = [];
const listeners = new Set<() => void>();

const isSameDraft = (draft: KdsLocalDraft, scope: string, sessionId: string): boolean =>
  draft.scope === scope && draft.sessionId === sessionId;

function replaceDrafts(next: readonly KdsLocalDraft[]): void {
  drafts = next;
  listeners.forEach((listener) => listener());
}

export function clearKdsLocalDraft(scope: string, sessionId: string): void {
  if (!drafts.some((draft) => isSameDraft(draft, scope, sessionId))) return;
  replaceDrafts(drafts.filter((draft) => !isSameDraft(draft, scope, sessionId)));
}

export function publishKdsLocalDraft(draft: KdsLocalDraft): void {
  if (!draft.scope || !draft.sessionId) return;
  if (draft.items.length === 0) {
    clearKdsLocalDraft(draft.scope, draft.sessionId);
    return;
  }
  const others = drafts.filter((entry) => !isSameDraft(entry, draft.scope, draft.sessionId));
  replaceDrafts([...others, draft].slice(-MAX_LOCAL_DRAFTS));
}

export function clearAllKdsLocalDrafts(): void {
  if (drafts.length > 0) replaceDrafts([]);
}

export function getKdsLocalDrafts(): readonly KdsLocalDraft[] {
  return drafts;
}

export function subscribeKdsLocalDrafts(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Kitchen wording for removed and reduced ingredients; owners pass their translated text. */
export interface KdsModifierText {
  without: string;
  little: string;
}

const DEFAULT_MODIFIER_TEXT: KdsModifierText = { without: 'Without', little: 'Little' };

/**
 * Readable modifier labels from order or cart customizations (strings or option records).
 * A removed ingredient keeps its "without" wording so the kitchen never reads it as an addition.
 */
export function readKdsModifierLabels(value: unknown, text: KdsModifierText = DEFAULT_MODIFIER_TEXT): string[] | undefined {
  const entries = Array.isArray(value)
    ? value
    : value && typeof value === 'object'
      ? Object.values(value as Record<string, unknown>)
      : [];
  const labels: string[] = [];
  for (const entry of entries) {
    if (labels.length >= MAX_MODIFIER_LABELS) break;
    if (typeof entry === 'string') {
      if (entry.trim()) labels.push(entry.trim());
      continue;
    }
    if (!entry || typeof entry !== 'object') continue;
    const record = entry as Record<string, unknown>;
    const nested = [record['option'], record['ingredient'], record['customization']]
      .find((candidate) => candidate && typeof candidate === 'object') as Record<string, unknown> | undefined;
    const label = [...MODIFIER_LABEL_KEYS.map((key) => record[key]), nested?.['name']]
      .find((candidate): candidate is string => typeof candidate === 'string' && candidate.trim().length > 0);
    if (!label) continue;
    const quantity = Number(record['quantity']);
    labels.push(Number.isFinite(quantity) && quantity > 1 ? `${label.trim()} x${quantity}` : label.trim());
  }
  return labels.length > 0 ? labels : undefined;
}
