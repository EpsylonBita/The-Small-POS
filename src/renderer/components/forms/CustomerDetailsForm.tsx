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
            className={`w-full px-3 py-2 border rounded-md transition-all duration-200 backdrop-blur-sm ${
              resolvedTheme === 'dark'
                ? 'bg-gray-700/50 border-gray-600/50 text-white placeholder-gray-400 focus:border-blue-400/70 focus:bg-gray-700/70'
                : 'bg-white/70 border-gray-300 text-gray-900 placeholder-gray-500 focus:border-blue-500 focus:bg-white/90'
            } focus:outline-none focus:ring-2 focus:ring-blue-500/30`}
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
            className={`w-full px-3 py-2 border rounded-md transition-all duration-200 backdrop-blur-sm ${
              resolvedTheme === 'dark'
                ? 'bg-gray-700/50 border-gray-600/50 text-white placeholder-gray-400 focus:border-blue-400/70 focus:bg-gray-700/70'
                : 'bg-white/70 border-gray-300 text-gray-900 placeholder-gray-500 focus:border-blue-500 focus:bg-white/90'
            } focus:outline-none focus:ring-2 focus:ring-blue-500/30`}
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
            className={`w-full px-3 py-2 border rounded-md transition-all duration-200 backdrop-blur-sm ${
              resolvedTheme === 'dark'
                ? 'bg-gray-700/50 border-gray-600/50 text-white placeholder-gray-400 focus:border-blue-400/70 focus:bg-gray-700/70'
                : 'bg-white/70 border-gray-300 text-gray-900 placeholder-gray-500 focus:border-blue-500 focus:bg-white/90'
            } focus:outline-none focus:ring-2 focus:ring-blue-500/30`}
          />
        </div>
      </div>
    </div>
  );
}; 