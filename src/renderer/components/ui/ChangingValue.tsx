import React from 'react';

interface ChangingValueProps {
  /** The text shown, e.g. a formatted total. A new value replays the fade-in. */
  value: string | number;
  className?: string;
}

/**
 * A total or count that cross-fades when it changes (UI audit wave 5). CSS only:
 * the span is keyed by its value, so React mounts a fresh one and `.pos-value`
 * plays once; nothing waits for it, and "reduce motion" switches it off.
 */
export function ChangingValue({ value, className }: ChangingValueProps) {
  return (
    <span key={String(value)} className={className ? `pos-value ${className}` : 'pos-value'}>
      {value}
    </span>
  );
}

export default ChangingValue;
