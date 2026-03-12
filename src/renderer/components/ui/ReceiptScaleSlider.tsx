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
}) => {
  const pct = ((value - min) / (max - min)) * 100;
  const isDefault = Math.abs(value - defaultValue) < step * 0.5;

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      onChange(parseFloat(e.target.value));
    },
    [onChange],
  );

  const handleReset = useCallback(() => {
    onChange(defaultValue);
  }, [onChange, defaultValue]);

  return (
    <div className="space-y-1.5">
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
              className="text-[10px] text-blue-400 hover:text-blue-300 transition-colors"
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
        className="receipt-scale-slider w-full"
        style={{
          background: `linear-gradient(to right, rgb(59 130 246 / 0.7) 0%, rgb(59 130 246 / 0.7) ${pct}%, rgb(255 255 255 / 0.08) ${pct}%, rgb(255 255 255 / 0.08) 100%)`,
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
