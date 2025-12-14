/**
 * Services barrel export
 * 
 * Centralized export point for all renderer services.
 * Allows clean imports: import { customerService, menuService } from '@/services'
 */

export { customerService } from './CustomerService';
export { menuService } from './MenuService';

// Reservations (Restaurant Vertical)
export { reservationsService } from './ReservationsService';
export type {
  Reservation,
  ReservationStatus,
  ReservationFilters,
  ReservationStats,
  CreateReservationDto,
} from './ReservationsService';

// Rooms (Hotel Vertical)
export { roomsService } from './RoomsService';
export type {
  Room,
  RoomStatus,
  RoomType,
  RoomFilters,
  RoomStats,
} from './RoomsService';

// Appointments (Salon Vertical)
export { appointmentsService } from './AppointmentsService';
export type {
  Appointment,
  AppointmentStatus,
  AppointmentFilters,
  AppointmentStats,
} from './AppointmentsService';

// Drive-Through (Fast-food Vertical)
export { driveThruService } from './DriveThruService';
export type {
  DriveThruLane,
  DriveThruOrder,
  DriveThruOrderStatus,
  DriveThruStats,
} from './DriveThruService';

// Product Catalog (Retail Vertical)
export { productCatalogService } from './ProductCatalogService';
export type {
  Product,
  ProductCategory,
  ProductFilters,
  ProductStats,
} from './ProductCatalogService';

// Services (Salon Vertical)
export { servicesService } from './ServicesService';
export type {
  Service,
  ServiceCategory,
  ServiceFilters,
  ServiceStats,
} from './ServicesService';
