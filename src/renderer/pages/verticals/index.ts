// Vertical-specific view components barrel export
// This file allows lazy-loading all vertical views from a single entry point

// Fast-food vertical
export { QuickPOSView } from './fast-food/QuickPOSView';
export { DriveThruView } from './fast-food/DriveThruView';

// Restaurant vertical
export { TablesView } from './restaurant/TablesView';
export { ReservationsView } from './restaurant/ReservationsView';

// Hotel vertical
export { RoomsView } from './hotel/RoomsView';
export { HousekeepingView } from './hotel/HousekeepingView';
export { GuestBillingView } from './hotel/GuestBillingView';

// Salon vertical
export { AppointmentsView } from './salon/AppointmentsView';
export { StaffScheduleView } from './salon/StaffScheduleView';
export { ServiceCatalogView } from './salon/ServiceCatalogView';

// Retail vertical
export { ProductCatalogView } from './retail/ProductCatalogView';
