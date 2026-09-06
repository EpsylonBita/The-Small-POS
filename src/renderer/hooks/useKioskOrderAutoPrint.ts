/**
 * useKioskOrderAutoPrint — announces kiosk orders arriving on this terminal and
 * prints them once the operator has approved them.
 *
 * Listens to the same 'order-created' event that useOrderStore subscribes to
 * (emitted by the Rust sync engine when a remote order arrives). When a new
 * kiosk order matches the current terminal ID, it chimes and toasts so the
 * operator opens the approval panel — no Realtime subscriptions of its own.
 *
 * Printing is deliberately NOT done on arrival. A kiosk order lands as
 * 'pending' and the operator still has to pick a prep time and press Approve;
 * printing before that produced a slip for an order nobody had accepted yet
 * (and one that could still be declined). `printApprovedKioskOrder` is
 * therefore called by the approval handler, after the approval succeeds, so
 * the ticket carries the prep time the operator actually chose.
 *
 * Deduplication: a Map of recently printed order IDs with a 5-minute TTL
 * prevents duplicate prints when approval is retried or the same order is
 * approved through more than one path.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { getBridge, onEvent, offEvent } from '../../lib';
import type { Order } from '../../shared/types/orders';
import toast from 'react-hot-toast';
import { useI18n } from '../contexts/i18n-context';
import { formatCompactOrderNumberForDisplay } from '../utils/orderNumberUtils';

/** TTL in milliseconds for the deduplication set (5 minutes). */
const DEDUP_TTL_MS = 5 * 60 * 1000;

/** Interval for pruning expired entries from the dedup set. */
const PRUNE_INTERVAL_MS = 60 * 1000;

interface KioskAutoPrintResult {
  /** Number of kiosk orders printed after approval this session. */
  kioskOrderCount: number;
  /**
   * Enqueue the kitchen ticket and receipt for a kiosk order the operator has
   * just approved. Call it from the approval handler — never on arrival.
   * Non-kiosk orders are ignored, so the shared approval path (efood, Wolt,
   * phone and counter orders) is unaffected.
   */
  printApprovedKioskOrder: (order: Partial<Order> | null | undefined) => Promise<void>;
}

interface KioskReceiptPrinterOverride {
  host: string;
  port: number;
  label?: string | null;
}

function normalizeHost(value: string): string {
  return value.trim().toLowerCase();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function playKioskNotificationSound(): void {
  if (typeof window === 'undefined') {
    return;
  }

  const AudioContextCtor =
    window.AudioContext ||
    (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;

  if (!AudioContextCtor) {
    return;
  }

  try {
    const context = new AudioContextCtor();
    const masterGain = context.createGain();
    masterGain.gain.setValueAtTime(0.16, context.currentTime);
    masterGain.connect(context.destination);

    const notes = [
      { frequency: 440.0, start: 0, duration: 0.16 },
      { frequency: 554.37, start: 0.12, duration: 0.18 },
      { frequency: 659.25, start: 0.27, duration: 0.22 },
    ];

    for (const note of notes) {
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      const startsAt = context.currentTime + note.start;
      const endsAt = startsAt + note.duration;

      oscillator.type = 'sine';
      oscillator.frequency.setValueAtTime(note.frequency, startsAt);
      gain.gain.setValueAtTime(0.0001, startsAt);
      gain.gain.exponentialRampToValueAtTime(0.24, startsAt + 0.025);
      gain.gain.exponentialRampToValueAtTime(0.0001, endsAt);
      oscillator.connect(gain);
      gain.connect(masterGain);
      oscillator.start(startsAt);
      oscillator.stop(endsAt + 0.02);
    }

    window.setTimeout(() => {
      void context.close().catch(() => undefined);
    }, 900);
  } catch {
    // Audio is supplemental; browsers may block it until the operator has interacted.
  }
}

function parseConnectionJson(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'string' || !value.trim()) {
    return null;
  }

  try {
    const parsed = JSON.parse(value) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function parsePort(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return value;
  }

  if (typeof value === 'string') {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  }

  return null;
}

function parseHostAndPort(value: string): { host: string; port: number } | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  const match = trimmed.match(/^(.*):(\d+)$/);
  if (!match) {
    return null;
  }

  const host = match[1]?.trim();
  const port = match[2] ? Number.parseInt(match[2], 10) : Number.NaN;
  if (!host || !Number.isFinite(port) || port <= 0) {
    return null;
  }

  return { host, port };
}

function readReceiptPrinterOverride(order: Partial<Order>): KioskReceiptPrinterOverride | null {
  const metadataCandidate =
    order.ghost_metadata ?? (order as Order & { ghostMetadata?: unknown }).ghostMetadata ?? null;

  if (!isRecord(metadataCandidate)) {
    return null;
  }

  const kioskMetadata = isRecord(metadataCandidate.kiosk) ? metadataCandidate.kiosk : null;
  if (!kioskMetadata) {
    return null;
  }

  if (kioskMetadata.receiptRoutingMode !== 'dedicated_customer_printer') {
    return null;
  }

  const override = isRecord(kioskMetadata.receiptPrinterOverride)
    ? kioskMetadata.receiptPrinterOverride
    : null;
  if (!override) {
    return null;
  }

  const host = typeof override.host === 'string' ? override.host.trim() : '';
  const port = parsePort(override.port);
  if (!host || !port) {
    return null;
  }

  return {
    host,
    port,
    label: typeof override.label === 'string' ? override.label : null,
  };
}

function extractProfileEndpoint(profile: unknown): { host: string; port: number } | null {
  if (!isRecord(profile)) {
    return null;
  }

  const connection = parseConnectionJson(profile.connectionJson ?? profile.connection_json);
  if (connection) {
    const hostCandidate = [connection.ip, connection.host, connection.hostname, connection.address]
      .find((value): value is string => typeof value === 'string' && value.trim().length > 0);
    const portCandidate = parsePort(connection.port);

    if (hostCandidate && portCandidate) {
      return { host: hostCandidate, port: portCandidate };
    }
  }

  const resolvedAddressCandidate =
    typeof profile.resolvedAddress === 'string'
      ? profile.resolvedAddress
      : typeof profile.printerName === 'string'
        ? profile.printerName
        : null;

  return resolvedAddressCandidate ? parseHostAndPort(resolvedAddressCandidate) : null;
}

/**
 * Determines whether an order originated from a kiosk.
 * Checks source first, then legacy plugin / platform fields for 'kiosk'.
 */
export function isKioskOrder(order: Partial<Order>): boolean {
  const metadata =
    order.ghost_metadata ||
    (order as Partial<Order> & { ghostMetadata?: unknown }).ghostMetadata ||
    null;
  if (
    metadata &&
    typeof metadata === 'object' &&
    !Array.isArray(metadata) &&
    typeof (metadata as Record<string, unknown>).kiosk === 'object' &&
    (metadata as Record<string, unknown>).kiosk !== null
  ) {
    return true;
  }

  if (order.source === 'kiosk') {
    return true;
  }

  const plugin =
    order.plugin ||
    order.order_plugin ||
    order.platform ||
    order.order_platform ||
    null;
  return plugin === 'kiosk';
}

/**
 * Hook that auto-prints kitchen tickets and order receipts for kiosk orders
 * that are routed to the current POS terminal.
 *
 * @param currentTerminalId - The terminal ID of this POS device. When null/undefined
 *   the hook is inactive (no event listeners are attached).
 */
export function useKioskOrderAutoPrint(
  currentTerminalId: string | null | undefined,
): KioskAutoPrintResult {
  const [kioskOrderCount, setKioskOrderCount] = useState(0);
  const { t } = useI18n();

  // Dedup map: orderId -> timestamp when it was auto-printed
  const printedOrdersRef = useRef(new Map<string, number>());
  // Orders currently being enqueued. Guards against the order-created and
  // realtime-update events double-processing the same order, without permanently
  // claiming it: only a *successful* enqueue moves the order into
  // printedOrdersRef, so a failed enqueue stays eligible for retry instead of
  // being silently dropped behind a dedup mark.
  const inFlightOrdersRef = useRef(new Set<string>());
  // First-sighting notification (chime) tracking, separate from print success:
  // an order that keeps failing to enqueue must chime exactly once, not on every
  // realtime-update re-fire. Pruned on the same TTL as printedOrdersRef.
  const notifiedOrdersRef = useRef(new Map<string, number>());
  const receiptPrinterProfileCacheRef = useRef(new Map<string, string | null>());

  // Keep currentTerminalId in a ref so the event handler always sees the latest
  const terminalIdRef = useRef(currentTerminalId);
  terminalIdRef.current = currentTerminalId;

  const bridge = getBridge();

  const resolveReceiptPrinterProfileId = useCallback(
    async (order: Partial<Order>): Promise<string | null> => {
      const override = readReceiptPrinterOverride(order);
      if (!override) {
        return null;
      }

      const cacheKey = `${normalizeHost(override.host)}:${override.port}`;
      const cachedResult = receiptPrinterProfileCacheRef.current.get(cacheKey);
      if (cachedResult !== undefined) {
        return cachedResult;
      }

      try {
        const rawProfiles = await bridge.printer.listProfiles();
        const profiles = Array.isArray(rawProfiles)
          ? rawProfiles
          : isRecord(rawProfiles) && Array.isArray(rawProfiles.profiles)
            ? rawProfiles.profiles
            : [];

        const matchingProfile = profiles.find((profile) => {
          if (!isRecord(profile)) {
            return false;
          }

          if (profile.enabled === false) {
            return false;
          }

          const endpoint = extractProfileEndpoint(profile);
          return Boolean(
            endpoint &&
            normalizeHost(endpoint.host) === normalizeHost(override.host) &&
            endpoint.port === override.port,
          );
        });

        const profileId =
          isRecord(matchingProfile) && typeof matchingProfile.id === 'string'
            ? matchingProfile.id
            : null;

        if (!profileId) {
          console.warn(
            '[useKioskOrderAutoPrint] No receipt printer profile matched kiosk override; falling back to the parent terminal default printer.',
            override,
          );
        }

        receiptPrinterProfileCacheRef.current.set(cacheKey, profileId);
        return profileId;
      } catch (error) {
        console.warn(
          '[useKioskOrderAutoPrint] Failed to resolve kiosk receipt printer override; falling back to the parent terminal default printer.',
          error,
        );
        return null;
      }
    },
    [bridge.printer],
  );

  /**
   * Enqueue print jobs for a kiosk order. Both calls are fire-and-forget;
   * failures are logged but do not block the UI.
   */
  const enqueuePrintJobs = useCallback(
    async (order: Partial<Order>): Promise<boolean> => {
      const orderId = order.id;
      if (!orderId) return false;

      const orderNumber =
        (order as any).orderNumber ||
        (order as any).order_number ||
        orderId.slice(0, 8);
      const sourceLabel =
        (order as any).customerName ||
        (order as any).customer_name ||
        'Kiosk';
      const receiptPrinterProfileId = await resolveReceiptPrinterProfileId(order);

      // Enqueue kitchen ticket print
      let kitchenOk = false;
      try {
        const kitchenResult = await bridge.payments.printKitchenTicket({
          id: orderId,
          orderId,
          orderNumber,
          customerName:
            sourceLabel,
          orderType:
            (order as any).orderType ||
            (order as any).order_type ||
            'dine-in',
          tableNumber:
            (order as any).tableNumber ||
            (order as any).table_number ||
            null,
          notes:
            order.notes ||
            (order as any).special_instructions ||
            null,
          createdAt:
            (order as any).createdAt ||
            (order as any).created_at ||
            new Date().toISOString(),
          estimatedTime:
            (order as any).estimatedTime ||
            (order as any).estimated_time ||
            null,
          items: order.items || [],
        });
        kitchenOk = kitchenResult?.success === true;
        if (!kitchenOk) {
          console.warn(
            '[useKioskOrderAutoPrint] Kitchen ticket enqueue returned failure for order',
            orderId,
            kitchenResult?.error,
          );
        }
      } catch (err) {
        console.warn(
          '[useKioskOrderAutoPrint] Failed to enqueue kitchen ticket for order',
          orderId,
          err,
        );
      }

      // Enqueue order receipt print
      let receiptOk = false;
      try {
        const receiptResult = await bridge.payments.printReceipt({
          orderId,
          orderNumber,
          items: order.items || [],
          totalAmount:
            (order as any).totalAmount ??
            (order as any).total_amount ??
            0,
          paymentMethod:
            (order as any).paymentMethod ||
            (order as any).payment_method ||
            'card',
          customerName:
            sourceLabel,
          orderType:
            (order as any).orderType ||
            (order as any).order_type ||
            'dine-in',
          createdAt:
            (order as any).createdAt ||
            (order as any).created_at ||
            new Date().toISOString(),
          ...(receiptPrinterProfileId
            ? { printerProfileId: receiptPrinterProfileId }
            : {}),
        });
        receiptOk = receiptResult?.success === true;
        if (!receiptOk) {
          console.warn(
            '[useKioskOrderAutoPrint] Receipt enqueue returned failure for order',
            orderId,
            receiptResult?.error,
          );
        }
      } catch (err) {
        console.warn(
          '[useKioskOrderAutoPrint] Failed to enqueue receipt for order',
          orderId,
          err,
        );
      }

      // Success only when BOTH jobs were durably queued. The backend dedups on
      // (entity_type, entity_id), so a retry after a partial failure is idempotent.
      return kitchenOk && receiptOk;
    },
    [bridge.payments, resolveReceiptPrinterProfileId],
  );

  /**
   * Print a kiosk order the operator has just approved.
   *
   * Called from the approval handler rather than from an arrival event: a kiosk
   * order lands as 'pending' with the approval panel still asking for a prep
   * time, and printing at that moment produced a slip for an order that had not
   * been accepted (and could still be declined). Deliberately does not filter on
   * the terminal id — the operator approved it on this terminal, which is a
   * stronger signal than the order's routing fields.
   */
  const printApprovedKioskOrder = useCallback(
    async (order: Partial<Order> | null | undefined) => {
      const orderData = order as any;
      if (!orderData || !orderData.id) return;

      // Never touch non-kiosk orders — efood/Wolt, phone and counter orders keep
      // their existing print behaviour untouched.
      if (!isKioskOrder(orderData)) return;

      // Deduplication check
      const now = Date.now();
      if (printedOrdersRef.current.has(orderData.id)) {
        return;
      }
      // Guard against concurrent double-processing (a double-tapped Approve, or
      // an approval retried after a transient failure) while the enqueue below
      // is awaited.
      if (inFlightOrdersRef.current.has(orderData.id)) {
        return;
      }
      inFlightOrdersRef.current.add(orderData.id);
      // Always release the in-flight claim, even if something below throws — an
      // orphaned claim would block this order from ever being processed again
      // (the prune interval never touches inFlightOrdersRef).
      try {
        const rawOrderNumber =
          orderData.orderNumber ||
          orderData.order_number ||
          String(orderData.id).slice(0, 8);
        // Kiosk numbers encode the branch and business period; show operators the
        // same compact form the order screen and the slip use.
        const orderNumber =
          formatCompactOrderNumberForDisplay(rawOrderNumber, orderData.createdAt || orderData.created_at) ||
          rawOrderNumber;

        // Enqueue BEFORE claiming the order as printed. Only a durable enqueue marks
        // it done; a failed enqueue leaves the order un-marked so a later approval
        // can retry (backend dedup keeps retries idempotent), and surfaces an error
        // instead of a silent drop behind a false success toast.
        const enqueued = await enqueuePrintJobs(orderData);

        if (enqueued) {
          // Mark as printed only now that both jobs are durably queued.
          printedOrdersRef.current.set(orderData.id, now);
          setKioskOrderCount((prev) => prev + 1);
          toast.success(t('kioskAutoPrint.printedToast', {
            defaultValue: 'Kiosk order #{{orderNumber}} approved — sent to the printer.',
            orderNumber,
          }), {
            duration: 5000,
          });
        } else {
          // Stable per-order id so repeated retries update one toast instead of stacking.
          toast.error(t('kioskAutoPrint.printFailedToast', {
            defaultValue: 'Kiosk order #{{orderNumber}} received, but sending it to the printer failed. Check the print queue.',
            orderNumber,
          }), {
            id: `kiosk-print-failed-${orderData.id}`,
            duration: 7000,
          });
        }
      } finally {
        inFlightOrdersRef.current.delete(orderData.id);
      }
    },
    [enqueuePrintJobs, t],
  );

  useEffect(() => {
    // Do not attach listeners when there is no terminal identity
    if (!currentTerminalId) return;

    /**
     * A kiosk order for this terminal has arrived. Chime and toast so the
     * operator opens the approval panel — nothing is printed until they pick a
     * prep time and approve.
     */
    const handleOrderCreated = async (orderData: any) => {
      if (!orderData || !orderData.id) return;

      // Only process kiosk orders
      if (!isKioskOrder(orderData)) return;

      // Only process orders assigned to this terminal
      const orderTerminalId =
        orderData.terminal_id ||
        orderData.terminalId ||
        orderData.owner_terminal_id ||
        orderData.ownerTerminalId ||
        orderData.source_terminal_id ||
        orderData.sourceTerminalId ||
        null;

      if (orderTerminalId !== terminalIdRef.current) return;

      const now = Date.now();
      // Announce once per order — 'order-created' and 'order-realtime-update'
      // can both fire for the same arrival.
      if (notifiedOrdersRef.current.has(orderData.id)) {
        return;
      }
      notifiedOrdersRef.current.set(orderData.id, now);
      playKioskNotificationSound();

      const rawOrderNumber =
        orderData.orderNumber ||
        orderData.order_number ||
        String(orderData.id).slice(0, 8);
      const orderNumber =
        formatCompactOrderNumberForDisplay(rawOrderNumber, orderData.createdAt || orderData.created_at) ||
        rawOrderNumber;
      const sourceLabel =
        orderData.customerName ||
        orderData.customer_name ||
        t('kioskAutoPrint.sourceFallback', { defaultValue: 'Kiosk' });

      toast.success(t('kioskAutoPrint.newOrderToast', {
        defaultValue: 'New kiosk order #{{orderNumber}} received from {{sourceLabel}}.',
        orderNumber,
        sourceLabel,
      }), {
        duration: 5000,
      });
    };

    // Listen to the same event the order store uses for remote orders
    onEvent('order-created', handleOrderCreated);

    // Also listen to realtime updates in case kiosk orders arrive as updates
    // (e.g., when the order was initially created with terminal_id = null and
    // then updated by the kiosk flow)
    const handleOrderRealtimeUpdate = (orderData: any) => {
      if (!orderData || !orderData.id) return;
      // Only trigger for kiosk orders in 'pending' status (new orders)
      if (!isKioskOrder(orderData)) return;
      const status = orderData.status;
      if (status && status !== 'pending') return;
      // Delegate to the same handler (the notified guard protects against a
      // duplicate chime; neither path prints).
      void handleOrderCreated(orderData);
    };

    onEvent('order-realtime-update', handleOrderRealtimeUpdate);

    // Periodic pruning of the dedup set to prevent memory leaks
    const pruneInterval = setInterval(() => {
      const cutoff = Date.now() - DEDUP_TTL_MS;
      printedOrdersRef.current.forEach((timestamp, orderId) => {
        if (timestamp < cutoff) {
          printedOrdersRef.current.delete(orderId);
        }
      });
      notifiedOrdersRef.current.forEach((timestamp, orderId) => {
        if (timestamp < cutoff) {
          notifiedOrdersRef.current.delete(orderId);
        }
      });
    }, PRUNE_INTERVAL_MS);

    return () => {
      offEvent('order-created', handleOrderCreated);
      offEvent('order-realtime-update', handleOrderRealtimeUpdate);
      clearInterval(pruneInterval);
    };
  }, [currentTerminalId, t]);

  return { kioskOrderCount, printApprovedKioskOrder };
}
