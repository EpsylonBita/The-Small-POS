import { useState, useEffect } from 'react';

interface UseDiscountSettingsReturn {
  maxDiscountPercentage: number;
  taxRatePercentage: number;
  isLoading: boolean;
  error: string | null;
  refreshSettings: () => Promise<void>;
}

/**
 * Custom hook for managing discount settings
 * 
 * Fetches and caches the maximum discount percentage setting from the main process.
 * Provides a refresh function to manually reload settings when needed.
 * 
 * @returns {UseDiscountSettingsReturn} Object containing max discount percentage, loading state, error state, and refresh function
 * 
 * @example
 * ```tsx
 * const { maxDiscountPercentage, isLoading, error } = useDiscountSettings();
 * 
 * if (isLoading) return <div>Loading settings...</div>;
 * if (error) return <div>Error: {error}</div>;
 * 
 * // Use maxDiscountPercentage for validation
 * if (discountValue > maxDiscountPercentage) {
 *   alert(`Discount cannot exceed ${maxDiscountPercentage}%`);
 * }
 * ```
 */
export function useDiscountSettings(): UseDiscountSettingsReturn {
  const [maxDiscountPercentage, setMaxDiscountPercentage] = useState<number>(30); // Default to 30%
  const [taxRatePercentage, setTaxRatePercentage] = useState<number>(24); // Default to 24% (Greek VAT)
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  const fetchSettings = async () => {
    setIsLoading(true);
    setError(null);

    try {
      // Check if we're in Electron or browser mode
      if (window.electronAPI?.getDiscountMaxPercentage && window.electronAPI?.getTaxRatePercentage) {
        // Electron mode - use IPC
        const [discountPercentage, taxRate] = await Promise.all([
          window.electronAPI.getDiscountMaxPercentage(),
          window.electronAPI.getTaxRatePercentage()
        ]);

        // Validate discount percentage
        if (typeof discountPercentage === 'number' && discountPercentage >= 0 && discountPercentage <= 100) {
          setMaxDiscountPercentage(discountPercentage);
        } else {
          console.warn('Invalid discount percentage received, using default (30%)');
          setMaxDiscountPercentage(30);
        }

        // Validate tax rate
        if (typeof taxRate === 'number' && taxRate >= 0 && taxRate <= 100) {
          setTaxRatePercentage(taxRate);
        } else {
          console.warn('Invalid tax rate received, using default (24%)');
          setTaxRatePercentage(24);
        }
      } else {
        // Browser mode - use default values or fetch from API
        console.log('Browser mode: Using default discount and tax settings');
        setMaxDiscountPercentage(30); // Default discount
        setTaxRatePercentage(8.25); // Use the tax rate from database
      }
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Failed to fetch settings';
      console.error('Error fetching settings:', err);
      setError(errorMessage);
      // Fall back to default values on error
      setMaxDiscountPercentage(30);
      setTaxRatePercentage(24);
    } finally {
      setIsLoading(false);
    }
  };

  // Fetch settings on mount
  useEffect(() => {
    fetchSettings();
  }, []);

  // Refresh settings when terminal settings are updated from sync/config changes.
  useEffect(() => {
    const unsubscribe = (window as any)?.electronAPI?.onTerminalSettingsUpdated?.(() => {
      fetchSettings();
    });

    return () => {
      if (typeof unsubscribe === 'function') {
        unsubscribe();
      }
    };
  }, []);

  // Also react to granular settings sync events emitted during admin sync.
  useEffect(() => {
    const ipc = (window as any)?.electronAPI?.ipcRenderer;
    if (!ipc?.on) {
      return;
    }

    const handleSettingsUpdate = (payload: any) => {
      const category = payload?.type;
      if (!category || category === 'discount' || category === 'terminal' || category === 'payment') {
        fetchSettings();
      }
    };

    ipc.on('settings:update', handleSettingsUpdate);
    return () => {
      ipc.removeListener?.('settings:update', handleSettingsUpdate);
    };
  }, []);

  const refreshSettings = async () => {
    await fetchSettings();
  };

  return {
    maxDiscountPercentage,
    taxRatePercentage,
    isLoading,
    error,
    refreshSettings
  };
}

