import { useState, useCallback } from 'react';
import toast from 'react-hot-toast';
import { Customer, CustomerSearchHistory } from '../types/customer';
import { customerService } from '../services';

interface CustomerLookupState {
  phoneNumber: string;
  isLookingUp: boolean;
  foundCustomer: Customer | null;
  lookupHistory: Customer[];
  recentSearches: string[];
}

const initialState: CustomerLookupState = {
  phoneNumber: '',
  isLookingUp: false,
  foundCustomer: null,
  lookupHistory: [],
  recentSearches: [],
};

export const useCustomerLookup = () => {
  const [state, setState] = useState<CustomerLookupState>(initialState);

  // Update phone number
  const updatePhoneNumber = useCallback((phone: string) => {
    setState(prev => ({ ...prev, phoneNumber: phone }));
  }, []);

  // Clear search
  const clearSearch = useCallback(() => {
    setState(prev => ({ 
      ...prev, 
      phoneNumber: '', 
      foundCustomer: null 
    }));
  }, []);

  // Add to recent searches
  const addToRecentSearches = useCallback((phone: string) => {
    setState(prev => ({
      ...prev,
      recentSearches: [
        phone,
        ...prev.recentSearches.filter(p => p !== phone)
      ].slice(0, 5) // Keep only last 5 searches
    }));
  }, []);

  // Lookup customer by phone
  const lookupCustomer = useCallback(async (phone?: string) => {
    const searchPhone = phone || state.phoneNumber;

    if (!searchPhone.trim()) {
      toast.error("Please enter a phone number");
      return null;
    }

    setState(prev => ({ ...prev, isLookingUp: true }));

    try {
      const customer = await customerService.lookupByPhone(searchPhone);

      setState(prev => {
        const baseState = {
          ...prev,
          isLookingUp: false,
          foundCustomer: customer,
        };

        if (customer && customer.id) {
          return {
            ...baseState,
            lookupHistory: [
              customer,
              ...prev.lookupHistory.filter(c => c.id !== customer.id)
            ].slice(0, 10) // Keep only last 10 customers
          };
        }

        return baseState;
      });

      if (customer && customer.name) {
        addToRecentSearches(searchPhone);
        toast.success(`Found customer: ${customer.name}`);
        return customer;
      } else {
        addToRecentSearches(searchPhone);
        toast.success("Customer not found - creating new");
        return null;
      }
    } catch (error) {
      console.error('Customer lookup failed:', error);
      setState(prev => ({
        ...prev,
        isLookingUp: false,
        foundCustomer: null
      }));

      toast.error("Customer lookup failed");
      return null;
    }
  }, [state.phoneNumber, addToRecentSearches]);

  // Quick lookup from recent searches
  const quickLookup = useCallback(async (phone: string) => {
    setState(prev => ({ ...prev, phoneNumber: phone }));
    return await lookupCustomer(phone);
  }, [lookupCustomer]);

  // Get customer from history
  const getFromHistory = useCallback((customerId: string) => {
    const customer = state.lookupHistory.find(c => c.id === customerId);
    if (customer) {
      setState(prev => ({
        ...prev,
        foundCustomer: customer,
        phoneNumber: customer.phone || ''
      }));
      return customer;
    }
    return null;
  }, [state.lookupHistory]);

  // Reset state
  const reset = useCallback(() => {
    setState(initialState);
  }, []);

  return {
    // State
    phoneNumber: state.phoneNumber,
    isLookingUp: state.isLookingUp,
    foundCustomer: state.foundCustomer,
    lookupHistory: state.lookupHistory,
    recentSearches: state.recentSearches,
    
    // Actions
    updatePhoneNumber,
    lookupCustomer,
    quickLookup,
    clearSearch,
    getFromHistory,
    reset,
    
    // Computed
    hasFoundCustomer: !!state.foundCustomer,
    hasHistory: state.lookupHistory.length > 0,
    hasRecentSearches: state.recentSearches.length > 0,
  };
};