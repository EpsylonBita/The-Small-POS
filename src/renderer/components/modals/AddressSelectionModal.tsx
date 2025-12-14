import React, { useState, useEffect } from 'react';
import { CheckCircle, AlertTriangle } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { AddressSelectionCard } from '../forms/AddressSelectionCard';
import { LiquidGlassModal } from '../ui/pos-glass-components';
import { useDeliveryValidation } from '../../hooks/useDeliveryValidation';
import type { DeliveryBoundaryValidationResponse } from '../../../shared/types/delivery-validation';
import EditAddressModal from './EditAddressModal';
import { getApiUrl } from '../../../config/environment';

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

interface AddressSelectionModalProps {
  isOpen: boolean;
  onClose: () => void;
  customer: Customer;
  orderType: 'pickup' | 'delivery';
  deliveryFee?: number;
  onAddressSelected: (customer: Customer, address: Address, validationResult?: DeliveryBoundaryValidationResponse) => void;
  onAddNewAddress?: (customer: Customer) => void;
  onValidationComplete?: (results: Map<string, DeliveryBoundaryValidationResponse>) => void;
}

export const AddressSelectionModal: React.FC<AddressSelectionModalProps> = ({
  isOpen,
  onClose,
  customer,
  orderType,
  deliveryFee = 2.50,
  onAddressSelected,
  onAddNewAddress,
  onValidationComplete
}) => {
  const { t } = useTranslation();
  const { validateAddress, isValidating } = useDeliveryValidation();

  // Track validation results for all addresses
  const [addressValidations, setAddressValidations] = useState<Map<string, DeliveryBoundaryValidationResponse>>(new Map());
  const [validatingAddressIds, setValidatingAddressIds] = useState<Set<string>>(new Set());

  // Local addresses state so edits/deletes reflect immediately in UI
  const [addresses, setAddresses] = useState<Address[]>(customer?.addresses || []);

  // Editing state
  const [editingAddress, setEditingAddress] = useState<Address | null>(null);
  const [showEditModal, setShowEditModal] = useState(false);

  // Sync local addresses when modal opens or customer changes
  useEffect(() => {
    if (isOpen) {
      setAddresses(customer?.addresses || []);
    }
  }, [isOpen, customer]);

  // Validate all addresses when modal opens or list changes (delivery only)
  useEffect(() => {
    if (isOpen && orderType === 'delivery' && addresses && addresses.length > 0) {
      const validateAllAddresses = async () => {
        const newValidations = new Map<string, DeliveryBoundaryValidationResponse>();

        for (const address of addresses || []) {
          setValidatingAddressIds(prev => new Set(prev).add(address.id));

          try {
            // Build full address string
            const fullAddress = `${address.street_address}, ${address.city}${address.postal_code ? ', ' + address.postal_code : ''}`;

            const result = await validateAddress(fullAddress);
            newValidations.set(address.id, result);
          } catch (error) {
            console.error(`[AddressSelectionModal] Error validating address ${address.id}:`, error);
          } finally {
            setValidatingAddressIds(prev => {
              const next = new Set(prev);
              next.delete(address.id);
              return next;
            });
          }
        }

        setAddressValidations(newValidations);
        onValidationComplete?.(newValidations);
      };

      validateAllAddresses();
    }
  }, [isOpen, orderType, addresses, validateAddress, onValidationComplete]);

  const handleAddressSelect = async (address: Address) => {
    let validation = addressValidations.get(address.id);
    
    // If no validation result yet and this is a delivery order, validate on-demand
    if (!validation && orderType === 'delivery') {
      try {
        const fullAddress = `${address.street_address}, ${address.city}${address.postal_code ? ', ' + address.postal_code : ''}`;
        validation = await validateAddress(fullAddress);
        // Store for future reference
        setAddressValidations(prev => new Map(prev).set(address.id, validation!));
      } catch (error) {
        console.warn('[AddressSelectionModal] On-demand validation failed:', error);
      }
    }
    
    onAddressSelected(customer, address, validation);
    onClose();
  };

  const handleAddNewAddress = () => {
    onAddNewAddress?.(customer);
    onClose();
  };

  const handleEdit = (address: Address) => {
    setEditingAddress(address);
    setShowEditModal(true);
  };

  const handleAddressUpdated = (updated: Address) => {
    setAddresses(prev => prev.map(a => (a.id === updated.id ? updated : a)));
    // Re-validate the updated address
    (async () => {
      try {
        const fullAddress = `${updated.street_address}, ${updated.city}${updated.postal_code ? ', ' + updated.postal_code : ''}`;
        const result = await validateAddress(fullAddress);
        setAddressValidations(prev => new Map(prev).set(updated.id, result));
      } catch {}
    })();
  };

  const handleDelete = async (address: Address) => {
    try {
      const ok = confirm(t('modals.addressSelection.confirmDelete') || 'Delete this address?');
      if (!ok) return;
      const url = getApiUrl(`customers/${customer.id}/addresses/${address.id}`);
      const res = await fetch(url, { method: 'DELETE' });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || json?.success === false) {
        throw new Error(json?.error || `HTTP ${res.status}`);
      }
      setAddresses(prev => prev.filter(a => a.id !== address.id));
      setAddressValidations(prev => {
        const next = new Map(prev);
        next.delete(address.id);
        return next;
      });
    } catch (e) {
      console.error('[AddressSelectionModal] Delete failed', e);
      alert(t('modals.addressSelection.deleteFailed') || 'Failed to delete address');
    }
  };

  // Calculate validation summary
  const getValidationSummary = () => {
    if (!customer || orderType !== 'delivery' || addressValidations.size === 0) {
      return null;
    }

    const total = addresses?.length || 0;
    const validated = addressValidations.size;
    const inZone = Array.from(addressValidations.values()).filter(v => v.deliveryAvailable).length;
    const outOfZone = validated - inZone;

    return { total, validated, inZone, outOfZone };
  };

  const validationSummary = getValidationSummary();

  return (
    <LiquidGlassModal
      isOpen={isOpen}
      onClose={onClose}
      title={t('modals.addressSelection.title', { type: orderType === 'pickup' ? t('modals.addressSelection.pickup') : t('modals.addressSelection.delivery') })}
      size="xl"
      closeOnBackdrop={true}
      closeOnEscape={true}
      className="max-h-[90vh]"
    >
      {customer ? (
        <>
          {/* Subtitle with customer info */}
          <p className="text-sm mb-4 liquid-glass-modal-text-muted">
            {t('modals.addressSelection.customer')}: {customer.name} • {customer.phone}
            {orderType === 'delivery' && (
              <span className="ml-2 text-green-500 font-medium">• {t('modals.addressSelection.deliveryFee')}: €{deliveryFee.toFixed(2)}</span>
            )}
          </p>

      {/* Address List */}
      <div className="overflow-y-auto max-h-[calc(90vh-200px)]">
        {orderType === 'pickup' && (
          <div className="mb-4 p-4 rounded-xl border bg-blue-50/50 dark:bg-blue-600/10 border-blue-200/50 dark:border-blue-500/30">
            <p className="text-sm liquid-glass-modal-text">
              {t('modals.addressSelection.pickupSavings')}
            </p>
          </div>
        )}

        {/* Validation Summary */}
        {validationSummary && (
          <div className={`mb-4 p-4 rounded-xl border ${
            validationSummary.outOfZone > 0
              ? 'bg-yellow-50/50 dark:bg-yellow-600/10 border-yellow-200/50 dark:border-yellow-500/30'
              : 'bg-green-50/50 dark:bg-green-600/10 border-green-200/50 dark:border-green-500/30'
          }`}>
            <div className="flex items-center justify-between">
              <div className="flex items-center space-x-2">
                {validationSummary.outOfZone > 0 ? (
                  <AlertTriangle className="w-4 h-4 text-yellow-600 dark:text-yellow-400" />
                ) : (
                  <CheckCircle className="w-4 h-4 text-green-600 dark:text-green-400" />
                )}
                <p className={`text-sm font-medium liquid-glass-modal-text`}>
                  {validatingAddressIds.size > 0
                    ? t('modals.addressSelection.validatingAddresses', { validated: validationSummary.validated, total: validationSummary.total })
                    : t('modals.addressSelection.validationSummary', { inZone: validationSummary.inZone, outOfZone: validationSummary.outOfZone })
                  }
                </p>
              </div>
            </div>
          </div>
        )}

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {addresses?.map((address) => (
              <div key={address.id} onClick={() => handleAddressSelect(address)}>
                <AddressSelectionCard
                  address={address}
                  customer={customer}
                  orderType={orderType}
                  deliveryFee={deliveryFee}
                  validationResult={addressValidations.get(address.id)}
                  isValidating={validatingAddressIds.has(address.id)}
                  onEdit={handleEdit}
                  onDelete={handleDelete}
                  className="cursor-pointer hover:scale-[1.02] transition-transform duration-200"
                />
              </div>
            ))}
          </div>

        {/* Add New Address Option */}
        {onAddNewAddress && (
          <div className="mt-6 pt-6 border-t border-gray-200/20">
            <button
              onClick={handleAddNewAddress}
              className="w-full p-6 rounded-2xl border-2 border-dashed border-gray-300/50 dark:border-gray-600/50 bg-gray-100/20 dark:bg-gray-700/20 hover:bg-gray-100/40 dark:hover:bg-gray-700/40 hover:border-blue-500/50 transition-all duration-300 hover:scale-[1.02]"
              >
              <div className="flex flex-col items-center space-y-3">
                <div className="w-12 h-12 rounded-full flex items-center justify-center bg-blue-100/60 dark:bg-blue-600/20">
                    <svg className="w-6 h-6 text-blue-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
                    </svg>
                  </div>
                <div>
                  <h3 className="font-semibold mb-1 liquid-glass-modal-text">{t('modals.addressSelection.addNewAddress')}</h3>
                  <p className="text-sm opacity-70 liquid-glass-modal-text-muted">{t('modals.addressSelection.addNewAddressDesc')}</p>
                </div>
              </div>
            </button>
          </div>
        )}
      </div>
        </>
      ) : (
        <div className="text-center py-8">
          <p className="liquid-glass-modal-text-muted">{t('common.loading')}</p>
        </div>
      )}
      {/* Edit Address Modal */}
      {editingAddress && (
        <EditAddressModal
          isOpen={showEditModal}
          onClose={() => setShowEditModal(false)}
          address={editingAddress as any}
          customerId={customer.id}
          onAddressUpdated={(a: any) => {
            handleAddressUpdated(a as Address);
            setShowEditModal(false);
          }}
        />
      )}
    </LiquidGlassModal>
  );
};