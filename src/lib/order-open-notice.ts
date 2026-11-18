export const ORDER_HAS_OPEN_NOTICE = 'ORDER_HAS_OPEN_NOTICE';
export const ORDER_NOTICE_CHECK_UNAVAILABLE = 'ORDER_NOTICE_CHECK_UNAVAILABLE';
export type OrderNoticeRefusalCode = typeof ORDER_HAS_OPEN_NOTICE | typeof ORDER_NOTICE_CHECK_UNAVAILABLE;

/** Preserve the native refusal through IPC wrappers; never retry it over HTTP. */
export function isOrderOpenNoticeRefusal(value: unknown): boolean {
  return orderNoticeRefusalCode(value) !== undefined;
}

export function orderNoticeRefusalCode(value: unknown, seen = new Set<unknown>()): OrderNoticeRefusalCode | undefined {
  if (typeof value === 'string') return value.includes(ORDER_NOTICE_CHECK_UNAVAILABLE)
    ? ORDER_NOTICE_CHECK_UNAVAILABLE : value.includes(ORDER_HAS_OPEN_NOTICE) ? ORDER_HAS_OPEN_NOTICE : undefined;
  if (!value || typeof value !== 'object' || seen.has(value)) return undefined;
  seen.add(value);
  const error = value as Record<string, unknown>;
  for (const key of ['code', 'errorCode', 'completionRefusal', 'message', 'error', 'details', 'cause', 'data']) {
    const code = orderNoticeRefusalCode(error[key], seen);
    if (code) return code;
  }
  return undefined;
}
