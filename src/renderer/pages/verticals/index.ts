// Vertical-specific view components barrel export
// Compatibility exports. Lazy routes should import each view directly so that
// opening one vertical does not load all other verticals.

// Fast-food vertical
export { DriveThruView } from './fast-food/DriveThruView';
export { DeliveryView } from './fast-food/DeliveryView';

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
