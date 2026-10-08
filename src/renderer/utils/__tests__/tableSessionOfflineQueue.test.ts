import { describe, expect, it, vi } from 'vitest';

vi.mock('../../services/SyncQueueBridge', () => ({ getSyncQueueBridge: vi.fn() }));
vi.mock('../../services/terminal-credentials', () => ({ getCachedTerminalCredentials: () => ({}) }));

import { isRetainedTableMutationError, isRetryableTableServiceError } from '../tableSessionOfflineQueue';

describe('native table mutation outcomes', () => {
  it.each([
    'TABLE_MUTATION_BLOCKED: Table action is still syncing',
    'TABLE_MUTATION_BLOCKED: network timeout before retention',
    'TABLE_MUTATION_REFUSED: HTTP 409: network conflict',
    'TABLE_MUTATION_REFUSED: 2 unattempted transfers quarantined after connection refusal',
  ])('does not report an unretained or refused original as queued: %s', message => {
    expect(isRetryableTableServiceError(new Error(message))).toBe(false);
    expect(isRetainedTableMutationError(message)).toBe(false);
  });

  it.each([
    'TABLE_MUTATION_RETAINED: HTTP 500: temporarily unavailable',
    'TABLE_MUTATION_RETAINED: network timeout',
    'TABLE_MUTATION_RETAINED: exact original still processing',
  ])('recognises the retained original independently of its transport failure: %s', message => {
    expect(isRetryableTableServiceError(new Error(message))).toBe(true);
    expect(isRetainedTableMutationError(message)).toBe(true);
  });

  it('keeps legacy read/open retry handling without claiming that an arbitrary mutation was retained', () => {
    expect(isRetryableTableServiceError(new Error('Offline'))).toBe(true);
    expect(isRetainedTableMutationError(new Error('Offline'))).toBe(false);
    expect(isRetryableTableServiceError(new Error('Table action is still syncing'))).toBe(false);
    expect(isRetryableTableServiceError(new Error('HTTP 500: unavailable'))).toBe(false);
    expect(isRetainedTableMutationError(new Error('Server text mentions TABLE_MUTATION_RETAINED but gives no native outcome'))).toBe(false);
  });
});
