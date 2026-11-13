import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { formatCurrency } from '../../utils/format';
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
  // Presentation only: preserve every existing reveal condition (founder 11/11/2026).
  const reduceMotion = useReducedMotion();
  const revealMotion = {
    initial: reduceMotion ? false as const : { opacity: 0, height: 0, y: 12, overflow: 'hidden' },
    animate: { opacity: 1, height: 'auto', y: 0, overflow: 'visible' },
    exit: reduceMotion ? { opacity: 0 } : { opacity: 0, height: 0, overflow: 'hidden', transition: { overflow: { delay: 0, duration: 0 } } },
    transition: { duration: reduceMotion ? 0 : 0.24, ease: [0.2, 0.8, 0.2, 1] as const, overflow: { delay: reduceMotion ? 0 : 0.24, duration: 0 } },
  };
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
    <div className={`pos-glass-tap-card relative p-6 ${!validationResult?.deliveryAvailable && validationResult ? 'opacity-75' : ''} ${className}`}>
      {/* Validation Status Badge (top) */}
      <AnimatePresence initial={false}>
        {validationResult?.zone && orderType === 'delivery' && (
        <motion.div {...revealMotion} key="reveal-1" className="mb-3">
          <div className="inline-flex items-center space-x-2 px-3 py-1.5 rounded-full text-xs font-semibold text-green-700 dark:text-green-300">
            <MapPin className="w-3 h-3" />
            <span>{validationResult.zone.name}</span>
          </div>
        </motion.div>
        )}
      </AnimatePresence>

      {/* Address Header */}
      <div className="flex items-start justify-between mb-4">
        <div className="flex items-center space-x-3">
          <div className="flex h-11 w-11 items-center justify-center rounded-2xl liquid-glass-modal-text-muted">
            <MapPin className="h-5 w-5 liquid-glass-modal-text-muted" />
          </div>
          <div>
            <h3 className="font-semibold liquid-glass-modal-text">
              {t('delivery.address.header')}
            </h3>
            <p className="text-sm liquid-glass-modal-text-muted">
              {customer.name}
            </p>
          </div>
        </div>

        {/* Action Buttons */}
        <AnimatePresence initial={false}>
          {(onEdit || onDelete) && (
          <motion.div {...revealMotion} key="reveal-2" className="flex space-x-2">
            {onEdit && (
              <button
                type="button"
                aria-label={t('common.actions.edit', 'Edit')}
                onClick={(e) => {
                  e.stopPropagation();
                  onEdit(address);
                }}
                className="pos-glass-field inline-flex min-h-touch min-w-touch items-center justify-center rounded-2xl p-2"
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
                className="pos-solid-btn pos-solid-btn--danger min-h-touch min-w-touch rounded-2xl p-2"
              >
                <Trash2 className="h-4 w-4" aria-hidden="true" />
              </button>
            )}
          </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* Address Details */}
      <div className="space-y-2">
        <div className="font-medium liquid-glass-modal-text">
          {address.street_address}
        </div>

        <AnimatePresence initial={false}>

          {address.city && (
          <motion.div {...revealMotion} key="reveal-3" className="text-sm liquid-glass-modal-text-muted">
            {t('delivery.address.city')} {address.city}
          </motion.div>
          )}
        </AnimatePresence>

        <AnimatePresence initial={false}>

          {address.postal_code && (
          <motion.div {...revealMotion} key="reveal-4" className="text-sm liquid-glass-modal-text-muted">
            {t('delivery.address.postalCode')} {address.postal_code}
          </motion.div>
          )}
        </AnimatePresence>

        <AnimatePresence initial={false}>

          {address.floor_number && (
          <motion.div {...revealMotion} key="reveal-5" className="text-sm liquid-glass-modal-text-muted">
            {t('delivery.address.floor')} {address.floor_number}
          </motion.div>
          )}
        </AnimatePresence>

        <AnimatePresence initial={false}>

          {address.address_type && (
          <motion.div {...revealMotion} key="reveal-6" className={`inline-block px-2 py-1 rounded-full text-xs font-medium ${
            address.is_default ? 'text-green-700 dark:text-green-300' : 'liquid-glass-modal-text-muted'
          }`}>
            {address.address_type} {address.is_default && t('delivery.address.default')}
          </motion.div>
          )}
        </AnimatePresence>

        <AnimatePresence initial={false}>

          {address.notes && (
          <motion.div {...revealMotion} key="reveal-7" className="text-sm liquid-glass-modal-text-muted">
            {t('delivery.address.notes')} {address.notes}
          </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* Zone Information */}
      <AnimatePresence initial={false}>
        {validationResult?.zone && orderType === 'delivery' && (
        <motion.div {...revealMotion} key="reveal-8" className="mt-3 pos-glass-form-card p-3!">
          <div className="grid grid-cols-3 gap-3">
            <div>
              <div className="text-xs liquid-glass-modal-text-muted">
                {t('delivery.address.deliveryFee')}
              </div>
              <div className="text-sm font-semibold mt-1 liquid-glass-modal-text">
                {formatCurrency(validationResult.zone.deliveryFee)}
              </div>
            </div>
            <div>
              <div className="text-xs liquid-glass-modal-text-muted">
                {t('delivery.address.estimatedTime')}
              </div>
              <div className="text-sm font-semibold mt-1 liquid-glass-modal-text">
                {validationResult.zone.estimatedTime
                  ? `${validationResult.zone.estimatedTime.min}-${validationResult.zone.estimatedTime.max} min`
                  : 'N/A'}
              </div>
            </div>
            <AnimatePresence initial={false}>
              {validationResult.zone.minimumOrderAmount > 0 && (
              <motion.div {...revealMotion} key="reveal-9">
                <div className="text-xs liquid-glass-modal-text-muted">
                  {t('delivery.address.minimumOrder')}
                </div>
                <div className="text-sm font-semibold mt-1 liquid-glass-modal-text">
                  {formatCurrency(validationResult.zone.minimumOrderAmount)}
                </div>
              </motion.div>
              )}
            </AnimatePresence>
          </div>
        </motion.div>
        )}
      </AnimatePresence>

      {/* Out of Zone Warning */}
      <AnimatePresence initial={false}>
        {!validationResult?.deliveryAvailable && validationResult && orderType === 'delivery' && (
        <motion.div {...revealMotion} key="reveal-10" className="mt-3 pos-glass-form-card p-3!">
          <div className="flex items-center space-x-2 rounded-2xl px-3 py-2 text-yellow-700 dark:text-yellow-300">
            <AlertTriangle className="h-4 w-4" aria-hidden="true" />
            <span className="text-sm font-medium">{t('delivery.validation.outsideArea')}</span>
          </div>
        </motion.div>
        )}
      </AnimatePresence>

      {/* Validation Indicator */}
      {validationIndicator && orderType === 'delivery' && (
        <div className="absolute top-4 right-4">
          <div className={`flex items-center space-x-1 ${validationIndicator.color}`}>
            <validationIndicator.Icon className="w-5 h-5" />
          </div>
        </div>
      )}

      {/* Selection Indicator */}
      <div className="mt-3 pos-glass-form-card p-3!">
        <div className="text-center text-sm font-medium liquid-glass-modal-text-muted">
          {t('delivery.address.clickToSelect')}
        </div>
      </div>
    </div>
  );
}; 
