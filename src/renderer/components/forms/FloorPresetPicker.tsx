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
        {label.replace(' *', '')}
        {required && <span className="text-red-500"> *</span>}
      </label>
      <div className="relative">
        <Building2 className="liquid-glass-modal-field-icon absolute left-3 top-1/2 h-5 w-5 -translate-y-1/2" />
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
        // Founder 31/10: one row of picks (the two named floors a little wider than the numbers).
        // Founder 11/11: frosted with depth like every tappable control on glass; the chosen one is solid.
        className="mt-2 grid grid-cols-[1.5fr_1.5fr_repeat(6,1fr)] gap-1.5"
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
              className={`min-h-11 rounded-xl border px-1 py-1.5 text-xs font-semibold ${
                isSelected
                  ? 'border-(--pos-s-sel-bg) bg-(--pos-s-sel-bg) text-(--pos-s-sel-fg)'
                  : 'pos-glass-field'
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
