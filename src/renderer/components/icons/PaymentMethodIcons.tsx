import React from 'react';

interface PaymentGlyphProps {
  className?: string;
  style?: React.CSSProperties;
  'aria-hidden'?: boolean | 'true' | 'false';
}

// Founder 31/10 («βάλε καλύτερα αυτά: το πρώτο για μετρητά και το δεύτερο για κάρτα», his references).
// Drawn in currentColor; the shapes in front hide the lines behind them through masks, so the glyphs sit on any
// surface, glass included. The same outlines live in POSSystemMobile's PaymentMethodIcons.

/** Cash: a hand holding two notes -- the cuff, the palm and four fingers round the front note. */
const CASH_FRONT_NOTE = 'M31.8 4.3 H56.6 A2 2 0 0 1 58.6 6.3 V55.5 A2 2 0 0 1 56.6 57.5 H31.8 A2 2 0 0 1 29.8 55.5 V6.3 A2 2 0 0 1 31.8 4.3 Z';
const CASH_HAND = 'M19.6 37.6 C24.5 34.6 29.6 32 34.2 32.4 C37.4 32.7 39.2 34.8 39.8 37.2 H50.6 A2.1 2.1 0 0 1 50.6 41.4 A2.1 2.1 0 0 1 50.6 45.6 A2.1 2.1 0 0 1 50.6 49.8 A2.1 2.1 0 0 1 50.6 54 H41.2 C39.4 54 38.4 56.2 35.6 56.2 H19.6 Z';
const CASH_CUFF = 'M7.2 34.6 H17.6 A2.6 2.6 0 0 1 20.2 37.2 V55.4 A2.6 2.6 0 0 1 17.6 58 H7.2 A2.6 2.6 0 0 1 4.6 55.4 V37.2 A2.6 2.6 0 0 1 7.2 34.6 Z';

/**
 * Each part hides what lies behind it through a mask, not a painted fill (founder 01/11: on a glass card the
 * white fill showed as boxes inside the icon), so the glyph is transparent on any surface.
 *
 * The till's one cash icon (founder 01/11/2026: «αλλαξε το εικονιδιο των μετρητων ... σε ολη την εφαρμογη»): it
 * replaces the banknote everywhere, in its colour (currentColor) and size (className).
 */
/**
 * The cash glyph's line weight in screen pixels at every size (founder 01/11/2026: it replaced the banknote down to
 * 14 px). The 44 px payment card drew 2.6 of 64 units, about 1.8 px; small icons scaled that down to a smudge, so the
 * strokes keep this weight instead (vector-effect: non-scaling-stroke). Android draws the same weight from its size.
 */
const CASH_LINE_PX = 1.75;
const CASH_DOT_PX = 2.3;

export const CashHandIcon: React.FC<PaymentGlyphProps> = ({ className, style }) => {
  const id = React.useId().replace(/[^A-Za-z0-9_-]/g, '');
  const mask = (name: string, cutouts: string[]) => (
    <mask id={`${id}-${name}`} maskUnits="userSpaceOnUse" x="0" y="0" width="64" height="62">
      <rect width="64" height="62" fill="#fff" />
      {cutouts.map((d) => <path key={d} d={d} fill="#000" stroke="none" />)}
    </mask>
  );
  return (
    <svg viewBox="0 0 64 62" fill="none" stroke="currentColor" strokeWidth={CASH_LINE_PX} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className={className} style={style} data-cash-icon="hand">
      <defs>
        {mask('back', [CASH_FRONT_NOTE, CASH_HAND, CASH_CUFF])}
        {mask('front', [CASH_HAND, CASH_CUFF])}
        {mask('hand', [CASH_CUFF])}
      </defs>
      <g mask={`url(#${id}-back)`}>
        <path vectorEffect="non-scaling-stroke" d="M17.5 13.6 L36.8 5.8 L51.8 42 L32.4 49.8 Z" />
        <path vectorEffect="non-scaling-stroke" d="M21.4 16.6 L27.6 31.6" />
      </g>
      <g mask={`url(#${id}-front)`}>
        <path vectorEffect="non-scaling-stroke" d="M29.8 22 V6.3 A2 2 0 0 1 31.8 4.3 H56.6 A2 2 0 0 1 58.6 6.3 V21.5 M58.6 27.5 V55.5 A2 2 0 0 1 56.6 57.5 H51" />
        <path vectorEffect="non-scaling-stroke" d="M58.6 24.5 V24.51" strokeWidth={CASH_DOT_PX} />
        <path vectorEffect="non-scaling-stroke" d="M34.2 21 V13 Q37.2 13 37.2 9.4 H50.8 Q50.8 13 53.8 13 V43" />
        <circle vectorEffect="non-scaling-stroke" cx="44" cy="31" r="5.4" />
      </g>
      <path vectorEffect="non-scaling-stroke" d={CASH_HAND} mask={`url(#${id}-hand)`} />
      <path vectorEffect="non-scaling-stroke" d="M41.4 41.4 H50.6 M41.4 45.6 H50.6 M41.4 49.8 H50.6" />
      <path vectorEffect="non-scaling-stroke" d={CASH_CUFF} />
      <path vectorEffect="non-scaling-stroke" d="M12.4 40.2 V46.6" />
      <path vectorEffect="non-scaling-stroke" d="M12.4 51.6 V51.61" strokeWidth={CASH_DOT_PX} />
    </svg>
  );
};

/** Card: two contactless cards, the back one tilted up to the right; chip, waves and number lines. */
const CARD_FRONT = 'M10.1 17.9 H52.9 A3.8 3.8 0 0 1 56.7 21.7 V45.6 A3.8 3.8 0 0 1 52.9 49.4 H10.1 A3.8 3.8 0 0 1 6.3 45.6 V21.7 A3.8 3.8 0 0 1 10.1 17.9 Z';

/** The front card hides the back one through a mask (founder 01/11: glass payment cards), as the cash glyph does. */
export const CardsIcon: React.FC<PaymentGlyphProps> = ({ className }) => {
  const id = React.useId().replace(/[^A-Za-z0-9_-]/g, '');
  return (
  <svg viewBox="0 0 64 54" fill="none" stroke="currentColor" strokeWidth={2.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className={className}>
    <defs>
      <mask id={`${id}-back`} maskUnits="userSpaceOnUse" x="0" y="0" width="64" height="54">
        <rect width="64" height="54" fill="#fff" />
        <path d={CARD_FRONT} fill="#000" stroke="none" />
      </mask>
    </defs>
    <rect x="10" y="12.2" width="50.4" height="31.5" rx="3.8" transform="rotate(-9 35.2 28)" mask={`url(#${id}-back)`} />
    <path d={CARD_FRONT} />
    <path d="M15.6 25.6 H20.4 A2 2 0 0 1 22.4 27.6 V32.2 A2 2 0 0 1 20.4 34.2 H15.6 A2 2 0 0 1 13.6 32.2 V27.6 A2 2 0 0 1 15.6 25.6 Z" />
    <path d="M16.6 29.9 H19.4" />
    <path d="M40.6 27.8 V29.4 M43.2 25.8 A3.4 3.4 0 0 1 43.2 31.4 M46.2 23.8 A6 6 0 0 1 46.2 33.4" />
    <path d="M10.6 38.4 H14.6 M19 38.4 H24 M28.4 38.4 H33.4 M37.8 38.4 H42.8 M47.2 38.4 H51.6" />
    <path d="M10.6 42.8 H25" />
  </svg>
  );
};

/**
 * Split: a receipt torn diagonally in two -- the top half in the cash colour, the bottom half (the torn
 * edge) in the card colour (--pay-split-a / --pay-split-b; plain currentColor when the card is disabled).
 */
export const SplitReceiptIcon: React.FC<PaymentGlyphProps> = ({ className }) => (
  <svg viewBox="0 0 58 66" fill="none" strokeWidth={2.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className={className}>
    <g style={{ stroke: 'var(--pay-split-a, currentColor)' }}>
      <path d="M5 45 V9 A4.5 4.5 0 0 1 9.5 4.5 H43 A4.5 4.5 0 0 1 47.5 9 V15.6 L7.6 46.6 Q5 48.2 5 45 Z" />
      <path d="M12.5 19.5 H31.3 M12.5 30 H18.8" />
    </g>
    <g style={{ stroke: 'var(--pay-split-b, currentColor)' }}>
      <path d="M10 52 L50.4 20.6 A1.6 1.6 0 0 1 52.6 21.9 V57.5 L47.35 61 L42.1 57.5 L36.85 61 L31.6 57.5 L26.35 61 L21.1 57.5 L15.85 61 L10.6 57.5 Z" />
      <path d="M43 35 V35.01" strokeWidth={3.2} />
      <path d="M31.3 44.3 H43" />
    </g>
  </svg>
);
