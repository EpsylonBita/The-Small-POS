import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { getBridge } from '../../lib';

interface UseDiscountSettingsReturn {
  maxDiscountPercentage: number;
  taxRatePercentage: number;
  isLoading: boolean;
  error: string | null;
  /**
   * The store's discount cap or tax rate could not be read (item H, fix
   * review 30/09/2026). The values above are then not the store's: nothing
   * may be priced, capped or split on them, and checkout is paused until a
   * read succeeds (`refreshSettings`).
   */
  unavailable: boolean;
  refreshSettings: () => Promise<void>;
}

const isPercentage = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100;

/**
 * Custom hook for managing discount settings
 *
 * Fetches the maximum discount percentage and the tax rate from the native
 * settings. A setting that is not stored reads as the till's default (the
 * native side answers 100% / 0%). A read that fails, or a stored value that
 * is not a percentage, is "unavailable": it never falls back to an assumed
 * 30% / 24% (item H, fix review 30/09/2026; the same decision as Android).
 *
 * @example
 * ```tsx
 * const { maxDiscountPercentage, unavailable } = useDiscountSettings();
 * if (unavailable) return <PausedCheckoutNotice />;
 * ```
 */
export function useDiscountSettings(): UseDiscountSettingsReturn {
  const bridge = useMemo(() => getBridge(), []);
  const [maxDiscountPercentage, setMaxDiscountPercentage] = useState<number>(30); // Shown only once read
  const [taxRatePercentage, setTaxRatePercentage] = useState<number>(24); // Shown only once read
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [unavailable, setUnavailable] = useState<boolean>(false);
  const generationRef = useRef(0);

  const fetchSettings = useCallback(async () => {
    const generation = ++generationRef.current;
    setIsLoading(true);
    setError(null);

    try {
      const [discountPercentage, taxRate] = await Promise.all([
        bridge.settings.getDiscountMax(),
        bridge.settings.getTaxRate()
      ]);
      if (generation !== generationRef.current) return;

      if (isPercentage(discountPercentage) && isPercentage(taxRate)) {
        setMaxDiscountPercentage(discountPercentage);
        setTaxRatePercentage(taxRate);
        setUnavailable(false);
      } else {
        console.warn('Invalid discount cap or tax rate received: checkout is paused', {
          discountPercentage,
          taxRate,
        });
        setError('Invalid discount cap or tax rate');
        setUnavailable(true);
      }
    } catch (err) {
      if (generation !== generationRef.current) return;
      const errorMessage = err instanceof Error ? err.message : 'Failed to fetch settings';
      console.error('Error fetching settings:', err);
      setError(errorMessage);
      setUnavailable(true);
    } finally {
      if (generation === generationRef.current) setIsLoading(false);
    }
  }, [bridge]);

  // Fetch settings on mount
  useEffect(() => {
    void fetchSettings();
  }, [fetchSettings]);

  const refreshSettings = useCallback(async () => {
    await fetchSettings();
  }, [fetchSettings]);

  return {
    maxDiscountPercentage,
    taxRatePercentage,
    isLoading,
    error,
    unavailable,
    refreshSettings
  };
}
