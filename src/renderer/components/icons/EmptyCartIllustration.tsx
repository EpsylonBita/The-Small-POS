import React from 'react'

/**
 * The empty cart (founder 01/11/2026: «αλλαξε την εικονα του καροτσιου με μια καλυτερη»): a wire shopping cart on
 * its shadow, a basket waiting to be filled and a «+» calling for the first item. Line art in currentColor, like the
 * empty order list's bench (EmptyOrdersBench), so it takes the kit's muted ink in both themes. The same drawing lives
 * in POSSystemMobile's EmptyCartIllustration. Decorative: the words beside it say what it means.
 */
export const EmptyCartIllustration: React.FC<{ className?: string }> = ({ className }) => (
  <svg
    viewBox="0 0 160 132"
    fill="none"
    stroke="currentColor"
    strokeWidth={3.4}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
    data-empty-cart
    className={className}
  >
    {/* The floor shadow. */}
    <ellipse cx="88" cy="124" rx="56" ry="4.5" fill="currentColor" stroke="none" opacity="0.12" />
    {/* The handle and its grip. */}
    <path d="M8 20 H22" strokeWidth={5.2} />
    <path d="M22 20 L30 24 L40 40" />
    {/* The basket: a soft fill for its depth, the rim, then the wire grid. */}
    <path d="M38 40 H146 L134 90 H54 Z" fill="currentColor" fillOpacity="0.07" />
    <path d="M38 40 H146" strokeWidth={4.2} />
    <path d="M146 40 L134 90 H54 L38 40" />
    <path d="M59.6 40 L70.4 90 M81.2 40 L86.8 90 M102.8 40 L103.2 90 M124.4 40 L118.8 90" opacity="0.55" />
    <path d="M44.4 57 H141.9 M49.9 74 H137.8" opacity="0.55" />
    {/* The chassis and the wheels. */}
    <path d="M54 90 L60 104 H132" />
    <path d="M68 104 V107 M124 104 V107" />
    <circle cx="68" cy="114" r="7.5" />
    <circle cx="124" cy="114" r="7.5" />
    <circle cx="68" cy="114" r="1.6" fill="currentColor" stroke="none" />
    <circle cx="124" cy="114" r="1.6" fill="currentColor" stroke="none" />
    {/* The first item still to come. */}
    <circle cx="112" cy="16" r="11" strokeDasharray="4 5" opacity="0.8" />
    <path d="M112 11 V21 M107 16 H117" strokeWidth={3} />
    <path d="M100 26 Q96 32 93 34" strokeDasharray="1 6" opacity="0.6" />
  </svg>
)

export default EmptyCartIllustration
