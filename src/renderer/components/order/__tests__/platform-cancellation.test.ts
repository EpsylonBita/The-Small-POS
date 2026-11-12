import { describe, expect, it } from 'vitest';
import { boxOrderStatusMutationAllowed } from '../box-order-decision';
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
});
