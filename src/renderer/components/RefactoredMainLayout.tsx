import React, { memo, useEffect, useRef, lazy, Suspense, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { BusinessCategoryDashboard } from './dashboards';
import { NavigationProvider } from '../contexts/navigation-context';
import NavigationSidebar from './NavigationSidebar';
import { ThemeSwitcher } from './ThemeSwitcher';
import ContentContainer from './ui/ContentContainer';
import { useTheme } from '../contexts/theme-context';
import { useShift } from '../contexts/shift-context';
import { useModules, useModuleAccess, getModuleAccessStatic } from '../contexts/module-context';
import ZReportModal from './modals/ZReportModal';
import ConnectionSettingsModal from './modals/ConnectionSettingsModal';
import UpgradePromptModal from './modals/UpgradePromptModal';
import { ShiftManager, ShiftManagerRef } from './ShiftManager';
import MenuManagementPage from '../pages/MenuManagementPage';
import UsersPage from '../pages/UsersPage';
import ReportsPage from '../pages/ReportsPage';
import AnalyticsPage from '../pages/AnalyticsPage';
import OrdersPage from '../pages/OrdersPage';
import DeliveryZonesPage from '../pages/DeliveryZonesPage';
import CouponsPage from '../pages/CouponsPage';
import LoyaltyPage from '../pages/LoyaltyPage';
import SuppliersPage from '../pages/SuppliersPage';
import InventoryPage from '../pages/InventoryPage';
import KitchenDisplayPage from '../pages/KitchenDisplayPage';
import KioskManagementPage from '../pages/KioskManagementPage';
import IntegrationsPage from '../pages/IntegrationsPage';

import { ExpenseModal } from './modals/ExpenseModal';

// Lazy-loaded vertical views
const DriveThruView = lazy(() => import('../pages/verticals').then(m => ({ default: m.DriveThruView })));
const DeliveryView = lazy(() => import('../pages/verticals').then(m => ({ default: m.DeliveryView })));
const TablesView = lazy(() => import('../pages/verticals').then(m => ({ default: m.TablesView })));
const ReservationsView = lazy(() => import('../pages/verticals').then(m => ({ default: m.ReservationsView })));
const RoomsView = lazy(() => import('../pages/verticals').then(m => ({ default: m.RoomsView })));
const HousekeepingView = lazy(() => import('../pages/verticals').then(m => ({ default: m.HousekeepingView })));
const GuestBillingView = lazy(() => import('../pages/verticals').then(m => ({ default: m.GuestBillingView })));
const AppointmentsView = lazy(() => import('../pages/verticals').then(m => ({ default: m.AppointmentsView })));
const StaffScheduleView = lazy(() => import('../pages/verticals').then(m => ({ default: m.StaffScheduleView })));
const ServiceCatalogView = lazy(() => import('../pages/verticals').then(m => ({ default: m.ServiceCatalogView })));
const ProductCatalogView = lazy(() => import('../pages/verticals').then(m => ({ default: m.ProductCatalogView })));

// View components
// DashboardView now uses BusinessCategoryDashboard which automatically selects
// the appropriate layout (Food/Service/Product) based on business type
const DashboardView = () => {
  return <BusinessCategoryDashboard />;
};

// Menu view uses the MenuManagementPage component
const MenuView = () => {
  return <MenuManagementPage />;
};

const ReportsView = () => {
  return <ReportsPage />;
};

// Users view uses the UsersPage component
const CustomersView = () => {
  return <UsersPage />;
};

// Placeholder component for modules that don't have views yet
const ComingSoonView: React.FC<{ moduleName?: string }> = ({ moduleName = 'This feature' }) => {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col items-center justify-center h-full p-8">
      <div className="text-6xl mb-4">🚧</div>
      <h2 className="text-2xl font-bold mb-2">{t('common.comingSoon', { defaultValue: 'Coming Soon' })}</h2>
      <p className="text-gray-500 text-center max-w-md">
        {t('common.featureNotReady', {
          feature: moduleName,
          defaultValue: `${moduleName} is not yet available. This feature will be added in a future update.`
        })}
      </p>
    </div>
  );
};

// View for modules that are enabled in admin but not implemented in this POS version
// This is shown when a module ID doesn't have a corresponding VIEW_COMPONENT
const ModuleNotAvailableView: React.FC<{ moduleId: string }> = ({ moduleId }) => {
  const { t } = useTranslation();
  const { resolvedTheme } = useTheme();
  const isDark = resolvedTheme === 'dark';

  return (
    <div className="flex flex-col items-center justify-center h-full p-8">
      <div className="text-6xl mb-4">📦</div>
      <h2 className={`text-2xl font-bold mb-2 ${isDark ? 'text-white' : 'text-gray-900'}`}>
        {t('common.moduleNotAvailable', { defaultValue: 'Module Not Available' })}
      </h2>
      <p className={`text-center max-w-md mb-4 ${isDark ? 'text-gray-400' : 'text-gray-600'}`}>
        {t('common.moduleNotImplemented', {
          moduleId,
          defaultValue: `The "${moduleId}" module is enabled but not yet implemented in this POS version.`
        })}
      </p>
      <p className={`text-sm text-center max-w-md ${isDark ? 'text-gray-500' : 'text-gray-500'}`}>
        {t('common.updatePOSHint', {
          defaultValue: 'Please update your POS software to access this module, or contact support if you believe this is an error.'
        })}
      </p>
    </div>
  );
};

// Loading spinner for lazy-loaded views
const ViewLoadingSpinner: React.FC = () => {
  const { t } = useTranslation();
  const { resolvedTheme } = useTheme();
  const isDark = resolvedTheme === 'dark';

  return (
    <div className="flex flex-col items-center justify-center h-full p-8">
      <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600 mb-4"></div>
      <p className={isDark ? 'text-gray-400' : 'text-gray-600'}>
        {t('common.messages.loadingView', { defaultValue: 'Loading view...' })}
      </p>
    </div>
  );
};

// Implemented views using page components
const OrdersView = () => <OrdersPage />;
const DeliveryZonesView = () => <DeliveryZonesPage />;
const AnalyticsView = () => <AnalyticsPage />;
const CouponsView = () => <CouponsPage />;
const LoyaltyView = () => <LoyaltyPage />;
const SuppliersView = () => <SuppliersPage />;
const InventoryView = () => <InventoryPage />;
const KitchenDisplayView = () => <KitchenDisplayPage />;

// Placeholder views for modules not yet implemented
const BranchesView = () => <ComingSoonView moduleName="Branches" />;
const CustomerWebView = () => <ComingSoonView moduleName="Web Ordering" />;
const CustomerAppView = () => <ComingSoonView moduleName="Mobile App" />;

interface RefactoredMainLayoutProps {
  className?: string;
  onLogout?: () => void;
}

export const RefactoredMainLayout = memo<RefactoredMainLayoutProps>(({ className = '', onLogout }) => {
  const { t } = useTranslation();
  const { resolvedTheme } = useTheme();
  const { enabledModules, lockedModules } = useModules();
  const [currentView, setCurrentView] = React.useState<string>('dashboard');
  const [showZReport, setShowZReport] = React.useState(false);
  const [showConnectionSettings, setShowConnectionSettings] = React.useState(false);
  const { staff, isShiftActive } = useShift();

  const [showExpenses, setShowExpenses] = React.useState(false);

  // Route guard state for upgrade modal
  const [showUpgradePrompt, setShowUpgradePrompt] = useState(false);
  const [blockedModule, setBlockedModule] = useState<{ moduleId: string; requiredPlan: string } | null>(null);

  const shiftManagerRef = useRef<ShiftManagerRef>(null);

  // Use useModuleAccess hook for checking current view access
  // This provides centralized access checking for the current view
  const currentViewAccess = useModuleAccess(currentView as any);

  // Route guard useEffect: Redirect to dashboard if currentView is a locked module
  // This catches cases where currentView is set externally (persisted state, deep-links, programmatic changes)
  useEffect(() => {
    if (currentViewAccess.isLocked && currentViewAccess.requiredPlan && currentView !== 'dashboard') {
      console.warn('🔒 Route guard useEffect: Redirecting from locked module:', currentView);
      setCurrentView('dashboard');
      setBlockedModule({ moduleId: currentView, requiredPlan: currentViewAccess.requiredPlan });
      setShowUpgradePrompt(true);
    }
  }, [currentView, currentViewAccess.isLocked, currentViewAccess.requiredPlan]);

  // Initialize orders on mount - temporarily disabled
  // useEffect(() => {
  //   initializeOrders();
  // }, [initializeOrders]);

  // Handle navigation
  // Route guard: Prevent access to locked modules
  // Users can see locked modules in navigation but cannot access them
  // Attempting to access shows upgrade prompt and redirects to dashboard
  const handleViewChange = (view: string) => {
    console.log('🔄 View change requested:', view);

    // Check if the requested view is a locked module using centralized utility
    const access = getModuleAccessStatic(enabledModules, lockedModules, view);
    if (access.isLocked && access.requiredPlan) {
      console.warn('🔒 Access denied to locked module:', view);
      setBlockedModule({ moduleId: view, requiredPlan: access.requiredPlan });
      setShowUpgradePrompt(true);
      return; // Don't change view
    }

    setCurrentView(view);
    console.log('✅ View state updated to:', view);
  };

  // Handle logout
  const handleLogout = () => {
    if (onLogout) {
      onLogout();
    } else {
      localStorage.removeItem("pos-user");
      window.location.reload();
    }
  };

  // Handle end shift
  const handleEndShift = () => {
    shiftManagerRef.current?.openCheckout();
  };

  // Handle start shift (check-in)
  const handleStartShift = () => {
    shiftManagerRef.current?.openCheckin();
  };

  // View component mapping - maps module IDs to their view components
  // Lazy-loaded vertical views are wrapped in Suspense for code splitting
  const VIEW_COMPONENTS: Record<string, React.ComponentType> = {
    // Core modules (not lazy-loaded as they're frequently used)
    dashboard: DashboardView,
    orders: OrdersView,
    menu: MenuView,
    users: CustomersView,
    customers: CustomersView, // alias for users/staff management
    branches: BranchesView,
    // settings is handled via modal, not a view

    // Restaurant vertical (lazy-loaded)
    tables: TablesView,
    reservations: ReservationsView,

    // Hotel vertical (lazy-loaded)
    rooms: RoomsView,
    housekeeping: HousekeepingView,
    guest_billing: GuestBillingView,

    // Salon vertical (lazy-loaded)
    appointments: AppointmentsView,
    staff_schedule: StaffScheduleView,
    service_catalog: ServiceCatalogView,

    // Fast-food vertical (lazy-loaded)
    drive_through: DriveThruView,
    delivery: DeliveryView,
    kiosk: () => <KioskManagementPage />, // Kiosk management for staff
    delivery_zones: DeliveryZonesView,

    // Retail vertical (lazy-loaded)
    product_catalog: ProductCatalogView,

    // Analytics & reporting
    analytics: AnalyticsView,
    reports: ReportsView,

    // Marketing & Loyalty
    coupons: CouponsView,
    loyalty: LoyaltyView,

    // Operations & Back-office
    suppliers: SuppliersView,
    inventory: InventoryView,
    kitchen_display: KitchenDisplayView,

    // Customer-facing modules
    customer_web: CustomerWebView,
    customer_app: CustomerAppView,

    // Integrations
    plugin_integrations: () => <IntegrationsPage />,
    integrations: () => <IntegrationsPage />, // alias
  };

  // Render current view based on navigation selection
  // Wrapped in Suspense for lazy-loaded vertical views
  // Route-level guard is handled by the useEffect above - no state updates here
  const renderCurrentView = () => {
    console.log('🎯 Rendering view for currentView:', currentView);

    // Note: Route guard logic has been moved to useEffect to avoid state updates during render.
    // The useEffect observes currentView and currentViewAccess to handle locked module redirects.
    // This function now only handles view component selection and Suspense wrapping.

    const ViewComponent = VIEW_COMPONENTS[currentView];

    // If the view component doesn't exist for this module ID, show ModuleNotAvailableView
    // This handles cases where a module is enabled in admin but not yet implemented in this POS version
    if (!ViewComponent) {
      console.warn(`[Navigation] Unknown module "${currentView}" - showing ModuleNotAvailableView`);
      return (
        <Suspense fallback={<ViewLoadingSpinner />}>
          <ModuleNotAvailableView moduleId={currentView} />
        </Suspense>
      );
    }

    return (
      <Suspense fallback={<ViewLoadingSpinner />}>
        <ViewComponent />
      </Suspense>
    );
  };

  return (
    <NavigationProvider currentView={currentView} onViewChange={handleViewChange}>
      <div className={`flex h-screen h-[100dvh] transition-all duration-300 overflow-hidden safe-area-all ${resolvedTheme === 'light'
          ? 'bg-gray-50'
          : 'bg-black'
        } ${className}`}>
        {/* Navigation Sidebar */}
        <NavigationSidebar
          currentView={currentView}
          onViewChange={handleViewChange}
          onLogout={handleLogout}
          onEndShift={handleEndShift}
          onStartShift={handleStartShift}
          onOpenZReport={() => setShowZReport(true)}
          isZReportOpen={showZReport}
          onOpenSettings={() => {
            try {
              const electron = (window as any).electronAPI
              electron?.refreshTerminalSettings?.()
            } catch { }
            setShowConnectionSettings(true)
          }}
        />

        {/* Main Content Area with Container */}
        <div className="flex-1 flex flex-col overflow-hidden min-h-0 ml-16 sm:ml-20">
          <ContentContainer className="flex-1 min-h-0 overflow-auto relative touch-scroll">
            <div className="h-full min-h-[400px] sm:min-h-[500px] md:min-h-[600px]">
              {renderCurrentView()}
            </div>

          {/* Shift required overlay when no active shift */}
          {!isShiftActive && (
            <div className="absolute inset-0 z-40 flex items-center justify-center p-4" onClick={handleStartShift}>
              <div
                role="alert"
                aria-live="assertive"
                onClick={(e) => e.stopPropagation()}
                className={`max-w-md w-full rounded-2xl border ${resolvedTheme === 'dark' ? 'bg-gray-800/95 border-red-500/40 text-white' : 'bg-white/95 border-red-500/30 text-gray-900'} shadow-2xl`}
              >
                <div className="p-6">
                  <div className="flex items-start gap-3">
                    <div className="h-8 w-8 rounded-full bg-red-500/15 text-red-600 flex items-center justify-center font-bold">!</div>
                    <div className="flex-1">
                      <h3 className="text-lg font-semibold">{t('shift.noActiveShift')}</h3>
                      <p className="mt-1 text-sm opacity-80">{t('shift.messages.shiftRequired')}</p>
                    </div>
                  </div>
                  <div className="mt-4 flex justify-end">
                    <button
                      onClick={handleStartShift}
                      className="px-4 py-2 rounded-lg bg-red-600 text-white hover:bg-red-700 transition"
                    >
                      {t('navigation.checkIn')}
                    </button>
                  </div>
                </div>
              </div>
            </div>
          )}

        </ContentContainer>
      </div>

      {/* Top-right Expenses Button */}
      {isShiftActive && (
        <button
          onClick={() => setShowExpenses(true)}
          className="fixed top-16 right-6 z-50 px-4 py-2.5 rounded-xl backdrop-blur-xl bg-white/10 border border-green-500/30 text-green-400 font-semibold shadow-[0_8px_32px_0_rgba(34,197,94,0.3)] hover:bg-white/20 hover:border-green-400/50 hover:shadow-[0_8px_32px_0_rgba(34,197,94,0.5)] hover:scale-105 active:scale-95 transition-all duration-300"
          title={t('expense.buttonLabel')}
        >
          {t('expense.buttonLabel')}
        </button>
      )}

      {/* Expenses Modal */}
      <ExpenseModal isOpen={showExpenses} onClose={() => setShowExpenses(false)} />
      {/* Z Report Modal */}
      <ZReportModal isOpen={showZReport} onClose={() => setShowZReport(false)} branchId={staff?.branchId || ''} />
      {/* Connection Settings Modal */}
      <ConnectionSettingsModal isOpen={showConnectionSettings} onClose={() => setShowConnectionSettings(false)} />


      {/* Shift Manager - Auto-prompts check-in and handles checkout */}
      <ShiftManager ref={shiftManagerRef} />

      {/* Upgrade Prompt Modal - Route guard for locked modules */}
      <UpgradePromptModal
        isOpen={showUpgradePrompt}
        onClose={() => setShowUpgradePrompt(false)}
        moduleId={blockedModule?.moduleId}
        requiredPlan={blockedModule?.requiredPlan}
      />

        {/* Order Flow - Temporarily disabled to fix navigation */}
        {/* <OrderFlow /> */}
      </div>
    </NavigationProvider>
  );
});

RefactoredMainLayout.displayName = 'RefactoredMainLayout';

export default RefactoredMainLayout;