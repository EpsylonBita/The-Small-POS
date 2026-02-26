import { useCallback, useEffect, useMemo, useRef } from 'react';
import { posApiFetch } from '../utils/api-helpers';
import { useResolvedPosIdentity } from './useResolvedPosIdentity';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PUBLISH_DEBOUNCE_MS = 400;

interface KdsDraftSyncItem {
  id?: string | number;
  menuItemId?: string;
  menu_item_id?: string;
  category_id?: string | null;
  categoryId?: string | null;
  station_id?: string | null;
  stationId?: string | null;
  name?: string;
  quantity?: number;
  notes?: string | null;
  customizations?: unknown;
  unitPrice?: number;
  unit_price?: number;
  price?: number;
}

interface UseKdsLiveDraftSyncParams {
  enabled: boolean;
  isOpen: boolean;
  cartItems: KdsDraftSyncItem[];
  orderType?: string;
  customerName?: string | null;
}

function isValidUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value.trim());
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

export function useKdsLiveDraftSync({
  enabled,
  isOpen,
  cartItems,
  orderType,
  customerName,
}: UseKdsLiveDraftSyncParams) {
  const { branchId, organizationId, terminalId, isReady } = useResolvedPosIdentity('branch+organization');
  const sessionIdRef = useRef<string | null>(null);
  const publishTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const publishTokenRef = useRef(0);
  const lastFingerprintRef = useRef<string>('');
  const didPublishRef = useRef(false);

  const resolvedOrderType = normalizeOrderType(orderType);
  const resolvedCustomerName = (customerName || '').trim() || null;

  const normalizedItems = useMemo(() => {
    return (cartItems || [])
      .map((item, index) => {
        const menuItemIdRaw = item.menu_item_id || item.menuItemId;
        const menuItemId = isValidUuid(menuItemIdRaw) ? menuItemIdRaw.trim() : null;
        const categoryIdRaw = item.category_id || item.categoryId;
        const categoryId = isValidUuid(categoryIdRaw) ? categoryIdRaw.trim() : null;
        const stationIdRaw = item.station_id || item.stationId;
        const stationId = isValidUuid(stationIdRaw) ? stationIdRaw.trim() : null;
        const quantity = Number.isFinite(item.quantity) ? Math.max(1, item.quantity || 1) : 1;
        const unitPrice = Math.max(0, Number(item.unitPrice ?? item.unit_price ?? item.price ?? 0));
        const name = (item.name || '').trim() || 'Unknown Item';
        const notes = typeof item.notes === 'string' ? item.notes.trim() || null : null;

        return {
          id: String(item.id ?? `item-${index + 1}`),
          menu_item_id: menuItemId,
          category_id: categoryId,
          station_id: stationId,
          name,
          quantity,
          unit_price: unitPrice,
          notes,
          customizations: item.customizations ?? null,
        };
      })
      .filter((item) => item.quantity > 0);
  }, [cartItems]);

  const ensureSessionId = useCallback(() => {
    if (!sessionIdRef.current) {
      sessionIdRef.current = createSessionId();
    }
    return sessionIdRef.current;
  }, []);

  const clearScheduledPublish = useCallback(() => {
    if (publishTimerRef.current) {
      clearTimeout(publishTimerRef.current);
      publishTimerRef.current = null;
    }
  }, []);

  const clearDrafts = useCallback(async () => {
    const sessionId = sessionIdRef.current;
    if (!sessionId || !terminalId || !branchId || !organizationId) {
      return;
    }

    try {
      await posApiFetch('/api/pos/kds/live-drafts', {
        method: 'DELETE',
        body: JSON.stringify({ session_id: sessionId }),
      });
    } catch (error) {
      console.warn('[useKdsLiveDraftSync] Failed to clear live draft:', error);
    }
  }, [branchId, organizationId, terminalId]);

  // New modal-open session.
  useEffect(() => {
    if (!enabled) {
      return;
    }

    if (isOpen) {
      sessionIdRef.current = createSessionId();
      lastFingerprintRef.current = '';
      didPublishRef.current = false;
      return;
    }

    clearScheduledPublish();
    if (didPublishRef.current) {
      void clearDrafts();
    }
    sessionIdRef.current = null;
    lastFingerprintRef.current = '';
    didPublishRef.current = false;
  }, [clearDrafts, clearScheduledPublish, enabled, isOpen]);

  // Debounced publish while modal is open.
  useEffect(() => {
    if (!enabled || !isOpen || !isReady || !terminalId || !branchId || !organizationId) {
      return;
    }

    const sessionId = ensureSessionId();
    if (!sessionId) {
      return;
    }

    const fingerprint = JSON.stringify({
      sessionId,
      orderType: resolvedOrderType,
      customerName: resolvedCustomerName,
      items: normalizedItems,
    });

    if (lastFingerprintRef.current === fingerprint) {
      return;
    }

    clearScheduledPublish();
    const token = ++publishTokenRef.current;

    publishTimerRef.current = setTimeout(() => {
      publishTimerRef.current = null;

      if (token !== publishTokenRef.current) {
        return;
      }

      const run = async () => {
        try {
          if (normalizedItems.length === 0) {
            if (didPublishRef.current) {
              await posApiFetch('/api/pos/kds/live-drafts', {
                method: 'DELETE',
                body: JSON.stringify({ session_id: sessionId }),
              });
              didPublishRef.current = false;
            }
            lastFingerprintRef.current = fingerprint;
            return;
          }

          await posApiFetch('/api/pos/kds/live-drafts', {
            method: 'POST',
            body: JSON.stringify({
              session_id: sessionId,
              order_type: resolvedOrderType,
              customer_name: resolvedCustomerName,
              items: normalizedItems,
            }),
          });

          didPublishRef.current = true;
          lastFingerprintRef.current = fingerprint;
        } catch (error) {
          console.warn('[useKdsLiveDraftSync] Failed to sync live draft:', error);
        }
      };

      void run();
    }, PUBLISH_DEBOUNCE_MS);

    return () => {
      clearScheduledPublish();
    };
  }, [
    branchId,
    clearScheduledPublish,
    enabled,
    ensureSessionId,
    isOpen,
    isReady,
    normalizedItems,
    organizationId,
    resolvedCustomerName,
    resolvedOrderType,
    terminalId,
  ]);

  // Safety cleanup.
  useEffect(() => {
    return () => {
      clearScheduledPublish();
      if (didPublishRef.current) {
        void clearDrafts();
      }
    };
  }, [clearDrafts, clearScheduledPublish]);

  return {
    clearDrafts,
    sessionId: sessionIdRef.current,
  };
}
