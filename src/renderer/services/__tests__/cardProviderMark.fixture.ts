import { applyCardProviderSnapshot } from '../cardProviderMark';
import { getCachedTerminalCredentials } from '../terminal-credentials';

/** Connected-store fixtures keep the real synchronous mark and scope comparison. */
export function seedCardProviderMark(): void {
  const scope = getCachedTerminalCredentials();
  const { organizationId, branchId, terminalId } = scope;
  if (!organizationId?.trim() || !branchId?.trim() || !terminalId?.trim()) {
    throw new Error('Seed the terminal identity before seeding a connected provider');
  }
  applyCardProviderSnapshot({ success: true, cardTerminal: { admitted: true, fetchedAt: '2026-11-06T09:00:00.000Z',
    organizationId, branchId, terminalId } });
}
