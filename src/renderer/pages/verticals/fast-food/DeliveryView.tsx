import React, { memo } from 'react';
import DeliveryPage from '../../DeliveryPage';

/**
 * DeliveryView - Delivery order management for POS
 *
 * Full-featured delivery management with:
 * - Active deliveries list
 * - Driver assignment
 * - Status tracking (pending → assigned → picked_up → in_transit → delivered)
 * - Real-time updates
 *
 * @since 2.3.0
 */
export const DeliveryView: React.FC = memo(() => {
  return <DeliveryPage />;
});

DeliveryView.displayName = 'DeliveryView';

export default DeliveryView;
