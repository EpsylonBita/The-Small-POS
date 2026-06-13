/**
 * Guest billing (hotel folio) helpers shared by the desktop POS renderer.
 *
 * hotel-rooms-full-pass Task 10.4: the desktop view previously carried a
 * status vocabulary (`open/settled/pending_checkout`) that does not exist on
 * the server — the `guest_folios` DB CHECK only allows
 * `active | closed | disputed`, and `/api/pos/guest-billing` returns the
 * column verbatim. These helpers pin the server truth so the view, filters,
 * and tests share one vocabulary.
 */

export type FolioStatus = 'active' | 'closed' | 'disputed';

/** Server truth — mirrors the guest_folios status CHECK constraint. */
export const FOLIO_STATUSES: readonly FolioStatus[] = ['active', 'closed', 'disputed'];

export function isFolioStatus(value: unknown): value is FolioStatus {
  return typeof value === 'string' && (FOLIO_STATUSES as readonly string[]).includes(value);
}

export interface FolioStatusPresentation {
  /** i18n key under the guestBilling namespace. */
  labelKey: string;
  /** English fallback used until task 10.6 lands the locale entries. */
  defaultLabel: string;
  /** Full literal Tailwind classes (JIT-safe — never built dynamically). */
  badgeClass: string;
}

export const FOLIO_STATUS_PRESENTATION: Record<FolioStatus, FolioStatusPresentation> = {
  active: {
    labelKey: 'guestBilling.status.active',
    defaultLabel: 'Active',
    badgeClass: 'bg-blue-500/10 text-blue-500',
  },
  closed: {
    labelKey: 'guestBilling.status.closed',
    defaultLabel: 'Closed',
    badgeClass: 'bg-green-500/10 text-green-500',
  },
  disputed: {
    labelKey: 'guestBilling.status.disputed',
    defaultLabel: 'Disputed',
    badgeClass: 'bg-red-500/10 text-red-500',
  },
};

/** Charge types accepted by POST /api/pos/guest-billing/[folioId]/charges. */
export const FOLIO_CHARGE_TYPES = ['room', 'food', 'beverage', 'service', 'tax', 'other'] as const;
export type FolioChargeType = (typeof FOLIO_CHARGE_TYPES)[number];

/** Payment methods accepted by POST /api/pos/guest-billing/[folioId]/payments. */
export const FOLIO_PAYMENT_METHODS = ['cash', 'card', 'bank_transfer', 'other'] as const;
export type FolioPaymentMethod = (typeof FOLIO_PAYMENT_METHODS)[number];

/**
 * Endpoint builders for the existing POS folio routes. Paths are in the
 * renderer transport form (no `/api` prefix): `posApiFetch` resolves them via
 * `getApiUrl` in the browser and `toAdminApiPath` over the Tauri IPC bridge.
 */
export function folioChargesEndpoint(folioId: string): string {
  return `/pos/guest-billing/${encodeURIComponent(folioId)}/charges`;
}

export function folioPaymentsEndpoint(folioId: string): string {
  return `/pos/guest-billing/${encodeURIComponent(folioId)}/payments`;
}

export function folioCheckoutEndpoint(folioId: string): string {
  return `/pos/guest-billing/${encodeURIComponent(folioId)}/checkout`;
}

export interface FolioStatusSummary {
  activeCount: number;
  disputedCount: number;
  /** Sum of outstanding balances across ACTIVE folios only. */
  activeBalance: number;
}

export function summarizeFolios(
  folios: ReadonlyArray<{ status: FolioStatus; balance: number }>,
): FolioStatusSummary {
  return folios.reduce<FolioStatusSummary>(
    (acc, folio) => {
      if (folio.status === 'active') {
        acc.activeCount += 1;
        acc.activeBalance += Number.isFinite(folio.balance) ? folio.balance : 0;
      } else if (folio.status === 'disputed') {
        acc.disputedCount += 1;
      }
      return acc;
    },
    { activeCount: 0, disputedCount: 0, activeBalance: 0 },
  );
}

export interface FolioCheckoutOutstandingResult {
  outstanding: boolean;
  /** Parsed outstanding balance when the response carried one. */
  balance: number | null;
}

const OUTSTANDING_CODE = 'folio_checkout_outstanding';

/**
 * Detect the checkout route's 409 outstanding-balance denial across both
 * desktop transports (same dual-shape problem `isModuleRequiredApiError`
 * solves for module denials):
 *
 * - Browser fetch: `posApiFetch` keeps only `errorData.error` (the human
 *   message `Cannot complete checkout with outstanding balance X.`) plus
 *   `status: 409` — the structured `code`/`balance` fields are dropped.
 * - Tauri IPC: `admin_fetch` folds the entire JSON body into the error
 *   string (`"<message> (HTTP 409): {...,"code":"folio_checkout_outstanding",
 *   "balance":12.5,...}"`), and no `status` survives the bridge.
 */
export function parseFolioCheckoutOutstanding(
  error: string | null | undefined,
  status?: number,
): FolioCheckoutOutstandingResult {
  if (typeof error !== 'string' || error.length === 0) {
    return { outstanding: false, balance: null };
  }

  const messageMatch = error.match(/outstanding balance\s+(-?\d+(?:\.\d+)?)/i);
  const embeddedCode = error.includes(OUTSTANDING_CODE);
  const outstanding = embeddedCode || (status === 409 && messageMatch !== null);
  if (!outstanding) {
    return { outstanding: false, balance: null };
  }

  // Prefer the structured balance from the embedded IPC body, then the
  // human-readable message amount.
  const jsonMatch = error.match(/"balance"\s*:\s*(-?\d+(?:\.\d+)?)/);
  const raw = jsonMatch?.[1] ?? messageMatch?.[1] ?? null;
  const balance = raw !== null ? Number(raw) : null;
  return {
    outstanding: true,
    balance: balance !== null && Number.isFinite(balance) ? balance : null,
  };
}
