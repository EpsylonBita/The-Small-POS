import React, { CSSProperties } from 'react'
import benchUrl from '../../assets/empty-orders-bench.png'

/**
 * The empty order list (founder 01/11/2026): a skeleton waiting on a bench, the founder-supplied drawing with its
 * white taken out in PhotoCraft (assets/empty-orders-bench.png, transparent). Painted with currentColor through the
 * picture's alpha, so it takes the kit's muted ink in both themes. Decorative: the words beside it say what it means.
 */
export const EmptyOrdersBench: React.FC<{ className?: string }> = ({ className }) => {
  const style: CSSProperties = {
    display: 'inline-block',
    aspectRatio: '480 / 460',
    backgroundColor: 'currentColor',
    WebkitMaskImage: `url(${benchUrl})`,
    maskImage: `url(${benchUrl})`,
    WebkitMaskRepeat: 'no-repeat',
    maskRepeat: 'no-repeat',
    WebkitMaskPosition: 'center',
    maskPosition: 'center',
    WebkitMaskSize: 'contain',
    maskSize: 'contain',
  }
  return <span aria-hidden="true" data-empty-orders-bench className={className} style={style} />
}

export default EmptyOrdersBench
