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
        <label className="text-xs font-medium text-white/80">{label}</label>
        <div className="flex items-center gap-2">
          <span className="text-xs font-mono text-white/90 bg-white/5 px-1.5 py-0.5 rounded border border-white/10">
            {formatValue(value)}
          </span>
          {!isDefault && (
            <button
              type="button"
              onClick={handleReset}
              disabled={disabled}
              className="min-h-7 rounded-2xl px-1.5 text-[10px] font-semibold text-amber-300 transition-transform active:scale-95 active:bg-amber-400/10 disabled:text-white/25 disabled:active:scale-100"
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
          background: `linear-gradient(to right, rgb(245 158 11 / 0.78) 0%, rgb(245 158 11 / 0.78) ${pct}%, rgb(255 255 255 / 0.08) ${pct}%, rgb(255 255 255 / 0.08) 100%)`,
        }}
      />
      <div className="flex justify-between text-[9px] text-white/40 px-0.5">
        <span>{formatValue(min)}</span>
        <span>{formatValue(defaultValue)}</span>
        <span>{formatValue(max)}</span>
      </div>
      {hint && <p className="text-[10px] text-white/40 mt-0.5">{hint}</p>}
    </div>
  );
};

export default ReceiptScaleSlider;
