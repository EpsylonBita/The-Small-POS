// Main components
export { default as RefactoredMainLayout } from './RefactoredMainLayout';
export { default as OrderDashboard } from './OrderDashboard';

// Business Category Dashboards (Food/Service/Product)
export {
  FoodDashboard,
  ServiceDashboard,
  ProductDashboard,
  BusinessCategoryDashboard,
} from './dashboards';

// Dashboard components
export { DashboardCard } from './DashboardCard';
export type { DashboardCardProps, DashboardCardColor } from './DashboardCard';
export { default as OrderGrid } from './OrderGrid';
export { default as BulkActionsBar } from './BulkActionsBar';
export { default as NavigationSidebar } from './NavigationSidebar';
export { default as OrderTabsBar } from './OrderTabsBar';
export { ThemeSwitcher } from './ThemeSwitcher';
export { default as CustomTitleBar } from './CustomTitleBar';
export { FloatingActionButton } from './ui/FloatingActionButton';

// Order components
export { default as OrderCard } from './order/OrderCard';
export { OrderActions } from './order/OrderActions';

// Form components
export { OrderTypeSelector } from './forms/OrderTypeSelector';
export { CustomerDetailsForm } from './forms/CustomerDetailsForm';

// UI components
export { default as ContentContainer } from './ui/ContentContainer';

// Modal components
export { CustomerSearchModal } from './modals/CustomerSearchModal';
export { CustomerInfoModal } from './modals/CustomerInfoModal';
export { AddCustomerModal } from './modals/AddCustomerModal';
export { AddNewAddressModal } from './modals/AddNewAddressModal';
export { PaymentModal } from './modals/PaymentModal';
export { default as DriverAssignmentModal } from './modals/DriverAssignmentModal';
export { default as OrderCancellationModal } from './modals/OrderCancellationModal';
export { EditCustomerInfoModal } from './modals/EditCustomerInfoModal';
export { default as EditAddressModal } from './modals/EditAddressModal';
export { default as EditOptionsModal } from './modals/EditOptionsModal';
export { default as EditPaymentMethodModal } from './modals/EditPaymentMethodModal';
export { default as EditOrderItemsModal } from './modals/EditOrderItemsModal';

// Order flow
export { default as OrderFlow } from './OrderFlow';

// Utility Components
export { OrderModals } from './OrderModals';

// Update components
export { UpdateDialog } from './UpdateDialog';
export type { UpdateDialogProps, UpdateStatus } from './UpdateDialog';

// POS Glassmorphism UI Components
export {
  POSGlassCard,
  POSGlassButton,
  POSGlassInput,
  POSGlassPINInput,
  POSGlassModal,
  LiquidGlassModal,
  POSGlassContainer,
  POSGlassToggle,
  POSGlassBadge,
  POSGlassNumberInput
} from './ui/pos-glass-components';

// New modular menu components
export { MenuModal } from './modals/MenuModal';
export { MenuCategoryTabs } from './menu/MenuCategoryTabs';
export { MenuItemGrid } from './menu/MenuItemGrid';
export { MenuItemCard } from './menu/MenuItemCard';
export { MenuCart } from './menu/MenuCart';
export { MenuItemModal } from './menu/MenuItemModal';
export { AddressSelectionCard } from './forms/AddressSelectionCard';
