import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import { boxOrderStatusMutationAllowed, isBoxOrder } from '../box-order-decision';
import { isPlatformDriverCashAutoEnabled } from '../../../utils/orderCancelGuard';
import { ACCEPTED_PLATFORM_ORDER_STATUSES, platformCancellationFailureMessageKey } from '../../../../../../shared/platforms/order-cancellation';
import { EXTERNAL_DELIVERY_PLATFORMS } from '../../../../../../shared/platforms/order-platforms';

describe('platform cancellation mutation guard', () => {
  for (const plugin of EXTERNAL_DELIVERY_PLATFORMS) {
    it.each(ACCEPTED_PLATFORM_ORDER_STATUSES)(`${plugin}: store may cancel at %s, platform courier may not`, status => {
      for (const delivery_provider of ['vendor_delivery', 'platform_delivery']) {
        expect(boxOrderStatusMutationAllowed({ plugin, status, ghost_metadata: { food_delivery: { delivery_provider } } }, 'cancelled'))
          .toBe(delivery_provider === 'vendor_delivery');
      }
      expect(boxOrderStatusMutationAllowed({ plugin, status }, 'cancelled')).toBe(false);
    });
  }
  it('keeps pending rejection and other order sources unchanged', () => {
    for (const plugin of ['efood', 'wolt', 'pos', 'kiosk', 'web', 'booking']) {
      expect(boxOrderStatusMutationAllowed({ plugin, status: 'pending' }, 'cancelled')).toBe(true);
    }
    expect(platformCancellationFailureMessageKey({ code: 'PLATFORM_COURIER_CANCELLATION_ONLY' })).toBe('platformCancellation.platformOnly');
  });

  it.each([
    ['off', '{"platform_driver_cash_auto":false}'],
    ['missing', undefined],
    ['unreadable', '{'],
  ])('blocks the entire dashboard selection before preflight when the switch is %s', async (_case, features) => {
    // Execute the dashboard handler with its normal platform check and stub the
    // native and UI boundaries so the test can detect any partial cancellation.
    const source = readFileSync(resolve(__dirname, '..', '..', 'OrderDashboard.tsx'), 'utf8');
    const start = source.indexOf('const beginOrderCancellation =');
    const end = source.indexOf('const handleOutstandingCancelOrder =', start);
    const { outputText } = ts.transpileModule(source.slice(start, end), {
      compilerOptions: { target: ts.ScriptTarget.ES2022 },
    });
    const findCancelRefusals = vi.fn();
    const setShowCancelModal = vi.fn();
    const toast = { error: vi.fn() };
    const bindings = {
      orders: [
        { id: 'local', status: 'ready' },
        { id: 'courier', status: 'delivered', ghost_metadata: {
          food_delivery: JSON.stringify({ platform: 'efood', delivery_provider: 'platform_delivery' }),
        } },
      ],
      pendingExternalOrders: [],
      terminalSettingsError: null,
      getSetting: vi.fn(() => features),
      isPlatformDriverCashAutoEnabled, boxOrderStatusMutationAllowed, isBoxOrder,
      t: (key: string) => key,
      toast, findCancelRefusals, setShowCancelModal,
    };
    const beginOrderCancellation = new Function(
      ...Object.keys(bindings), outputText + '\nreturn beginOrderCancellation;',
    )(...Object.values(bindings));
    expect(await beginOrderCancellation(['local', 'courier'])).toBe(true);
    expect(bindings.getSetting).toHaveBeenCalledWith('terminal', 'enabled_features');
    expect(toast.error).toHaveBeenCalledExactlyOnceWith('platformCancellation.platformOnly');
    expect(findCancelRefusals).not.toHaveBeenCalled();
    expect(setShowCancelModal).not.toHaveBeenCalled();
  });
});
