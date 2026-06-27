import React from 'react';
import { useTranslation } from 'react-i18next';
import { Edit, Trash2, MapPin, CheckCircle, AlertTriangle, Clock } from 'lucide-react';
import { useTheme } from '../../contexts/theme-context';
import type { DeliveryBoundaryValidationResponse } from '../../../shared/types/delivery-validation';

interface Address {
  id: string;
  street_address: string;
  city: string;
  postal_code?: string;
  floor_number?: string;
  notes?: string;
  address_type: string;
  is_default: boolean;
  created_at: string;
}

interface Customer {
  id: string;
  name: string;
  phone: string;
  email?: string;
  addresses?: Address[];
}

interface AddressSelectionCardProps {
  address: Address;
  customer: Customer;
  orderType?: 'pickup' | 'delivery';
  deliveryFee?: number;
  onEdit?: (address: Address) => void;
  onDelete?: (address: Address) => void;
  validationResult?: DeliveryBoundaryValidationResponse;
  isValidating?: boolean;
  className?: string;
}

export const AddressSelectionCard: React.FC<AddressSelectionCardProps> = ({
  address,
  customer,
  orderType = 'delivery',
  deliveryFee = 0,
  onEdit,
  onDelete,
  validationResult,
  isValidating,
  className = ''
}) => {
  const { t } = useTranslation();
  const { resolvedTheme } = useTheme();

  // Get validation status icon and color
  const getValidationIndicator = () => {
    if (isValidating) {
      return {
        Icon: Clock,
        color: resolvedTheme === 'dark' ? 'text-yellow-300' : 'text-yellow-600',
        label: t('delivery.validation.validating')
      };
    }

    if (!validationResult) {
      return null;
    }

    if (validationResult.deliveryAvailable && validationResult.zone) {
      return {
        Icon: CheckCircle,
        color: resolvedTheme === 'dark' ? 'text-green-400' : 'text-green-500',
        label: t('delivery.validation.inZone')
      };
    }

    if (!validationResult.deliveryAvailable) {
      return {
        Icon: AlertTriangle,
        color: resolvedTheme === 'dark' ? 'text-yellow-400' : 'text-yellow-600',
        label: t('delivery.validation.outOfZone')
      };
    }

    return null;
  };

  const validationIndicator = getValidationIndicator();

  return (
    <div className={`relative rounded-3xl border p-6 backdrop-blur-xl transition-transform duration-150 active:scale-[0.99] ${
      resolvedTheme === 'dark'
        ? 'border-white/12 bg-black/25 active:bg-black/35'
        : 'border-black/10 bg-white/55 active:bg-white/75'
    } ${!validationResult?.deliveryAvailable && validationResult ? 'opacity-75' : ''} ${className}`}>
      {/* Validation Status Badge (top) */}
      {validationResult?.zone && orderType === 'delivery' && (
        <div className="mb-3">
          <div className={`inline-flex items-center space-x-2 px-3 py-1.5 rounded-full text-xs font-semibold ${
            resolvedTheme === 'dark'
              ? 'bg-green-600/20 text-green-400 border border-green-500/30'
              : 'bg-green-100 text-green-700 border border-green-200'
          }`}>
            <MapPin className="w-3 h-3" />
            <span>{validationResult.zone.name}</span>
          </div>
        </div>
      )}

      {/* Address Header */}
      <div className="flex items-start justify-between mb-4">
        <div className="flex items-center space-x-3">
          <div className={`flex h-11 w-11 items-center justify-center rounded-2xl ${
            resolvedTheme === 'dark' ? 'bg-yellow-400/18' : 'bg-yellow-200/80'
          }`}>
            <MapPin className={resolvedTheme === 'dark' ? 'h-5 w-5 text-yellow-300' : 'h-5 w-5 text-yellow-700'} />
          </div>
          <div>
            <h3 className={`font-semibold ${
              resolvedTheme === 'dark' ? 'text-white' : 'text-gray-900'
            }`}>
              {t('delivery.address.header')}
            </h3>
            <p className={`text-sm ${
              resolvedTheme === 'dark' ? 'text-gray-400' : 'text-gray-500'
            }`}>
              {customer.name}
            </p>
          </div>
        </div>

        {/* Action Buttons */}
        {(onEdit || onDelete) && (
          <div className="flex space-x-2">
            {onEdit && (
              <button
                type="button"
                aria-label={t('common.actions.edit', 'Edit')}
                onClick={(e) => {
                  e.stopPropagation();
                  onEdit(address);
                }}
                className={`rounded-2xl p-2 transition-transform duration-150 active:scale-95 ${
                  resolvedTheme === 'dark'
                    ? 'text-gray-300 active:bg-white/10'
                    : 'text-gray-700 active:bg-black/10'
                }`}
              >
                <Edit className="h-4 w-4" aria-hidden="true" />
              </button>
            )}
            {onDelete && (
              <button
                type="button"
                aria-label={t('common.actions.delete', 'Delete')}
                onClick={(e) => {
                  e.stopPropagation();
                  onDelete(address);
                }}
                className={`rounded-2xl p-2 transition-transform duration-150 active:scale-95 ${
                  resolvedTheme === 'dark'
                    ? 'text-red-300 active:bg-red-500/18'
                    : 'text-red-600 active:bg-red-100'
                }`}
              >
                <Trash2 className="h-4 w-4" aria-hidden="true" />
              </button>
            )}
          </div>
        )}
      </div>

      {/* Address Details */}
      <div className="space-y-2">
        <div className={`font-medium ${
          resolvedTheme === 'dark' ? 'text-gray-200' : 'text-gray-800'
        }`}>
          {address.street_address}
        </div>

        {address.city && (
          <div className={`text-sm ${
            resolvedTheme === 'dark' ? 'text-gray-300' : 'text-gray-600'
          }`}>
            {t('delivery.address.city')} {address.city}
          </div>
        )}

        {address.postal_code && (
          <div className={`text-sm ${
            resolvedTheme === 'dark' ? 'text-gray-300' : 'text-gray-600'
          }`}>
            {t('delivery.address.postalCode')} {address.postal_code}
          </div>
        )}

        {address.floor_number && (
          <div className={`text-sm ${
            resolvedTheme === 'dark' ? 'text-gray-300' : 'text-gray-600'
          }`}>
            {t('delivery.address.floor')} {address.floor_number}
          </div>
        )}

        {address.address_type && (
          <div className={`inline-block px-2 py-1 rounded-full text-xs font-medium ${
            address.is_default
              ? resolvedTheme === 'dark'
                ? 'bg-green-600/20 text-green-400'
                : 'bg-green-100 text-green-700'
              : resolvedTheme === 'dark'
                ? 'bg-white/10 text-gray-200'
                : 'bg-gray-100 text-gray-700'
          }`}>
            {address.address_type} {address.is_default && t('delivery.address.default')}
          </div>
        )}

        {address.notes && (
          <div className={`text-sm ${
            resolvedTheme === 'dark' ? 'text-gray-400' : 'text-gray-500'
          }`}>
            {t('delivery.address.notes')} {address.notes}
          </div>
        )}
      </div>

      {/* Zone Information */}
      {validationResult?.zone && orderType === 'delivery' && (
        <div className="mt-4 pt-4 border-t border-gray-200/20">
          <div className="grid grid-cols-3 gap-3">
            <div>
              <div className={`text-xs ${
                resolvedTheme === 'dark' ? 'text-gray-400' : 'text-gray-500'
              }`}>
                {t('delivery.address.deliveryFee')}
              </div>
              <div className={`text-sm font-semibold mt-1 ${
                resolvedTheme === 'dark' ? 'text-white' : 'text-gray-900'
              }`}>
                €{validationResult.zone.deliveryFee.toFixed(2)}
              </div>
            </div>
            <div>
              <div className={`text-xs ${
                resolvedTheme === 'dark' ? 'text-gray-400' : 'text-gray-500'
              }`}>
                {t('delivery.address.estimatedTime')}
              </div>
              <div className={`text-sm font-semibold mt-1 ${
                resolvedTheme === 'dark' ? 'text-white' : 'text-gray-900'
              }`}>
                {validationResult.zone.estimatedTime
                  ? `${validationResult.zone.estimatedTime.min}-${validationResult.zone.estimatedTime.max} min`
                  : 'N/A'}
              </div>
            </div>
            {validationResult.zone.minimumOrderAmount > 0 && (
              <div>
                <div className={`text-xs ${
                  resolvedTheme === 'dark' ? 'text-gray-400' : 'text-gray-500'
                }`}>
                  {t('delivery.address.minimumOrder')}
                </div>
                <div className={`text-sm font-semibold mt-1 ${
                  resolvedTheme === 'dark' ? 'text-white' : 'text-gray-900'
                }`}>
                  €{validationResult.zone.minimumOrderAmount.toFixed(2)}
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Out of Zone Warning */}
      {!validationResult?.deliveryAvailable && validationResult && orderType === 'delivery' && (
        <div className="mt-4 pt-4 border-t border-gray-200/20">
          <div className={`flex items-center space-x-2 rounded-2xl px-3 py-2 ${
            resolvedTheme === 'dark'
              ? 'bg-yellow-600/20 text-yellow-400'
              : 'bg-yellow-100 text-yellow-700'
          }`}>
            <AlertTriangle className="h-4 w-4" aria-hidden="true" />
            <span className="text-sm font-medium">{t('delivery.validation.outsideArea')}</span>
          </div>
        </div>
      )}

      {/* Validation Indicator */}
      {validationIndicator && orderType === 'delivery' && (
        <div className="absolute top-4 right-4">
          <div className={`flex items-center space-x-1 ${validationIndicator.color}`}>
            <validationIndicator.Icon className="w-5 h-5" />
          </div>
        </div>
      )}

      {/* Selection Indicator */}
      <div className="mt-4 pt-4 border-t border-gray-200/20">
        <div className={`text-center text-sm font-medium ${
          resolvedTheme === 'dark' ? 'text-yellow-300' : 'text-yellow-700'
        }`}>
          {t('delivery.address.clickToSelect')}
        </div>
      </div>
    </div>
  );
}; 
