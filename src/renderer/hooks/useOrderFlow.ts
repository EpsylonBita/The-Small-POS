import { useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import toast from 'react-hot-toast';
import { Customer, CustomerInfo } from '../types/customer';
import { customerService } from '../services';

export type OrderType = "dine-in" | "pickup" | "delivery";
export type OrderFlowStep = "type" | "phone" | "customer" | "menu";

interface ExistingCustomer extends Customer {
  postal_code?: string;
  created_at: string;
  updated_at: string;
}

interface OrderFlowState {
  // Current flow state
  currentStep: OrderFlowStep | null;
  selectedOrderType: "pickup" | "delivery" | null;
  orderType: OrderType;
  
  // Customer data
  phoneNumber: string;
  customerInfo: CustomerInfo;
  existingCustomer: ExistingCustomer | null;
  
  // Additional order data
  tableNumber: string;
  specialInstructions: string;
  
  // Loading states
  isLookingUp: boolean;
  isValidatingAddress: boolean;
  addressValid: boolean;
}

const initialCustomerInfo: CustomerInfo = {
  name: '',
  phone: '',
  email: '',
  address: {
    street: '',
    city: '',
    postalCode: '',
  }
};

const initialState: OrderFlowState = {
  currentStep: null,
  selectedOrderType: null,
  orderType: "pickup",
  phoneNumber: '',
  customerInfo: initialCustomerInfo,
  existingCustomer: null,
  tableNumber: '',
  specialInstructions: '',
  isLookingUp: false,
  isValidatingAddress: false,
  addressValid: false,
};

export const useOrderFlow = () => {
  const navigate = useNavigate();
  const [state, setState] = useState<OrderFlowState>(initialState);

  // Reset flow to initial state
  const resetFlow = useCallback(() => {
    setState(initialState);
  }, []);

  // Start new order flow
  const startOrderFlow = useCallback(() => {
    setState(prev => ({ ...prev, currentStep: "type" }));
  }, []);

  // Handle order type selection
  const selectOrderType = useCallback((type: "pickup" | "delivery") => {
    setState(prev => ({
      ...prev,
      selectedOrderType: type,
      orderType: type,
      currentStep: null
    }));

    if (type === "pickup") {
      // For pickup orders, go directly to menu
      navigate(`/menu?orderType=pickup`);
      resetFlow();
    } else {
      // For delivery orders, show phone lookup
      setState(prev => ({ ...prev, currentStep: "phone" }));
    }
  }, [navigate, resetFlow]);

  // Handle phone number lookup
  const lookupCustomer = useCallback(async () => {
    if (!state.phoneNumber.trim()) {
      toast.error("Please enter a phone number");
      return;
    }

    setState(prev => ({ ...prev, isLookingUp: true }));

    try {
      const customer = await customerService.lookupByPhone(state.phoneNumber);

      if (customer && customer.id) {
        // Customer found, populate form with existing data
        const defaultAddress = customer.addresses && customer.addresses.length > 0
          ? customer.addresses[0]
          : null;

        setState(prev => ({
           ...prev,
           existingCustomer: customer as ExistingCustomer,
           customerInfo: {
             name: customer.name,
             phone: customer.phone,
             email: customer.email || '',
             address: defaultAddress ? {
               street: defaultAddress.street,
               city: defaultAddress.city,
               postalCode: defaultAddress.postal_code,
               coordinates: undefined
             } : prev.customerInfo.address
           },
           isLookingUp: false,
           currentStep: "customer"
         }));

        toast.success(`Found existing customer: ${customer.name}`);
      } else {
        // Customer not found, create new
        setState(prev => ({
          ...prev,
          existingCustomer: null,
          customerInfo: {
            ...initialCustomerInfo,
            phone: prev.phoneNumber
          },
          isLookingUp: false,
          currentStep: "customer"
        }));

        toast.success("New customer - please fill in details");
      }
    } catch (error) {
      console.error('Customer lookup failed:', error);
      setState(prev => ({
        ...prev,
        isLookingUp: false,
        existingCustomer: null,
        customerInfo: {
          ...initialCustomerInfo,
          phone: prev.phoneNumber
        },
        currentStep: "customer"
      }));

      toast.error("Customer lookup failed, creating new customer");
    }
  }, [state.phoneNumber]);

  // Update phone number
  const updatePhoneNumber = useCallback((phone: string) => {
    setState(prev => ({ ...prev, phoneNumber: phone }));
  }, []);

  // Update customer info
  const updateCustomerInfo = useCallback((info: Partial<CustomerInfo>) => {
    setState(prev => ({
      ...prev,
      customerInfo: { ...prev.customerInfo, ...info }
    }));
  }, []);

  // Update order type
  const updateOrderType = useCallback((type: OrderType) => {
    setState(prev => ({ ...prev, orderType: type }));
  }, []);

  // Update table number
  const updateTableNumber = useCallback((table: string) => {
    setState(prev => ({ ...prev, tableNumber: table }));
  }, []);

  // Update special instructions
  const updateSpecialInstructions = useCallback((instructions: string) => {
    setState(prev => ({ ...prev, specialInstructions: instructions }));
  }, []);

  // Validate address
  const validateAddress = useCallback(async (address: string) => {
    setState(prev => ({ ...prev, isValidatingAddress: true }));
    
    try {
      // Simulate address validation
      await new Promise(resolve => setTimeout(resolve, 1000));
      const isValid = address.trim().length > 10; // Simple validation
      
      setState(prev => ({
        ...prev,
        isValidatingAddress: false,
        addressValid: isValid
      }));
      
      if (isValid) {
        toast.success("Address validated");
      } else {
        toast.error("Please enter a complete address");
      }
    } catch (error) {
      setState(prev => ({
        ...prev,
        isValidatingAddress: false,
        addressValid: false
      }));
      toast.error("Address validation failed");
    }
  }, []);

  // Complete customer info and proceed to menu
  const completeCustomerInfo = useCallback(() => {
    if (!state.customerInfo.name.trim()) {
      toast.error("Please enter customer name");
      return;
    }

    if (!state.customerInfo.phone.trim()) {
      toast.error("Please enter phone number");
      return;
    }

    if (state.orderType === "delivery" && !state.customerInfo.address?.street?.trim()) {
      toast.error("Please enter delivery address");
      return;
    }

    // Navigate to menu with order context
    const params = new URLSearchParams({
      orderType: state.orderType,
      customerName: state.customerInfo.name,
      customerPhone: state.customerInfo.phone,
      ...(state.orderType === "delivery" && state.customerInfo.address?.street && {
        deliveryAddress: state.customerInfo.address.street
      }),
      ...(state.tableNumber && { tableNumber: state.tableNumber }),
      ...(state.specialInstructions && { specialInstructions: state.specialInstructions })
    });

    navigate(`/menu?${params.toString()}`);
    resetFlow();
    toast.success("Proceeding to menu");
  }, [state, navigate, resetFlow]);

  // Close current step
  const closeCurrentStep = useCallback(() => {
    setState(prev => ({ ...prev, currentStep: null }));
  }, []);

  // Modal visibility helpers
  const showOrderTypeModal = state.currentStep === "type";
  const showPhoneLookupModal = state.currentStep === "phone";
  const showCustomerInfoModal = state.currentStep === "customer";

  return {
    // State
    ...state,
    
    // Modal visibility
    showOrderTypeModal,
    showPhoneLookupModal,
    showCustomerInfoModal,
    
    // Actions
    startOrderFlow,
    selectOrderType,
    lookupCustomer,
    updatePhoneNumber,
    updateCustomerInfo,
    updateOrderType,
    updateTableNumber,
    updateSpecialInstructions,
    validateAddress,
    completeCustomerInfo,
    closeCurrentStep,
    resetFlow,
  };
};