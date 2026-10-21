import React from 'react';
import { useTranslation } from 'react-i18next';
import { getGreeceVatCategoryCatalog } from '../../../../../../shared/services/GreeceVatService';
export function HotelVatField({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const { t } = useTranslation();
  return <label className="block text-sm">{t('hotelMoney.vatCategory')}
    <select className="mt-1 block w-full rounded-xl border bg-transparent p-3" value={value} onChange={e => onChange(e.target.value)} required>
      <option value="">{t('hotelMoney.chooseVat')}</option>
      {getGreeceVatCategoryCatalog().map(category => <option key={category.code} value={category.code}>
        {category.rate > 0 ? category.rateLabel : t(`hotelMoney.vat.${category.code}`)}
      </option>)}
    </select>
  </label>;
}
