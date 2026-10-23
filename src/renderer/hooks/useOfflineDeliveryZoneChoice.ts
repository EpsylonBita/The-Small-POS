import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { DeliveryBoundaryValidationResponse } from '../../shared/types/delivery-validation';
import {
  readManualDeliveryZoneOptions,
  type ManualDeliveryZoneOption,
} from '../../../../shared/utils/offline-delivery-zone';
import { createManualDeliveryZoneResult } from '../utils/delivery-fee';
import { isUnlocatedZoneAddress, type SavedAddressLike } from '../utils/saved-address-geolocation';
import { isTillKnownOffline, subscribeServerReachability } from '../services/server-reachability';

/**
 * True while the till knows it cannot reach the admin server (no network, or
 * the native connectivity check says unreachable). Re-renders on every change.
 */
export function useTillKnownOffline(): boolean {
  const [offline, setOffline] = useState(() => isTillKnownOffline());
  useEffect(() => {
    const update = () => setOffline(isTillKnownOffline());
    const unsubscribe = subscribeServerReachability(update);
    if (typeof window !== 'undefined') {
      window.addEventListener('online', update);
      window.addEventListener('offline', update);
    }
    update();
    return () => {
      unsubscribe();
      if (typeof window !== 'undefined') {
        window.removeEventListener('online', update);
        window.removeEventListener('offline', update);
      }
    };
  }, []);
  return offline;
}

export interface OfflineDeliveryZoneChoiceInput {
  /** A new delivery order in a store with delivery zones (never an edit). */
  enabled: boolean;
  address: SavedAddressLike | null | undefined;
  /** The address's identity (savedAddressIdentityKey): a choice belongs to one address. */
  addressKey: string;
  /** The address has a usable point (its own fresh one, or one located): the zone is computed. */
  located: boolean;
  /** The address is being located: nothing to choose yet. */
  resolving: boolean;
  /** The caller handed over a checked zone verdict for this address. */
  providedZoneUsable: boolean;
  branchId?: string | null;
  /** The store's zones, local-first (the cached list offline). */
  loadZones: (branchId: string | null) => Promise<unknown>;
}

export interface OfflineDeliveryZoneChoice {
  /** The till knows it cannot reach the admin server. */
  offline: boolean;
  /** The cashier must choose, or has chosen, the zone: the computed verdict does not apply. */
  active: boolean;
  /** The zones the cashier can choose from (active zones with a fee). */
  options: ManualDeliveryZoneOption[];
  loading: boolean;
  selectedZoneId: string | null;
  choose: (zoneId: string) => void;
  /** The chosen zone's answer (fee, minimum, marker), or null while none is chosen. */
  zoneInfo: DeliveryBoundaryValidationResponse | null;
}

/**
 * Offline week Ω6β (coordinator decision 22/10/2026). Offline, a saved
 * address whose Google point expired (older than 28 days, FIX-03) or that has
 * no point cannot be located: the zone used to be "not checked" and the order
 * went out with delivery fee 0. Now the cashier chooses the zone from the
 * store's cached zones; its fee applies and the order is marked "zone chosen
 * manually". Never fee 0 without that choice; never the expired point.
 *
 * - Online nothing changes (the address is located and checked as before).
 * - A choice belongs to the address it was made for. It stays while that
 *   address still cannot be located, also when the connection returns; once
 *   the address is located online, its checked zone replaces the choice.
 * - Android does the same in CartReviewScreen (status 'manual_zone').
 */
export function useOfflineDeliveryZoneChoice({
  enabled,
  address,
  addressKey,
  located,
  resolving,
  providedZoneUsable,
  branchId,
  loadZones,
}: OfflineDeliveryZoneChoiceInput): OfflineDeliveryZoneChoice {
  const offline = useTillKnownOffline();
  const [choice, setChoice] = useState<{ key: string; zone: ManualDeliveryZoneOption } | null>(null);
  const [options, setOptions] = useState<ManualDeliveryZoneOption[]>([]);
  const [loading, setLoading] = useState(false);
  const loadZonesRef = useRef(loadZones);
  loadZonesRef.current = loadZones;

  const unlocated =
    enabled &&
    Boolean(address) &&
    !located &&
    !resolving &&
    !providedZoneUsable &&
    isUnlocatedZoneAddress(address);
  const chosenZone = choice && choice.key === addressKey ? choice.zone : null;
  const active = unlocated && (offline || chosenZone !== null);

  // A new order never inherits the previous order's choice.
  useEffect(() => {
    if (!enabled) {
      setChoice(null);
    }
  }, [enabled]);

  useEffect(() => {
    if (!active) {
      return;
    }
    let cancelled = false;
    setLoading(true);
    loadZonesRef
      .current(branchId ?? null)
      .then((result) => {
        if (!cancelled) {
          setOptions(readManualDeliveryZoneOptions(result));
        }
      })
      .catch((error: unknown) => {
        console.warn('[OfflineDeliveryZoneChoice] The cached delivery zones could not be read:', error);
        if (!cancelled) {
          setOptions([]);
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [active, branchId]);

  const choose = useCallback(
    (zoneId: string) => {
      const zone = options.find((option) => option.id === zoneId);
      if (zone) {
        setChoice({ key: addressKey, zone });
      }
    },
    [addressKey, options],
  );

  const zoneInfo = useMemo(
    () => (active && chosenZone ? createManualDeliveryZoneResult(chosenZone) : null),
    [active, chosenZone],
  );

  return {
    offline,
    active,
    options,
    loading,
    selectedZoneId: active && chosenZone ? chosenZone.id : null,
    choose,
    zoneInfo,
  };
}
