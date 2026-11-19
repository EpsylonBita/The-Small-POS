import type { TFunction } from 'i18next';

import { getBridge } from '../../lib';
import { parseEcrDeviceAdmission } from '../utils/ecr-device-type';
import { cardProviderConnected, lastNoProviderAnswerAt } from './cardProviderMark';
import { getCachedTerminalCredentials } from './terminal-credentials';

/**
 * An empty in-memory provider mark records today's manual card without reads.
 * A last no-provider answer supplies cached evidence; no answer supplies none.
 * A set, in-scope mark keeps the exact-scope live/offline admission route.
 */
export const MANUAL_CARD_ADMISSION_PATH = '/api/pos/payments/manual-admission';

export type ManualCardRefusal = 'terminal_configured' | 'provider_connected' | 'unavailable';

export type ManualCardAdmissionBasis = 'live' | 'cached';

/** A recorded manual card's admission, on its payment metadata (native keeps and syncs it). */
export type ManualCardAdmissionMetadata = { admission_basis: ManualCardAdmissionBasis; admission_checked_at: string };

export type ManualCardAdmission =
  /** `checkedAt`: when the answer that admitted it was read (now for live, the last known answer's time for cached). */
  | { admitted: true; basis: ManualCardAdmissionBasis; checkedAt: string }
  | { admitted: true; basis: 'none' }
  | { admitted: false; reason: ManualCardRefusal };

export type CardTerminalLookup =
  /** An enabled ECR terminal that is connected, ready and not busy. */
  | { kind: 'ready'; deviceId: string; name: string }
  /** An enabled ECR terminal exists but cannot take a card now (busy, disconnected, status unreadable). */
  | { kind: 'not_ready'; deviceId: string; name: string }
  /** Native reported no enabled, admitted ECR card terminal on this till. */
  | { kind: 'none' }
  /** The device lookup failed or answered something unreadable: never "no terminal". */
  | { kind: 'unavailable' };

type Row = Record<string, unknown>;

const isRow = (value: unknown): value is Row =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/**
 * The enabled, admitted default ECR card terminal from `ecr.getDefaultTerminal()`: the device
 * row, `null` only for an explicit "no device" answer, `undefined` for
 * anything else (an error reply or another shape is not proof of absence).
 */
function readDefaultDevice(raw: unknown): Row | null | undefined {
  if (!isRow(raw)) return undefined;
  const data = isRow(raw.data) ? raw.data : null;
  const device = raw.device ?? data?.device;
  if (isRow(device)) return device;
  if (raw.device === null || (data && data.device === null)) return null;
  return undefined;
}

const trimmed = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

/** This till's enabled, admitted ECR card terminal and whether it can take a card now. Never throws. */
export async function lookupCardTerminal(): Promise<CardTerminalLookup> {
  if (!cardProviderConnected()) { return { kind: 'none' }; }
  const bridge = getBridge();
  let device: Row | null | undefined;
  try {
    device = readDefaultDevice(await bridge.ecr.getDefaultTerminal());
  } catch {
    return { kind: 'unavailable' };
  }
  if (device === undefined) return { kind: 'unavailable' };
  if (device === null) return { kind: 'none' };
  const deviceId = trimmed(device.id);
  if (!deviceId) return { kind: 'unavailable' };
  const name = trimmed(device.name) || deviceId;
  try {
    const status: any = await bridge.ecr.getDeviceStatus(deviceId);
    return status?.connected === true && status?.ready === true && status?.busy !== true
      ? { kind: 'ready', deviceId, name }
      : { kind: 'not_ready', deviceId, name };
  } catch {
    return { kind: 'not_ready', deviceId, name };
  }
}

const refused = (reason: ManualCardRefusal): ManualCardAdmission => ({ admitted: false, reason });

/**
 * The last known answer native keeps for this terminal scope: "no provider connected" admits (cached), a provider
 * connected refuses, no answer or an unreadable one refuses as unavailable. No network.
 */
async function lastKnownAdmission(): Promise<ManualCardAdmission> {
  let snapshot: ReturnType<typeof parseEcrDeviceAdmission> = null;
  try {
    snapshot = parseEcrDeviceAdmission(await getBridge().ecr.getDeviceAdmission());
  } catch {
    return refused('unavailable');
  }
  const card = snapshot?.cardTerminal;
  if (!card || !card.fetchedAt || !Number.isFinite(Date.parse(card.fetchedAt))) return refused('unavailable');
  // Native's card admission is "a payment provider is connected for this branch".
  if (card.admitted) return refused('provider_connected');
  return { admitted: true, basis: 'cached', checkedAt: card.fetchedAt };
}

/**
 * Empty marks admit synchronously from memory. Set marks ask again on the
 * offer and confirm, retaining the existing exact-scope checks. Never throws.
 */
export async function admitManualCard(): Promise<ManualCardAdmission> {
  if (!cardProviderConnected()) {
    const at = lastNoProviderAnswerAt();
    return at ? { admitted: true, basis: 'cached', checkedAt: at } : { admitted: true, basis: 'none' };
  }
  const terminal = await lookupCardTerminal();
  if (terminal.kind === 'unavailable') return refused('unavailable');
  if (terminal.kind !== 'none') return refused('terminal_configured');

  // A copy: the identity this request was asked under, compared again after the read.
  const scope = { ...getCachedTerminalCredentials() };
  if (!scope.organizationId || !scope.branchId || !scope.terminalId) return refused('unavailable');
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return lastKnownAdmission();

  let response: unknown;
  try {
    response = await getBridge().adminApi.fetchFromAdmin(MANUAL_CARD_ADMISSION_PATH, { method: 'GET' });
  } catch {
    return lastKnownAdmission();
  }
  // The answer belongs to the identity that asked; a re-pair during the read voids it.
  const after = getCachedTerminalCredentials();
  if (after.organizationId !== scope.organizationId || after.branchId !== scope.branchId
    || after.terminalId !== scope.terminalId) return refused('unavailable');

  // A live answer decides when there is one. The native generic GET may serve
  // its own cache after an error (`meta.source: 'cache'`, `offlineFallback`):
  // that is not a live answer, so the last known admission decides instead
  // (founder 01/11/2026), as for a refused or failed request.
  if (!isRow(response) || response.success !== true) return lastKnownAdmission();
  const meta = isRow(response.meta) ? response.meta : null;
  if (!meta || meta.source !== 'remote' || meta.offlineFallback === true) return lastKnownAdmission();
  const body = isRow(response.data) ? response.data : null;
  if (!body || body.success !== true || body.admission_version !== 1
    || body.organization_id !== scope.organizationId || body.branch_id !== scope.branchId
    || body.terminal_id !== scope.terminalId || typeof body.provider_connected !== 'boolean') {
    return refused('unavailable');
  }
  if (body.provider_connected) return refused('provider_connected');
  return { admitted: true, basis: 'live', checkedAt: new Date().toISOString() };
}

/**
 * What a recorded manual card carries for the admin's read-time review: how it
 * was admitted and when that answer was read (Android `manualCardAdmissionMetadata`).
 * Nothing without an admission. Native keeps these on the payment and syncs them.
 */
export function manualCardAdmissionMetadata(
  admission: ManualCardAdmission | null | undefined,
): ManualCardAdmissionMetadata | undefined {
  return admission?.admitted && admission.basis !== 'none'
    ? { admission_basis: admission.basis, admission_checked_at: admission.checkedAt }
    : undefined;
}

export type ManualCardNotice = ManualCardRefusal | 'terminal_not_ready' | 'terminal_check_failed';

/** The cashier's sentence for a card that was not taken or a manual card that was not admitted. */
export function manualCardNoticeText(t: TFunction, notice: ManualCardNotice): string {
  switch (notice) {
    case 'terminal_not_ready':
      return t('payment.manualCard.terminalNotReady', {
        defaultValue: 'The card terminal is busy or not connected. Nothing was charged. Wait until it is free or reconnect it, then try again.',
      });
    case 'terminal_check_failed':
      return t('payment.manualCard.terminalCheckFailed', {
        defaultValue: 'Could not check the card terminal on this till. Nothing was charged. Try again.',
      });
    case 'terminal_configured':
      return t('payment.manualCard.terminalConfigured', {
        defaultValue: 'A card terminal is set up on this till. Take the card on the terminal. Nothing was recorded.',
      });
    case 'provider_connected':
      return t('payment.manualCard.providerConnected', {
        defaultValue: 'A card payment provider is connected for this store, so this till cannot record a manual card. Take the card on the card terminal. Nothing was recorded.',
      });
    case 'unavailable':
    default:
      return t('payment.manualCard.unavailable', {
        defaultValue: 'Could not confirm that a manual card is allowed on this till. Nothing was recorded. Check the internet connection and try again.',
      });
  }
}

/**
 * A refusal at the moment of recording: the cashier may already have taken
 * the card on the shop's own machine, so the refusal also says not to charge
 * it again (a missing record is repaired, never re-charged).
 */
export function manualCardRecordRefusalText(t: TFunction, reason: ManualCardRefusal): string {
  return `${manualCardNoticeText(t, reason)} ${t('payment.manualCard.alreadyTakenWarning', {
    defaultValue: "If the card was already taken on the shop's own card machine, do not charge it again.",
  })}`;
}

/** Maps a terminal lookup that cannot charge to its notice; `null` for a ready terminal or none at all. */
export function terminalLookupNotice(lookup: CardTerminalLookup): ManualCardNotice | null {
  if (lookup.kind === 'not_ready') return 'terminal_not_ready';
  if (lookup.kind === 'unavailable') return 'terminal_check_failed';
  return null;
}
