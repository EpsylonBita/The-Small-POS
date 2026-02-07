import React from "react";
import { useTranslation } from "react-i18next";
import { useTheme } from "../contexts/theme-context";
import { Package, Truck, Utensils } from "lucide-react";

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

interface CustomerInfoFormProps {
  customerInfo: CustomerInfo;
  setCustomerInfo: React.Dispatch<React.SetStateAction<CustomerInfo>>;
  orderType: "dine-in" | "pickup" | "delivery";
  setOrderType: React.Dispatch<
    React.SetStateAction<"dine-in" | "pickup" | "delivery">
  >;

  tableNumber: string;
  setTableNumber: React.Dispatch<React.SetStateAction<string>>;
  specialInstructions: string;
  setSpecialInstructions: React.Dispatch<React.SetStateAction<string>>;
  onValidateAddress: (address: string) => Promise<boolean>;
  isValidatingAddress: boolean;
  addressValid: boolean;
}

const CustomerInfoForm: React.FC<CustomerInfoFormProps> = ({
  customerInfo,
  setCustomerInfo,
  orderType,
  setOrderType,
  tableNumber,
  setTableNumber,
  specialInstructions,
  setSpecialInstructions,
  onValidateAddress,
  isValidatingAddress,
  addressValid,
}) => {
  const { t } = useTranslation();
  const { theme, resolvedTheme } = useTheme();

  const handleAddressChange = (field: string, value: string) => {
    setCustomerInfo((prev) => ({
      ...prev,
      address: {
        ...prev.address,
        [field]: value,
      } as any,
    }));
  };

  const handleValidateAddress = async () => {
    try {
      if (!customerInfo.address?.street || !customerInfo.address?.city) {
        return;
      }

      const fullAddress = `${customerInfo.address.street}, ${customerInfo.address.city}, ${customerInfo.address.postalCode || ""}`;
      await onValidateAddress(fullAddress);
    } catch (error) {
      console.error('Address validation failed:', error);
      // Could add toast notification here
    }
  };

  return (
    <div className="space-y-6">
      {/* Order Type Selection */}
      <div>
        <h3 className={`text-lg font-semibold mb-3 ${
          resolvedTheme === 'dark' ? 'text-white' : 'text-gray-900'
        }`}>{t('forms.orderType.header')}</h3>
        <div className="grid grid-cols-3 gap-4">
          {(["dine-in", "pickup", "delivery"] as const).map((type) => (
            <button
              key={type}
              onClick={() => setOrderType(type)}
              className={`p-4 border rounded-lg text-center transition-all duration-300 backdrop-blur-sm ${
                orderType === type
                  ? "border-blue-500 bg-blue-50 text-blue-700"
                  : resolvedTheme === 'dark'
                    ? "border-gray-600/50 bg-gray-700/30 text-gray-300 hover:border-gray-500/70 hover:bg-gray-700/50"
                    : "border-gray-200 bg-white/50 text-gray-700 hover:border-gray-300 hover:bg-white/70"
              } hover:scale-[1.02] transform focus:outline-none focus:ring-2 focus:ring-blue-500/30`}
            >
              <div className="text-2xl mb-2 flex items-center justify-center">
                {type === "dine-in" && <Utensils className="w-6 h-6" />}
                {type === "pickup" && <Package className="w-6 h-6" />}
                {type === "delivery" && <Truck className="w-6 h-6" />}
              </div>
              <div className="font-medium capitalize">
                {type === "dine-in"
                  ? t('forms.orderType.dineIn')
                  : type === "pickup"
                    ? t('forms.orderType.pickup')
                    : t('forms.orderType.delivery')}
              </div>
            </button>
          ))}
        </div>
      </div>

      {/* Customer Information */}
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

      {/* Table Number for Dine-in */}
      {orderType === "dine-in" && (
        <div>
          <h3 className={`text-lg font-semibold mb-3 ${
            resolvedTheme === 'dark' ? 'text-white' : 'text-gray-900'
          }`}>{t('forms.tableInfo.header')}</h3>
          <div className="max-w-xs">
            <label className={`block text-sm font-medium mb-1 ${
              resolvedTheme === 'dark' ? 'text-gray-300' : 'text-gray-700'
            }`}>
              {t('forms.tableInfo.tableNumber')} <span className="text-red-500">*</span>
            </label>
            <input
              type="text"
              value={tableNumber}
              onChange={(e) => setTableNumber(e.target.value)}
              placeholder={t('forms.tableInfo.tableNumberPlaceholder')}
              className={`w-full px-3 py-2 border rounded-md transition-all duration-200 backdrop-blur-sm ${
                resolvedTheme === 'dark'
                  ? 'bg-gray-700/50 border-gray-600/50 text-white placeholder-gray-400 focus:border-blue-400/70 focus:bg-gray-700/70'
                  : 'bg-white/70 border-gray-300 text-gray-900 placeholder-gray-500 focus:border-blue-500 focus:bg-white/90'
              } focus:outline-none focus:ring-2 focus:ring-blue-500/30`}
              required
            />
          </div>
        </div>
      )}

      {/* Delivery Address */}
      {orderType === "delivery" && (
        <div>
          <h3 className={`text-lg font-semibold mb-3 ${
            resolvedTheme === 'dark' ? 'text-white' : 'text-gray-900'
          }`}>{t('forms.deliveryAddress.header')}</h3>
          <div className="space-y-4">
            <div>
              <label className={`block text-sm font-medium mb-1 ${
                resolvedTheme === 'dark' ? 'text-gray-300' : 'text-gray-700'
              }`}>
                {t('forms.deliveryAddress.streetAddress')} <span className="text-red-500">*</span>
              </label>
              <input
                type="text"
                value={customerInfo.address?.street || ""}
                onChange={(e) => handleAddressChange("street", e.target.value)}
                placeholder={t('forms.deliveryAddress.streetAddressPlaceholder')}
                className={`w-full px-3 py-2 border rounded-md transition-all duration-200 backdrop-blur-sm ${
                  resolvedTheme === 'dark'
                    ? 'bg-gray-700/50 border-gray-600/50 text-white placeholder-gray-400 focus:border-blue-400/70 focus:bg-gray-700/70'
                    : 'bg-white/70 border-gray-300 text-gray-900 placeholder-gray-500 focus:border-blue-500 focus:bg-white/90'
                } focus:outline-none focus:ring-2 focus:ring-blue-500/30`}
                required
              />
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className={`block text-sm font-medium mb-1 ${
                  resolvedTheme === 'dark' ? 'text-gray-300' : 'text-gray-700'
                }`}>
                  {t('forms.deliveryAddress.city')} <span className="text-red-500">*</span>
                </label>
                <input
                  type="text"
                  value={customerInfo.address?.city || ""}
                  onChange={(e) => handleAddressChange("city", e.target.value)}
                  placeholder={t('forms.deliveryAddress.cityPlaceholder')}
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
                  {t('forms.deliveryAddress.postalCode')}
                </label>
                <input
                  type="text"
                  value={customerInfo.address?.postalCode || ""}
                  onChange={(e) =>
                    handleAddressChange("postalCode", e.target.value)
                  }
                  placeholder={t('forms.deliveryAddress.postalCodePlaceholder')}
                  className={`w-full px-3 py-2 border rounded-md transition-all duration-200 backdrop-blur-sm ${
                    resolvedTheme === 'dark'
                      ? 'bg-gray-700/50 border-gray-600/50 text-white placeholder-gray-400 focus:border-blue-400/70 focus:bg-gray-700/70'
                      : 'bg-white/70 border-gray-300 text-gray-900 placeholder-gray-500 focus:border-blue-500 focus:bg-white/90'
                  } focus:outline-none focus:ring-2 focus:ring-blue-500/30`}
                />
              </div>
            </div>

            {/* Address Validation */}
            <div className="flex items-center space-x-4">
              <button
                onClick={handleValidateAddress}
                disabled={
                  isValidatingAddress ||
                  !customerInfo.address?.street ||
                  !customerInfo.address?.city
                }
                className={`px-4 py-2 rounded-md font-medium transition-all duration-300 backdrop-blur-sm ${
                  isValidatingAddress ||
                  !customerInfo.address?.street ||
                  !customerInfo.address?.city
                    ? resolvedTheme === 'dark'
                      ? "bg-gray-500/20 border border-gray-500/30 text-gray-400 cursor-not-allowed"
                      : "bg-gray-400/20 border border-gray-400/30 text-gray-500 cursor-not-allowed"
                    : "bg-blue-600/80 text-white hover:bg-blue-600/90 border border-blue-500/50 hover:border-blue-400/70"
                }`}
              >
                {isValidatingAddress ? (
                  <div className="flex items-center">
                    <div className="w-4 h-4 border-2 border-current border-t-transparent rounded-full animate-spin mr-2"></div>
                    {t('forms.deliveryAddress.validating')}
                  </div>
                ) : (
                  t('forms.deliveryAddress.validateAddress')
                )}
              </button>

              {addressValid && (
                <div className="flex items-center text-green-600">
                  <svg
                    className="w-5 h-5 mr-1"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M5 13l4 4L19 7"
                    />
                  </svg>
                  {t('forms.deliveryAddress.addressValidated')}
                </div>
              )}
            </div>

            {/* Delivery Zone Warning */}
            <div className={`border rounded-md p-4 backdrop-blur-sm ${
              resolvedTheme === 'dark'
                ? 'bg-yellow-900/20 border-yellow-700/50'
                : 'bg-yellow-50/80 border-yellow-200/70'
            }`}>
              <div className="flex">
                <svg
                  className={`w-5 h-5 mr-2 mt-0.5 ${
                    resolvedTheme === 'dark' ? 'text-yellow-400' : 'text-yellow-500'
                  }`}
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L3.732 16.5c-.77.833.192 2.5 1.732 2.5z"
                  />
                </svg>
                <div className={`text-sm ${
                  resolvedTheme === 'dark' ? 'text-yellow-200' : 'text-yellow-800'
                }`}>
                  <p className="font-medium">{t('forms.deliveryAddress.deliveryZoneInfo')}</p>
                  <p>
                    {t('forms.deliveryAddress.deliveryZoneDescription')}
                  </p>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Special Instructions */}
      <div>
        <h3 className={`text-lg font-semibold mb-3 ${
          resolvedTheme === 'dark' ? 'text-white' : 'text-gray-900'
        }`}>{t('forms.specialInstructions.header')}</h3>
        <textarea
          value={specialInstructions}
          onChange={(e) => setSpecialInstructions(e.target.value)}
          placeholder={t('forms.specialInstructions.placeholder')}
          rows={4}
          className={`w-full px-3 py-2 border rounded-md transition-all duration-200 backdrop-blur-sm resize-none ${
            resolvedTheme === 'dark'
              ? 'bg-gray-700/50 border-gray-600/50 text-white placeholder-gray-400 focus:border-blue-400/70 focus:bg-gray-700/70'
              : 'bg-white/70 border-gray-300 text-gray-900 placeholder-gray-500 focus:border-blue-500 focus:bg-white/90'
          } focus:outline-none focus:ring-2 focus:ring-blue-500/30`}
        />
      </div>


    </div>
  );
};

export default CustomerInfoForm;
