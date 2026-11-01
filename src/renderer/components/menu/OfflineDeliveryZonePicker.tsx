import React, { useId } from 'react';
import { useTranslation } from 'react-i18next';
import { MapPin } from 'lucide-react';
import type { ManualDeliveryZoneOption } from '../../../../../shared/utils/offline-delivery-zone';
import { formatCurrency } from '../../utils/format';

export interface OfflineDeliveryZonePickerProps {
  options: ManualDeliveryZoneOption[];
  loading: boolean;
  selectedZoneId: string | null;
  onChoose: (zoneId: string) => void;
  className?: string;
}

/**
 * Offline week Ω6β: offline, an address that cannot be located (its Google
 * point expired, or it has none) gets its zone from the cashier, chosen from
 * the store's cached zones. Each zone shows its delivery fee; the chosen
 * zone's fee applies and the order is marked "zone chosen manually".
 */
export const OfflineDeliveryZonePicker: React.FC<OfflineDeliveryZonePickerProps> = ({
  options,
  loading,
  selectedZoneId,
  onChoose,
  className = '',
}) => {
  const { t } = useTranslation();
  const titleId = useId();
  const chosen = options.find((option) => option.id === selectedZoneId) ?? null;

  return (
    <div
      role="group"
      aria-labelledby={titleId}
      data-testid="offline-zone-picker"
      className={`flex items-start gap-2 p-3 rounded-lg mb-3 bg-(--pos-s-surface-2) dark:bg-zinc-800 border border-(--pos-s-border) dark:border-zinc-700 ${className}`}
    >
      <MapPin className="w-5 h-5 shrink-0 text-amber-600 dark:text-amber-300" aria-hidden="true" />
      <div className="flex-1 min-w-0">
        <p id={titleId} className="text-sm font-semibold antialiased text-amber-800 dark:text-amber-200">
          {t('menu.cart.offlineZoneChoiceTitle')}
        </p>
        <p className="mt-0.5 text-xs antialiased text-amber-800 dark:text-amber-100" data-testid="offline-zone-picker-hint">
          {chosen ? t('menu.cart.zoneChosenManually') : t('menu.cart.offlineZoneChoiceHint')}
        </p>
        {loading && options.length === 0 ? (
          <p role="status" className="mt-2 text-xs antialiased text-amber-800 dark:text-amber-100">
            {t('menu.cart.offlineZoneChoiceLoading')}
          </p>
        ) : options.length === 0 ? (
          <p role="alert" className="mt-2 text-xs font-medium antialiased text-amber-800 dark:text-amber-100" data-testid="offline-zone-picker-empty">
            {t('menu.cart.offlineZoneChoiceNoZones')}
          </p>
        ) : (
          <div role="radiogroup" aria-labelledby={titleId} className="mt-2 flex flex-wrap gap-2">
            {options.map((option) => {
              const selected = option.id === selectedZoneId;
              return (
                <button
                  key={option.id}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  onClick={() => onChoose(option.id)}
                  data-testid={`offline-zone-option-${option.id}`}
                  className={`min-h-[40px] rounded-lg border px-3 py-1.5 text-sm font-semibold antialiased transition-colors ${
                    selected
                      ? 'border-amber-600 bg-(--pos-s-surface-2) text-amber-900 dark:border-amber-300 dark:bg-zinc-800 dark:text-amber-50'
                      : 'border-(--pos-s-border) text-amber-800 active:bg-(--pos-s-surface-2) dark:border-zinc-700 dark:text-amber-100 dark:active:bg-zinc-800'
                  }`}
                >
                  {option.name} · {formatCurrency(option.deliveryFee)}
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
};
