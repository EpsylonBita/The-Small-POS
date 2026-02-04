'use client';

import React, { createContext, useContext, useCallback, ReactNode } from 'react';

/**
 * Navigation Context
 *
 * Provides a centralized navigation function for the POS application.
 * This allows dashboard cards and other components to navigate to different views
 * without using hash-based routing (which doesn't work in this Electron app).
 *
 * The navigation function includes route guard logic to prevent access to locked modules.
 */

interface NavigationContextType {
  /** Navigate to a specific view by module ID */
  navigateTo: (viewId: string) => void;
  /** Current active view */
  currentView: string;
}

const NavigationContext = createContext<NavigationContextType | undefined>(undefined);

interface NavigationProviderProps {
  children: ReactNode;
  /** Current view state from RefactoredMainLayout */
  currentView: string;
  /** View change handler from RefactoredMainLayout (includes route guard logic) */
  onViewChange: (viewId: string) => void;
}

/**
 * Navigation Provider
 *
 * Wraps the application and provides navigation functionality to all child components.
 * The actual state management and route guarding is handled by RefactoredMainLayout.
 */
export const NavigationProvider: React.FC<NavigationProviderProps> = ({
  children,
  currentView,
  onViewChange,
}) => {
  const navigateTo = useCallback(
    (viewId: string) => {
      console.log('[NavigationContext] Navigating to:', viewId);
      onViewChange(viewId);
    },
    [onViewChange]
  );

  return (
    <NavigationContext.Provider value={{ navigateTo, currentView }}>
      {children}
    </NavigationContext.Provider>
  );
};

/**
 * Hook to access navigation functionality
 *
 * @returns NavigationContextType with navigateTo function and currentView
 * @throws Error if used outside of NavigationProvider
 */
export const useNavigation = (): NavigationContextType => {
  const context = useContext(NavigationContext);
  if (context === undefined) {
    throw new Error('useNavigation must be used within a NavigationProvider');
  }
  return context;
};

/**
 * Hook to safely check if navigation is available
 * Returns null if outside NavigationProvider (useful for standalone testing)
 */
export const useNavigationSafe = (): NavigationContextType | null => {
  return useContext(NavigationContext) ?? null;
};

export default NavigationProvider;
