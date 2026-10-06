import type { TFunction } from 'i18next';

/**
 * Satellite cash handover refusals in till language (fix review 06/10/2026).
 * The shift screen used to show the server's raw codes (GIFT_CLOSE_REQUIRED,
 * STAFF_CUSTODY_UNRESOLVED, MOVEMENTS_UNAVAILABLE, ROLE_UNSUPPORTED, RETRY) and
 * an English-only SATELLITE_HANDOVER_PENDING on the main cashier's close.
 */
export type SatelliteHandoverReason =
  | 'giftClose'
  | 'staffCustody'
  | 'movements'
  | 'role'
  | 'retry'
  | 'closedElsewhere'
  | 'currency'
  | 'sourceDrawer'
  | 'receiver'
  | 'conflict'
  | 'mainOnly'
  | 'figures'
  | 'pending'
  | 'refused'
  | 'unknown';

const REASON_BY_CODE: Record<string, SatelliteHandoverReason> = {
  REMOTE_HANDOVER_GIFT_CLOSE_REQUIRED: 'giftClose',
  REMOTE_HANDOVER_STAFF_CUSTODY_UNRESOLVED: 'staffCustody',
  REMOTE_HANDOVER_MOVEMENTS_UNAVAILABLE: 'movements',
  REMOTE_HANDOVER_ROLE_UNSUPPORTED: 'role',
  REMOTE_HANDOVER_RETRY: 'retry',
  REMOTE_HANDOVER_PROOF_UNAVAILABLE: 'closedElsewhere',
  REMOTE_HANDOVER_CURRENCY_MISMATCH: 'currency',
  REMOTE_HANDOVER_SOURCE_DRAWER_UNAVAILABLE: 'sourceDrawer',
  REMOTE_HANDOVER_RECEIVER_MISMATCH: 'receiver',
  REMOTE_HANDOVER_DRAWER_UNAVAILABLE: 'receiver',
  SATELLITE_HANDOVER_RECEIVER_CHANGED: 'receiver',
  SATELLITE_HANDOVER_RECEIVER_UNAVAILABLE: 'receiver',
  REMOTE_HANDOVER_CONFLICT: 'conflict',
  SATELLITE_HANDOVER_PROOF_MISMATCH: 'conflict',
  SATELLITE_HANDOVER_VARIANCE_PROOF_MISMATCH: 'conflict',
  SATELLITE_HANDOVER_IDENTITY_MISMATCH: 'conflict',
  REMOTE_CHECKOUT_MAIN_ONLY: 'mainOnly',
  REMOTE_CHECKOUT_NOT_UNIT_CHILD: 'mainOnly',
  REMOTE_HANDOVER_FIGURES_UNAVAILABLE: 'figures',
  SATELLITE_HANDOVER_PENDING: 'pending',
  SATELLITE_HANDOVER_REFUSED: 'refused',
};

// No trailing word boundary: native detail may follow a code directly
// (`SATELLITE_HANDOVER_PROOF_MISMATCH_currency`).
const CODE_PATTERN = /\b(?:REMOTE|SATELLITE_HANDOVER)_[A-Z0-9_]*[A-Z0-9]/g;

function rawText(raw: unknown): string {
  if (typeof raw === 'string') return raw;
  if (raw instanceof Error) return raw.message;
  if (raw && typeof raw === 'object') {
    const candidate = raw as Record<string, unknown>;
    for (const key of ['message', 'error', 'reason', 'refusalCode', 'code']) {
      if (typeof candidate[key] === 'string') return candidate[key] as string;
    }
  }
  return '';
}

/** The most specific handover code in a refusal: the server's own first. */
export function satelliteHandoverCode(raw: unknown): string | null {
  const codes = rawText(raw).match(CODE_PATTERN) ?? [];
  const known = codes.map((code) =>
    Object.keys(REASON_BY_CODE).find((prefix) => code === prefix || code.startsWith(`${prefix}_`)) ?? code);
  return known.find((code) => code.startsWith('REMOTE_') && code in REASON_BY_CODE)
    ?? known.find((code) => code in REASON_BY_CODE && code !== 'SATELLITE_HANDOVER_REFUSED' && code !== 'SATELLITE_HANDOVER_PENDING')
    ?? known.find((code) => code in REASON_BY_CODE)
    ?? known[0]
    ?? null;
}

export interface SatelliteHandoverMessage {
  text: string;
  reason: SatelliteHandoverReason;
  /** Refused for good: a manager can release it as a close blocker. */
  refused: boolean;
  code: string | null;
}

export function isSatelliteHandoverRefusal(raw: unknown): boolean {
  return /\b(?:REMOTE_(?:HANDOVER|CHECKOUT)|SATELLITE_HANDOVER)_[A-Z0-9_]*[A-Z0-9]/.test(rawText(raw));
}

/** Plain till text for a handover refusal; null when it is not one. */
export function satelliteHandoverMessage(raw: unknown, t: TFunction): SatelliteHandoverMessage | null {
  if (!isSatelliteHandoverRefusal(raw)) return null;
  const text = rawText(raw);
  const code = satelliteHandoverCode(text);
  const reason: SatelliteHandoverReason = code ? REASON_BY_CODE[code] ?? 'unknown' : 'unknown';
  const refused = /\bSATELLITE_HANDOVER_REFUSED(?![A-Z_])/.test(text);
  // A refusal for good is never retried: a reason that otherwise says "then
  // try again" has its own sentence for it.
  const refusedReason = refused ? REFUSED_REASONS[reason] : undefined;
  const sentence = refusedReason
    ? String(t(`modals.staffShift.satelliteHandover.reasons.${refusedReason.key}`, {
      defaultValue: refusedReason.text,
    }))
    : String(t(`modals.staffShift.satelliteHandover.reasons.${reason}`, {
      defaultValue: DEFAULT_TEXT[reason],
    }));
  return {
    text: refused
      ? `${sentence} ${String(t('modals.staffShift.satelliteHandover.releaseHint', { defaultValue: RELEASE_HINT }))}`
      : sentence,
    reason,
    refused,
    code,
  };
}

const RELEASE_HINT =
  'A manager can release it so this shift can close. The satellite cash is not added to this drawer.';

const REFUSED_REASONS: Partial<Record<SatelliteHandoverReason, { key: string; text: string }>> = {
  staffCustody: {
    key: 'staffCustodyRefused',
    text: 'Drivers or waiters of this satellite shift still held cash when it was sent, so the server refused it. Close that shift on the satellite till itself.',
  },
  movements: {
    key: 'movementsRefused',
    text: "The satellite till's cash movements were not on the server when it was sent, so the server refused it. Close that shift on the satellite till itself.",
  },
};

const DEFAULT_TEXT: Record<SatelliteHandoverReason, string> = {
  giftClose: 'This satellite till has a gift card close to finish. Close that shift on the satellite till itself.',
  staffCustody: 'Drivers or waiters of this satellite shift still hold cash. Check them out first, then receive the cash.',
  movements: "The satellite till's cash movements have not reached the server yet. Wait until it syncs, then try again.",
  role: "This shift can't be closed from the main till. Close it on the satellite till.",
  retry: 'The server is busy with this shift right now. Try again in a moment.',
  closedElsewhere: "The satellite till already closed this shift itself, so its cash can't be received here.",
  currency: "This satellite shift's money is in another currency than this drawer. It can't be received here.",
  sourceDrawer: "The satellite till's cash drawer was not found or is already closed.",
  receiver: "This drawer can't receive the cash: it is closed, or it is not this till's open cashier drawer.",
  conflict: 'The server already recorded a different handover for this shift. Ask a manager to check it.',
  mainOnly: "Only this register's main till can receive cash from its satellite tills.",
  figures: "The shift figures couldn't be loaded from the server. Check the connection and try again.",
  pending: 'Satellite cash is still being received. Reconnect to the internet so it can finish before this shift closes.',
  refused: 'The server refused this satellite cash handover for good.',
  unknown: "The satellite cash handover couldn't be completed. Try again or ask a manager.",
};
