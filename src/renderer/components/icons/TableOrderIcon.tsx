import React, { CSSProperties } from 'react'
import tableIconUrl from '../../assets/table-order-icon.png'

interface TableOrderIconProps {
  className?: string
  /**
   * Accepted for API compatibility with the previous inline-SVG icon and the existing
   * OrderDashboard/OrderFlow call sites. Ignored: this icon renders a bitmap mask.
   */
  strokeWidth?: number
  /**
 * Optional optical-size tuning. The supplied PNG has a wide transparent canvas,
 * so this scales the rendered mask after layout instead of clipping the artwork.
   */
  opticalScale?: number
}

/**
 * Table / dine-in mark from the founder-supplied transparent PNG.
 * It is painted with currentColor through an alpha mask, so the same artwork can be
 * white in chooser cards and inherit row/table colors in compact contexts.
 */
export const TableOrderIcon: React.FC<TableOrderIconProps> = ({
  className,
  opticalScale = 1.62,
}) => {
  const scale = Math.max(1, Math.min(opticalScale, 1.65))
  const style: CSSProperties & Record<string, string> = {
    display: 'inline-block',
    lineHeight: '0',
    overflow: 'visible',
    backgroundColor: 'currentColor',
    WebkitMaskImage: `url(${tableIconUrl})`,
    maskImage: `url(${tableIconUrl})`,
    WebkitMaskMode: 'alpha',
    maskMode: 'alpha',
    WebkitMaskRepeat: 'no-repeat',
    maskRepeat: 'no-repeat',
    WebkitMaskPosition: 'center',
    maskPosition: 'center',
    WebkitMaskSize: '100%',
    maskSize: '100%',
    transform: `scale(${scale})`,
    transformOrigin: 'center',
  }

  return <span className={className} style={style} aria-hidden="true" />
}

export default TableOrderIcon
