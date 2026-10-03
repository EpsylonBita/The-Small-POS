import { getBridge } from '../../lib';
import { externalDisplayChoices, isExternalDisplayFree, liveExternalPresentation } from './ExternalDisplayOwnership';
import { currentTwintScope } from './TwintManualQrService';

export interface CustomerTwintQr { qrImageData: string; amount: number; currency: 'CHF' }
type Snapshot = Record<string, unknown> | null;
let base: Snapshot = null;
let lease: { token: string; scope: string; qr: CustomerTwintQr } | null = null;
let queue = Promise.resolve();
function publish(): Promise<void> {
  const current = lease && lease.scope === currentTwintScope() ? lease : null;
  if (lease && !current) lease = null;
  const snapshot = current ? { ...(base || { displayOrders: [], isLoading: false, isDark: false, locale: 'en' }), twintQr: current.qr } : base;
  queue = queue.catch(() => {}).then(() => getBridge().invoke('customer-display-publish', snapshot)).then(() => {});
  return queue;
}
/** Regular public order refreshes retain an active payment overlay. */
export function publishCustomerDisplaySnapshot(snapshot: Snapshot): Promise<void> {
  base = snapshot;
  return publish();
}
export async function acquireCustomerTwintQr(scope: string, qr: CustomerTwintQr, externalEnabled: boolean) {
  const token = crypto.randomUUID();
  lease = { token, scope, qr };
  const release = () => {
    if (lease?.token !== token) return;
    lease = null;
    void publish().catch(() => {});
  };
  try {
    await publish();
    if (!externalEnabled || currentTwintScope() !== scope || lease?.token !== token) return { token, external: false, release };
    const capabilities = await getBridge().externalDisplay.getCapabilities();
    if (currentTwintScope() !== scope || lease?.token !== token) return { token, external: false, release };
    if (liveExternalPresentation(capabilities, 'customer_display')) return { token, external: true, release };
    const display = externalDisplayChoices(capabilities).find(isExternalDisplayFree);
    if (!display) return { token, external: false, release };
    const result = await getBridge().externalDisplay.open({ contentType: 'customer_display', displayId: display.id });
    if (lease?.token !== token || currentTwintScope() !== scope) {
      if (result.success && result.token) await getBridge().externalDisplay.close({ contentType: 'customer_display', token: result.token });
      return { token, external: false, release };
    }
    return { token, external: result.success === true, release };
  } catch { return { token, external: false, release }; }
}
