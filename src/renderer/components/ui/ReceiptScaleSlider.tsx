import React, { useCallback } from 'react';

interface ReceiptScaleSliderProps {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  defaultValue: number;
  formatValue?: (v: number) => string;
  onChange: (value: number) => void;
  hint?: string;
  resetLabel?: string;
  disabled?: boolean;
}

const defaultFormat = (v: number) => `${v.toFixed(2)}x`;

export const ReceiptScaleSlider: React.FC<ReceiptScaleSliderProps> = ({
  label,
  value,
  min,
  max,
  step,
  defaultValue,
  formatValue = defaultFormat,
  onChange,
  hint,
  resetLabel = 'Reset',
  disabled = false,
}) => {
  const pct = ((value - min) / (max - min)) * 100;
  const isDefault = Math.abs(value - defaultValue) < step * 0.5;

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      if (disabled) return;
      onChange(parseFloat(e.target.value));
    },
    [disabled, onChange],
  );

  const handleReset = useCallback(() => {
    if (disabled) return;
    onChange(defaultValue);
  }, [defaultValue, disabled, onChange]);

  return (
    <div className={`space-y-1.5 ${disabled ? 'opacity-60' : ''}`}>
      <div className="flex items-center justify-between">
        <label className="text-xs font-medium liquid-glass-modal-text">{label}</label>
        <div className="flex items-center gap-2">
          <span className="text-xs font-mono tabular-nums liquid-glass-modal-text bg-slate-100 px-1.5 py-0.5 rounded-sm border liquid-glass-modal-border">
            {formatValue(value)}
          </span>
          {!isDefault && (
            <button
              type="button"
              onClick={handleReset}
              disabled={disabled}
              className="pos-solid-btn pos-solid-btn--sm"
            >
              {resetLabel}
            </button>
          )}
        </div>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={handleChange}
        disabled={disabled}
        className="receipt-scale-slider w-full disabled:cursor-not-allowed"
        style={{
          background: `linear-gradient(to right, rgb(245 158 11 / 0.78) 0%, rgb(245 158 11 / 0.78) ${pct}%, rgb(100 116 139 / 0.28) ${pct}%, rgb(100 116 139 / 0.28) 100%)`,
        }}
      />
      <div className="flex justify-between text-[11px] tabular-nums liquid-glass-modal-text-muted px-0.5">
        <span>{formatValue(min)}</span>
        <span>{formatValue(defaultValue)}</span>
        <span>{formatValue(max)}</span>
      </div>
      {hint && <p className="text-xs liquid-glass-modal-text-muted mt-0.5">{hint}</p>}
    </div>
  );
};

export default ReceiptScaleSlider;
