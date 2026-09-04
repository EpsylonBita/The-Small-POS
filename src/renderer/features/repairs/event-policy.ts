const REFRESHABLE_MUTATION_REASONS = new Set([
  'offline_command_queued',
  'authoritative_command',
  'attachment_queued',
  'conflict_resolved',
])

/** Prevents native read-through cache events from recursively triggering reads. */
export function shouldRefetchForRepairCacheReason(reason: string): boolean {
  return REFRESHABLE_MUTATION_REASONS.has(reason)
}
