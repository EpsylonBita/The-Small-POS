/**
 * useKioskOrderAutoPrint — Automatically prints kitchen tickets and receipts
 * for orders arriving from kiosk terminals assigned to this POS terminal.
 *
 * Listens to the same 'order-created' event that useOrderStore subscribes to
 * (emitted by the Rust sync engine when a remote order arrives). When a new
 * kiosk order matches the current terminal ID, it enqueues print jobs via
 * the existing IPC bridge without creating additional Realtime subscriptions.
 *
 * Deduplication: a Set of recently auto-printed order IDs with a 5-minute TTL
 * prevents duplicate prints when the same order arrives through multiple event
 * paths (e.g., realtime + sync polling).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { getBridge, onEvent, offEvent } from '../../lib';
import type { Order } from '../../shared/types/orders';
import toast from 'react-hot-toast';

/** TTL in milliseconds for the deduplication set (5 minutes). */
const DEDUP_TTL_MS = 5 * 60 * 1000;

/** Interval for pruning expired entries from the dedup set. */
const PRUNE_INTERVAL_MS = 60 * 1000;

interface KioskAutoPrintResult {
  /** Number of kiosk orders auto-printed this session. */
  kioskOrderCount: number;
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
function isKioskOrder(order: Partial<Order>): boolean {
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

  // Dedup map: orderId -> timestamp when it was auto-printed
  const printedOrdersRef = useRef(new Map<string, number>());
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
    async (order: Partial<Order>) => {
      const orderId = order.id;
      if (!orderId) return;

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
      try {
        await bridge.payments.printKitchenTicket({
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
      } catch (err) {
        console.warn(
          '[useKioskOrderAutoPrint] Failed to enqueue kitchen ticket for order',
          orderId,
          err,
        );
      }

      // Enqueue order receipt print
      try {
        await bridge.payments.printReceipt({
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
      } catch (err) {
        console.warn(
          '[useKioskOrderAutoPrint] Failed to enqueue receipt for order',
          orderId,
          err,
        );
      }
    },
    [bridge.payments, resolveReceiptPrinterProfileId],
  );

  useEffect(() => {
    // Do not attach listeners when there is no terminal identity
    if (!currentTerminalId) return;

    const handleOrderCreated = (orderData: any) => {
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

      // Deduplication check
      const now = Date.now();
      if (printedOrdersRef.current.has(orderData.id)) {
        return;
      }

      // Mark as printed
      printedOrdersRef.current.set(orderData.id, now);
      setKioskOrderCount((prev) => prev + 1);

      const orderNumber =
        orderData.orderNumber ||
        orderData.order_number ||
        orderData.id.slice(0, 8);
      const sourceLabel =
        orderData.customerName ||
        orderData.customer_name ||
        'Kiosk';

      // Show toast notification for the new kiosk order
      toast.success(`New kiosk order #${orderNumber} received from ${sourceLabel}.`, {
        duration: 5000,
        icon: '🖥️',
      });

      // Fire-and-forget print job enqueue
      void enqueuePrintJobs(orderData);
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
      // Delegate to the same handler (dedup protects against double-print)
      handleOrderCreated(orderData);
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
    }, PRUNE_INTERVAL_MS);

    return () => {
      offEvent('order-created', handleOrderCreated);
      offEvent('order-realtime-update', handleOrderRealtimeUpdate);
      clearInterval(pruneInterval);
    };
  }, [currentTerminalId, enqueuePrintJobs]);

  return { kioskOrderCount };
}
