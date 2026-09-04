import {
  isViewAccessDenied,
  type ViewAccessModuleLike,
} from '../../utils/module-view-access'

export type RepairIntent = 'new_repair' | 'quick_service'

export interface PostLoginNavigationIntent {
  view: string
  repairIntent?: RepairIntent
}

type IntentStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

interface StoredPostLoginNavigationIntent extends PostLoginNavigationIntent {
  createdAt: number
}

export const PENDING_POST_LOGIN_INTENT_KEY = 'PendingPostLoginIntent'
export const PENDING_POST_LOGIN_INTENT_TTL_MS = 5 * 60 * 1_000

function isRepairIntent(value: unknown): value is RepairIntent {
  return value === 'new_repair' || value === 'quick_service'
}

export function savePendingPostLoginIntent(
  storage: IntentStorage,
  intent: PostLoginNavigationIntent,
  now = Date.now(),
): void {
  const view = intent.view.trim()
  if (!view) return

  const stored: StoredPostLoginNavigationIntent = {
    view,
    createdAt: now,
    ...(view === 'repairs' && isRepairIntent(intent.repairIntent)
      ? { repairIntent: intent.repairIntent }
      : {}),
  }
  storage.setItem(PENDING_POST_LOGIN_INTENT_KEY, JSON.stringify(stored))
}

export function consumePendingPostLoginIntent(
  storage: IntentStorage,
  now = Date.now(),
): PostLoginNavigationIntent | null {
  const raw = storage.getItem(PENDING_POST_LOGIN_INTENT_KEY)
  if (!raw) return null

  storage.removeItem(PENDING_POST_LOGIN_INTENT_KEY)

  try {
    const parsed = JSON.parse(raw) as Partial<StoredPostLoginNavigationIntent>
    const view = typeof parsed.view === 'string' ? parsed.view.trim() : ''
    const createdAt = typeof parsed.createdAt === 'number' ? parsed.createdAt : Number.NaN
    const age = now - createdAt
    if (!view || !Number.isFinite(createdAt) || age < 0 || age > PENDING_POST_LOGIN_INTENT_TTL_MS) {
      return null
    }

    return {
      view,
      ...(view === 'repairs' && isRepairIntent(parsed.repairIntent)
        ? { repairIntent: parsed.repairIntent }
        : {}),
    }
  } catch {
    return null
  }
}

export function consumeAuthorizedPendingPostLoginIntent(
  storage: IntentStorage,
  enabledModules: ViewAccessModuleLike[],
  now = Date.now(),
): PostLoginNavigationIntent | null {
  const intent = consumePendingPostLoginIntent(storage, now)
  if (!intent || isViewAccessDenied(enabledModules, intent.view)) return null
  return intent
}
