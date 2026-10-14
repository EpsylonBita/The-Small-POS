import React from 'react';
import { centsEntryDisplay, nextCentsEntry, pastedCentsEntry } from '../../utils/moneyInput';

type NativeInputProps = Omit<
  React.InputHTMLAttributes<HTMLInputElement>,
  'type' | 'inputMode' | 'value' | 'defaultValue' | 'onChange' | 'min' | 'max' | 'step'
>;

export interface CentsMoneyInputProps extends NativeInputProps {
  /**
   * Stored value: a plain decimal string ("1000.00", "" when nothing is
   * entered) or an amount. Legacy comma text ("12,50") is read as well.
   */
  value: string | number | null | undefined;
  /**
   * Receives the plain decimal string to store ("1000.00", or "" when the
   * field was cleared) and the amount (1000, or 0 when cleared).
   */
  onValueChange: (value: string, amount: number) => void;
}

/**
 * Money field with digit entry in cents: typing 3350 shows 33,50 and typing
 * 100000 shows 1.000,00. Plain text input (no native steppers); the whole
 * value is selected on focus so the next digits replace it.
 */
export const CentsMoneyInput = React.forwardRef<HTMLInputElement, CentsMoneyInputProps>(
  ({ value, onValueChange, onFocus, onPaste, autoComplete = 'off', ...props }, ref) => {
    const shown = centsEntryDisplay(value);
    return (
      <input
        ref={ref}
        {...props}
        type="text"
        inputMode="numeric"
        autoComplete={autoComplete}
        value={shown}
        onFocus={(event) => {
          event.currentTarget.select();
          onFocus?.(event);
        }}
        onPaste={(event) => {
          onPaste?.(event);
          if (event.defaultPrevented) return;
          // A pasted amount is a decimal ("12.5" is 12,50), not typed cents.
          // The pasted value replaces the field; text that is not an amount
          // is refused and the field keeps what it showed.
          event.preventDefault();
          const next = pastedCentsEntry(event.clipboardData.getData('text'));
          if (next) onValueChange(next.value, next.amount);
        }}
        onChange={(event) => {
          const inputType = (event.nativeEvent as InputEvent).inputType;
          const deleting = typeof inputType === 'string' && inputType.startsWith('delete');
          const next = nextCentsEntry(event.currentTarget.value, deleting);
          if (next) onValueChange(next.value, next.amount);
        }}
      />
    );
  },
);

CentsMoneyInput.displayName = 'CentsMoneyInput';
