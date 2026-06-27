import React from 'react';
import { useTranslation } from 'react-i18next';
import { useTheme } from '../../contexts/theme-context';

interface CustomerInfo {
  name: string;
  phone: string;
  email?: string;
  address?: {
    street: string;
    city: string;
    postalCode: string;
    coordinates?: { lat: number; lng: number };
  };
}

interface CustomerDetailsFormProps {
  customerInfo: CustomerInfo;
  setCustomerInfo: React.Dispatch<React.SetStateAction<CustomerInfo>>;
}

export const CustomerDetailsForm: React.FC<CustomerDetailsFormProps> = ({
  customerInfo,
  setCustomerInfo,
}) => {
  const { t } = useTranslation();
  const { resolvedTheme } = useTheme();
  const inputClass = `w-full rounded-2xl border px-3 py-3 transition-colors duration-150 backdrop-blur-sm ${
    resolvedTheme === 'dark'
      ? 'border-white/12 bg-black/25 text-white placeholder-white/45 focus:border-yellow-400/80 focus:bg-black/35'
      : 'border-black/12 bg-white/65 text-gray-950 placeholder-gray-500 focus:border-yellow-500 focus:bg-white/90'
  } focus:outline-none focus:ring-2 focus:ring-yellow-400/40`;

  return (
    <div>
      <h3 className={`text-lg font-semibold mb-3 ${
        resolvedTheme === 'dark' ? 'text-white' : 'text-gray-900'
      }`}>{t('forms.customerInfo.header')}</h3>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div>
          <label className={`block text-sm font-medium mb-1 ${
            resolvedTheme === 'dark' ? 'text-gray-300' : 'text-gray-700'
          }`}>
            {t('forms.customerInfo.customerName')} <span className="text-red-500">*</span>
          </label>
          <input
            type="text"
            value={customerInfo.name}
            onChange={(e) =>
              setCustomerInfo((prev) => ({ ...prev, name: e.target.value }))
            }
            placeholder={t('forms.customerInfo.customerNamePlaceholder')}
            className={inputClass}
            required
          />
        </div>

        <div>
          <label className={`block text-sm font-medium mb-1 ${
            resolvedTheme === 'dark' ? 'text-gray-300' : 'text-gray-700'
          }`}>
            {t('forms.customerInfo.phoneNumber')} <span className="text-red-500">*</span>
          </label>
          <input
            type="tel"
            value={customerInfo.phone}
            onChange={(e) =>
              setCustomerInfo((prev) => ({ ...prev, phone: e.target.value }))
            }
            placeholder={t('forms.customerInfo.phoneNumberPlaceholder')}
            className={inputClass}
            required
          />
        </div>

        <div className="md:col-span-2">
          <label className={`block text-sm font-medium mb-1 ${
            resolvedTheme === 'dark' ? 'text-gray-300' : 'text-gray-700'
          }`}>
            {t('forms.customerInfo.emailAddress')}
          </label>
          <input
            type="email"
            value={customerInfo.email || ""}
            onChange={(e) =>
              setCustomerInfo((prev) => ({ ...prev, email: e.target.value }))
            }
            placeholder={t('forms.customerInfo.emailAddressPlaceholder')}
            className={inputClass}
          />
        </div>
      </div>
    </div>
  );
};
