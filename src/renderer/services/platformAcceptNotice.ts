/**
 * The cashier's notice after an accept whose preparation time the order's
 * platform took shorter than the one chosen (founder decision, 01/10/2026:
 * shorten it and say so; a longer time is changed afterwards in the
 * platform's own app).
 *
 * The server says so in its answer to this till's own accept
 * (`platform_ack.preparation_time`, admin pos-platform-ack-note.ts), which the
 * native accept passes on as `order-platform-ack` (Rust `order_approve`).
 * Everything shown comes from that answer: this module holds no rule about
 * any platform's limit. An accept the server made without this till (a
 * retry, an auto-accept, a queue replay) shows nothing.
 *
 * Android parity: POSSystemMobile/src/services/platformAcceptNotice.ts.
 */
import type { TFunction } from 'i18next';
import toast from 'react-hot-toast';

import { offEvent, onEvent } from '../../lib';
import { getPluginName } from '../utils/plugin-icons';

export const ORDER_PLATFORM_ACK_CHANNEL = 'order-platform-ack';

/**
 * How long an accept waits for its answer. The PATCH behind it gives up
 * after 8 s, so its answer arrives well within this.
 */
export const ACCEPT_ANSWER_WAIT_MS = 30_000;

const NOTICE_DURATION_MS = 12_000;

/** A preparation time the platform took shorter than asked, as the server said. */
export interface ShortenedPreparationTime {
  platform: string;
  requestedMinutes: number;
  sentMinutes: number;
  maxMinutes: number;
}

function positiveMinutes(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.round(value) : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * The shortened time in a server `platform_ack`, or null: only a delivered
 * accept the server marked `shortened` counts.
 */
export function readShortenedPreparationTime(platformAck: unknown): ShortenedPreparationTime | null {
  const ack = asRecord(platformAck);
  if (!ack || ack.success !== true || ack.action !== 'approved') return null;
  const time = asRecord(ack.preparation_time);
  if (!time || time.shortened !== true) return null;
  const platform = typeof ack.platform === 'string' ? ack.platform.trim() : '';
  const requestedMinutes = positiveMinutes(time.requested_minutes);
  const sentMinutes = positiveMinutes(time.sent_minutes);
  const maxMinutes = positiveMinutes(time.max_minutes);
  if (!platform || requestedMinutes === null || sentMinutes === null || maxMinutes === null) {
    return null;
  }
  return { platform, requestedMinutes, sentMinutes, maxMinutes };
}

export function describeShortenedPreparationTime(
  notice: ShortenedPreparationTime,
  t: TFunction,
): string {
  return t('orderApprovalPanel.preparationShortened', {
    platform: getPluginName(notice.platform),
    requested: notice.requestedMinutes,
    sent: notice.sentMinutes,
    max: notice.maxMinutes,
  });
}

export interface AcceptAnswerDeps {
  subscribe: (channel: string, callback: (payload: unknown) => void) => void;
  unsubscribe: (channel: string, callback: (payload: unknown) => void) => void;
  notify: (message: string) => void;
  waitMs: number;
}

const defaultDeps: AcceptAnswerDeps = {
  subscribe: (channel, callback) => onEvent(channel, callback),
  unsubscribe: (channel, callback) => offEvent(channel, callback),
  notify: (message) => {
    toast(message, { duration: NOTICE_DURATION_MS });
  },
  waitMs: ACCEPT_ANSWER_WAIT_MS,
};

/**
 * Listens for the server's answer to this till's accept of `orderId` and
 * tells the cashier once when the platform took a shorter preparation time.
 * Start it before the accept is sent (the answer can come back fast); the
 * returned function stops listening — for an accept that failed, which gets
 * no answer. It stops by itself after the answer or ACCEPT_ANSWER_WAIT_MS.
 */
export function noticeShortenedPreparationTime(
  orderId: string,
  t: TFunction,
  deps: Partial<AcceptAnswerDeps> = {},
): () => void {
  const { subscribe, unsubscribe, notify, waitMs } = { ...defaultDeps, ...deps };
  let done = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const stop = () => {
    if (done) return;
    done = true;
    if (timer !== null) clearTimeout(timer);
    unsubscribe(ORDER_PLATFORM_ACK_CHANNEL, onAnswer);
  };

  function onAnswer(payload: unknown): void {
    const answer = asRecord(payload);
    if (!answer || answer.orderId !== orderId) return;
    stop();
    const notice = readShortenedPreparationTime(answer.platformAck);
    if (notice) {
      notify(describeShortenedPreparationTime(notice, t));
    }
  }

  subscribe(ORDER_PLATFORM_ACK_CHANNEL, onAnswer);
  timer = setTimeout(stop, waitMs);
  return stop;
}
