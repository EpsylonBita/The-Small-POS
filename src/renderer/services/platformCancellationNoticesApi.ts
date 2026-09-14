/**
 * Read-only client for `GET /pos/platforms/cancellations` — the authoritative
 * source of provider ("platform") order cancellations for this terminal.
 * Native realtime/status events are only a hint to re-check this endpoint
 * (see the hook); an ordinary staff cancellation never reaches here, because
 * the backend only ever returns cancellations it recorded as
 * `platform_cancelled`.
 */

import { posApiGet } from '../utils/api-helpers';
import {
  isValidPlatformCancellationNotice,
  type PlatformCancellationNotice,
} from './platformCancellationNoticeStore';

interface RawCancellationsResponse {
  error?: unknown;
  success?: unknown;
  scope?: unknown;
  notices?: unknown;
  next_cursor?: unknown;
}

export interface FetchAllCancellationNoticesResult {
  /** True only if every page fetched was well-formed and pagination reached its end, or was
   * healthy and only stopped because it hit the page cap (see `incomplete`/`resumeCursor`). */
  ok: boolean;
  /** The server-derived scope observed, if any page returned one. */
  scope: string | null;
  /**
   * Valid notices collected under `scope` before a stop condition was hit —
   * never silently dropped. Empty whenever `scope` changed mid-scan: notices
   * read under the old scope must never be attached to the new one.
   */
  notices: PlatformCancellationNotice[];
  /** True when the scan stopped before reaching the end (bad shape/notice, repeated or missing
   * cursor, scope change, or the page cap). */
  incomplete: boolean;
  /**
   * Cursor to resume from on the *next* call so a scan that hit the page cap
   * continues where it left off instead of restarting at page 1 (which,
   * combined with a bounded cap, would never reach later pages at all).
   * Null whenever resuming makes no sense: the scan finished, a page
   * outright failed (so the very same page must be retried instead of
   * blindly moving forward), or the scope changed (a fresh scan is
   * required under the new scope).
   */
  resumeCursor: string | null;
}

// Bounds a single fetch cycle so a misbehaving backend cannot spin this
// terminal forever within one call; 50 pages * 100 notices/page is far
// beyond one day's worth of cancellations for a single terminal. Hitting the
// cap is not an error — `resumeCursor` lets the caller's next cycle pick up
// exactly where this one stopped.
const MAX_PAGES = 50;

const ENDPOINT = 'pos/platforms/cancellations';

function buildEndpoint(cursor: string | null): string {
  return cursor ? `${ENDPOINT}?cursor=${encodeURIComponent(cursor)}` : ENDPOINT;
}

export async function fetchAllCancellationNotices(
  startCursor: string | null = null,
): Promise<FetchAllCancellationNoticesResult> {
  let cursor: string | null = startCursor;
  let scope: string | null = null;
  const notices: PlatformCancellationNotice[] = [];
  const seenCursors = new Set<string>();

  for (let page = 0; page < MAX_PAGES; page += 1) {
    const requestCursor = cursor;
    let result;
    try {
      result = await posApiGet<RawCancellationsResponse>(buildEndpoint(requestCursor));
    } catch {
      // Transport failure: retry this exact page next time, not from scratch.
      return { ok: false, scope, notices, incomplete: true, resumeCursor: requestCursor };
    }

    if (!result.success || !result.data || result.data.success !== true) {
      const invalidCursor = result.status === 400 || result.data?.error === 'invalid_cursor'
        || /^invalid_cursor(?:$|\s|\()/.test(result.error ?? '');
      return { ok: false, scope, notices, incomplete: true, resumeCursor: invalidCursor ? null : requestCursor };
    }

    const body = result.data;
    if (typeof body.scope !== 'string' || !Array.isArray(body.notices)) {
      return { ok: false, scope, notices, incomplete: true, resumeCursor: requestCursor };
    }

    if (scope === null) {
      scope = body.scope;
    } else if (scope !== body.scope) {
      // Scope shifted mid-scan (identity/ownership changed underneath us).
      // Every notice collected so far in this call was read under the OLD
      // scope and must never be attached to the new one — discard all of
      // it. The caller starts a clean scan under the new scope next time
      // (resumeCursor null), it does not resume a stale cursor sequence.
      return { ok: false, scope: body.scope, notices: [], incomplete: true, resumeCursor: null };
    }

    // A malformed notice fails the whole page rather than being silently
    // filtered out — a page that partially fails validation is not trusted
    // to be a complete, accurate read of what the server holds.
    const pageNotices: PlatformCancellationNotice[] = [];
    for (const raw of body.notices) {
      if (!isValidPlatformCancellationNotice(raw)) {
        return { ok: false, scope, notices, incomplete: true, resumeCursor: requestCursor };
      }
      pageNotices.push(raw);
    }
    notices.push(...pageNotices);

    const nextCursor = body.next_cursor;
    if (nextCursor === null) {
      return { ok: true, scope, notices, incomplete: false, resumeCursor: null };
    }
    // A missing/undefined `next_cursor` is malformed — only an explicit
    // `null` means "end of pagination".
    if (
      typeof nextCursor === 'undefined' ||
      typeof nextCursor !== 'string' ||
      nextCursor === requestCursor ||
      seenCursors.has(nextCursor)
    ) {
      return { ok: false, scope, notices, incomplete: true, resumeCursor: requestCursor };
    }
    seenCursors.add(nextCursor);
    cursor = nextCursor;
  }

  // Page cap reached while every page so far was healthy: not an error.
  // `cursor` already advanced past everything fetched in this call, so the
  // caller resumes the scan from there instead of restarting at page 1.
  return { ok: true, scope, notices, incomplete: true, resumeCursor: cursor };
}
