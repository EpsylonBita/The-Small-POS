import { useCallback, useEffect, useMemo, useRef } from 'react';
import {
  clearKdsLocalDraft,
  publishKdsLocalDraft,
  readKdsModifierLabels,
  type KdsLocalDraftItem,
} from '../services/KdsLocalDraftStore';
import { useResolvedPosIdentity } from './useResolvedPosIdentity';

/**
 * Mirrors the open order-entry cart onto the Windows kitchen display as a live
 * draft. Strictly local: drafts go only to the in-memory KdsLocalDraftStore
 * (no network, IPC or persistence) and carry no prices, catalog ids or
 * customer data.
 */

const PUBLISH_DEBOUNCE_MS = 400;
const DEFAULT_STATION = 'hot';

interface KdsDraftSyncItem {
  id?: string | number;
  name?: string;
  quantity?: number;
  notes?: string | null;
  station?: string | null;
  customizations?: unknown;
}

interface UseKdsLiveDraftSyncParams {
  enabled: boolean;
  isOpen: boolean;
  cartItems: KdsDraftSyncItem[];
  orderType?: string;
}

interface PublishedDraftKey {
  scope: string;
  sessionId: string;
}

function normalizeOrderType(value?: string): string {
  if (!value) {
    return 'pickup';
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === 'dine_in') return 'dine-in';
  if (normalized === 'drive_through') return 'drive-through';
  if (normalized === 'takeaway') return 'pickup';
  return normalized;
}

function createSessionId(): string {
  if (typeof globalThis.crypto?.randomUUID === 'function') {
    return globalThis.crypto.randomUUID();
  }
  return `kds-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function trimmedText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function toDraftItem(item: KdsDraftSyncItem, index: number): KdsLocalDraftItem {
  return {
    id: String(item.id ?? `item-${index + 1}`),
    name: trimmedText(item.name) || 'Unknown Item',
    quantity: Number.isFinite(item.quantity) ? Math.max(1, item.quantity || 1) : 1,
    station: trimmedText(item.station) || DEFAULT_STATION,
    notes: trimmedText(item.notes) || undefined,
    modifiers: readKdsModifierLabels(item.customizations),
  };
}

export function useKdsLiveDraftSync({
  enabled,
  isOpen,
  cartItems,
  orderType,
}: UseKdsLiveDraftSyncParams) {
  const { branchId, organizationId, terminalId, isReady } = useResolvedPosIdentity('branch+organization');
  // Must equal the KDS owner's scope key exactly. An empty scope never publishes.
  const scope = isReady && organizationId && branchId && terminalId
    ? `${organizationId}|${branchId}|${terminalId}`
    : '';
  const resolvedOrderType = normalizeOrderType(orderType);
  const items = useMemo(() => (cartItems || []).map(toDraftItem), [cartItems]);

  const sessionIdRef = useRef<string | null>(null);
  const publishTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const publishTokenRef = useRef(0);
  const lastFingerprintRef = useRef('');
  const publishedRef = useRef<PublishedDraftKey | null>(null);

  const clearScheduledPublish = useCallback(() => {
    if (publishTimerRef.current) {
      clearTimeout(publishTimerRef.current);
      publishTimerRef.current = null;
    }
  }, []);

  // Cancels the pending timer and invalidates its token in case it still fires.
  const cancelPendingPublish = useCallback(() => {
    publishTokenRef.current += 1;
    clearScheduledPublish();
  }, [clearScheduledPublish]);

  const clearPublishedDraft = useCallback(() => {
    const published = publishedRef.current;
    publishedRef.current = null;
    lastFingerprintRef.current = '';
    if (published) {
      clearKdsLocalDraft(published.scope, published.sessionId);
    }
  }, []);

  const clearDrafts = useCallback(async (explicitSessionId?: string | null): Promise<void> => {
    const sessionId = explicitSessionId || sessionIdRef.current;
    if (!sessionId) {
      return;
    }
    if (sessionId === sessionIdRef.current) {
      cancelPendingPublish();
    }
    if (publishedRef.current?.sessionId === sessionId) {
      clearPublishedDraft();
    }
  }, [cancelPendingPublish, clearPublishedDraft]);

  // One draft session per modal open. Close, edit mode (enabled=false) and
  // unmount clear the published draft and cancel queued publishes.
  useEffect(() => {
    if (!enabled || !isOpen) {
      return;
    }
    sessionIdRef.current = createSessionId();
    lastFingerprintRef.current = '';
    return () => {
      cancelPendingPublish();
      clearPublishedDraft();
      sessionIdRef.current = null;
    };
  }, [cancelPendingPublish, clearPublishedDraft, enabled, isOpen]);

  // A scope change (or unmount) clears the draft published under the old
  // scope before anything can publish under the new one.
  useEffect(() => () => {
    cancelPendingPublish();
    clearPublishedDraft();
  }, [cancelPendingPublish, clearPublishedDraft, scope]);

  // Debounced local publish while the modal is open under a resolved scope.
  useEffect(() => {
    const sessionId = sessionIdRef.current;
    if (!enabled || !isOpen || !scope || !sessionId) {
      return;
    }

    const fingerprint = JSON.stringify({ scope, sessionId, orderType: resolvedOrderType, items });
    if (fingerprint === lastFingerprintRef.current) {
      return;
    }

    cancelPendingPublish();
    const token = publishTokenRef.current;
    publishTimerRef.current = setTimeout(() => {
      publishTimerRef.current = null;
      if (token !== publishTokenRef.current || sessionIdRef.current !== sessionId) {
        return;
      }

      const published = publishedRef.current;
      if (published && (published.scope !== scope || published.sessionId !== sessionId)) {
        clearKdsLocalDraft(published.scope, published.sessionId);
      }
      // An empty cart publishes no items, which clears this session's draft.
      publishKdsLocalDraft({
        scope,
        sessionId,
        orderType: resolvedOrderType,
        items,
        updatedAt: new Date().toISOString(),
      });
      publishedRef.current = items.length > 0 ? { scope, sessionId } : null;
      lastFingerprintRef.current = fingerprint;
    }, PUBLISH_DEBOUNCE_MS);

    return () => {
      clearScheduledPublish();
    };
  }, [cancelPendingPublish, clearScheduledPublish, enabled, isOpen, items, resolvedOrderType, scope]);

  return {
    clearDrafts,
    sessionId: sessionIdRef.current,
  };
}
