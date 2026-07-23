import React from 'react';
import { Building2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';

interface FloorPresetPickerProps {
  value: string;
  onChange: (value: string) => void;
  label: string;
  placeholder: string;
  inputClassName: string;
  onKeyPress?: React.KeyboardEventHandler<HTMLInputElement>;
  maxLength?: number;
  required?: boolean;
}

const NUMERIC_FLOORS = ['1', '2', '3', '4', '5', '6'];

export const FloorPresetPicker: React.FC<FloorPresetPickerProps> = ({
  value,
  onChange,
  label,
  placeholder,
  inputClassName,
  onKeyPress,
  maxLength = 100,
  required = false,
}) => {
  const { t } = useTranslation();
  const presets = [
    {
      value: t('common.floorPresets.basementValue', 'Basement'),
      label: t('common.floorPresets.basement', 'Basement'),
      wide: true,
    },
    {
      value: t('common.floorPresets.groundValue', 'Ground'),
      label: t('common.floorPresets.ground', 'Ground'),
      wide: true,
    },
    ...NUMERIC_FLOORS.map(floor => ({ value: floor, label: floor, wide: false })),
  ];

  return (
    <div>
      <label className="mb-2 block text-sm font-medium liquid-glass-modal-text">
        {label}
      </label>
      <div className="relative">
        <Building2 className="absolute left-3 top-1/2 h-5 w-5 -translate-y-1/2 text-gray-500 dark:text-gray-400" />
        <input
          type="text"
          value={value}
          onChange={event => onChange(event.target.value)}
          onKeyPress={onKeyPress}
          placeholder={placeholder}
          maxLength={maxLength}
          required={required}
          aria-required={required}
          className={`${inputClassName} pl-10 pr-4`}
        />
      </div>
      <div
        className="mt-2 grid grid-cols-4 gap-2"
        role="group"
        aria-label={t('common.floorPresets.quickPick', 'Quick floor selection')}
      >
        {presets.map(preset => {
          const isSelected = value.trim().toLocaleLowerCase() === preset.value.toLocaleLowerCase();
          return (
            <button
              key={preset.value}
              type="button"
              onClick={() => onChange(preset.value)}
              aria-pressed={isSelected}
              className={`min-h-9 rounded-xl border px-2 py-1.5 text-xs font-semibold transition-colors active:scale-[0.98] ${preset.wide ? 'col-span-2' : ''} ${
                isSelected
                  ? 'border-blue-400/60 bg-blue-500/20 text-blue-100'
                  : 'border-white/10 bg-white/5 liquid-glass-modal-text hover:bg-white/10'
              }`}
            >
              {preset.label}
            </button>
          );
        })}
      </div>
      <p className="mt-2 text-xs liquid-glass-modal-text-muted">
        {t('common.floorPresets.manualHint', 'Pick a common floor or enter any value above.')}
      </p>
    </div>
  );
};
