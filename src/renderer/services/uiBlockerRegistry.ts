import { emitCompatEvent } from '../../lib'

export interface UiBlockerSnapshot {
  id: string
  label: string
  source: string
  activeSince: string
  updatedAt: string
  metadata?: Record<string, unknown>
}

interface UiBlockerRegistration {
  id: string
  label: string
  source: string
  metadata?: Record<string, unknown>
}

const UI_BLOCKERS_CHANGED_EVENT = 'ui:blockers-changed'
const activeUiBlockers = new Map<string, UiBlockerSnapshot>()

function emitUiBlockersChanged() {
  emitCompatEvent(UI_BLOCKERS_CHANGED_EVENT, getActiveUiBlockers())
}

export function registerUiBlocker({
  id,
  label,
  source,
  metadata,
}: UiBlockerRegistration): void {
  const now = new Date().toISOString()
  const previous = activeUiBlockers.get(id)

  activeUiBlockers.set(id, {
    id,
    label,
    source,
    metadata,
    activeSince: previous?.activeSince ?? now,
    updatedAt: now,
  })

  emitUiBlockersChanged()
}

export function unregisterUiBlocker(id: string): void {
  if (!activeUiBlockers.delete(id)) {
    return
  }

  emitUiBlockersChanged()
}

export function getActiveUiBlockers(): UiBlockerSnapshot[] {
  return Array.from(activeUiBlockers.values()).sort((left, right) =>
    left.id.localeCompare(right.id),
  )
}

export function getUiBlockersChangedEventName(): string {
  return UI_BLOCKERS_CHANGED_EVENT
}
