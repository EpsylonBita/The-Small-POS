import React from 'react';
import { ShoppingBag } from 'lucide-react';

interface PickupOrderIconProps {
  className?: string;
  size?: number;
  color?: string;
  strokeWidth?: number;
}

/**
 * Pickup / takeaway order glyph: the user-approved plain lucide ShoppingBag used by
 * the order-type chooser (forms/OrderTypeSelector + OrderDashboard / OrderFlow).
 * Shared so the compact order-row icon and every chooser render the identical bag
 * glyph instead of independent call sites that could drift. `strokeWidth` defaults
 * to 2 (lucide's normal weight) to match the chooser - not thin.
 */
export const PickupOrderIcon: React.FC<PickupOrderIconProps> = ({
  className,
  size,
  color,
  strokeWidth = 2,
}) => (
  <ShoppingBag className={className} size={size} color={color} strokeWidth={strokeWidth} />
);

export default PickupOrderIcon;
