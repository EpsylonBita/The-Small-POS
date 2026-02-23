# POS Tauri Parity Checklist

> Comprehensive feature parity tracker for migrating from Electron POS (`pos-system/`) to Tauri POS (`pos-tauri/`).
> Generated: 2026-02-14 | Source: Electron POS v1.1.66

**Legend:**
- `[ ]` Not started
- `[~]` In progress
- `[x]` Complete
- `[S]` Skipped (not applicable to Tauri)
- `Electron Path` = source file in `pos-system/src/`
- `Tauri Path` = target file in `pos-tauri/src/`

## Contract Gate Status (2026-02-16)

- `npm run parity:contract` => **passed**
- Mapped invoke channels: `243/243` resolvable
- Renderer channels used but unmapped: `0`
- Renderer channels used but missing Rust registration: `0`
- Mapped bridge events missing Rust emit points: `0`

---

## 1. Screen Inventory

### 1.1 Top-Level Screens

| # | Screen | Electron Path | Tauri Path | Status |
|---|--------|---------------|------------|--------|
| 1 | App Shell (root layout) | `renderer/App.tsx` | `renderer/App.tsx` | `[~]` backend done |
| 2 | ConfigGuard (boot gate) | `renderer/App.tsx:54-277` | `renderer/App.tsx:54-277` | `[~]` backend done |
| 3 | Onboarding (terminal setup) | `renderer/pages/OnboardingPage.tsx` | `renderer/pages/OnboardingPage.tsx` | `[~]` backend done |
| 4 | Login (PIN entry) | `renderer/pages/LoginPage.tsx` | `renderer/pages/LoginPage.tsx` | `[~]` backend done |
| 5 | Main Layout (post-login shell) | `renderer/components/RefactoredMainLayout.tsx` | `renderer/components/RefactoredMainLayout.tsx` | `[~]` backend done |
| 6 | New Order Page | `renderer/pages/NewOrderPage.tsx` | `renderer/pages/NewOrderPage.tsx` | `[~]` backend done |

### 1.2 Navigation Views (state-driven inside RefactoredMainLayout)

| # | View ID | Screen | Electron Path | Tauri Path | Status |
|---|---------|--------|---------------|------------|--------|
| 7 | `dashboard` | Business Dashboard | `renderer/components/dashboards/BusinessCategoryDashboard.tsx` | `renderer/components/dashboards/BusinessCategoryDashboard.tsx` | `[~]` |
| 8 | (food) | Food Dashboard | `renderer/components/dashboards/FoodDashboard.tsx` | `renderer/components/dashboards/FoodDashboard.tsx` | `[~]` |
| 9 | (service) | Service Dashboard | `renderer/components/dashboards/ServiceDashboard.tsx` | `renderer/components/dashboards/ServiceDashboard.tsx` | `[~]` |
| 10 | (product) | Product Dashboard | `renderer/components/dashboards/ProductDashboard.tsx` | `renderer/components/dashboards/ProductDashboard.tsx` | `[~]` |
| 11 | `orders` | Orders | `renderer/pages/OrdersPage.tsx` | `renderer/pages/OrdersPage.tsx` | `[~]` backend done |
| 12 | `menu` | Menu Management | `renderer/pages/MenuManagementPage.tsx` | `renderer/pages/MenuManagementPage.tsx` | `[~]` backend done |
| 13 | `users` | Users / Staff | `renderer/pages/UsersPage.tsx` | `renderer/pages/UsersPage.tsx` | `[~]` |
| 14 | `reports` | Reports | `renderer/pages/ReportsPage.tsx` | `renderer/pages/ReportsPage.tsx` | `[~]` |
| 15 | `analytics` | Analytics | `renderer/pages/AnalyticsPage.tsx` | `renderer/pages/AnalyticsPage.tsx` | `[~]` |

#### Fast-Food Vertical

| # | View ID | Screen | Electron Path | Tauri Path | Status |
|---|---------|--------|---------------|------------|--------|
| 16 | `drive_through` | Drive-Thru Queue | `renderer/pages/verticals/fast-food/DriveThruView.tsx` | `renderer/pages/verticals/fast-food/DriveThruView.tsx` | `[~]` |
| 17 | `delivery` | Delivery Management | `renderer/pages/verticals/fast-food/DeliveryView.tsx` | `renderer/pages/verticals/fast-food/DeliveryView.tsx` | `[~]` |
| 18 | `delivery_zones` | Delivery Zones | `renderer/pages/DeliveryZonesPage.tsx` | `renderer/pages/DeliveryZonesPage.tsx` | `[~]` |
| 19 | `kiosk` | Kiosk Management | `renderer/pages/KioskManagementPage.tsx` | `renderer/pages/KioskManagementPage.tsx` | `[~]` |
| 20 | `kitchen_display` | Kitchen Display | `renderer/pages/KitchenDisplayPage.tsx` | `renderer/pages/KitchenDisplayPage.tsx` | `[~]` |

#### Restaurant Vertical

| # | View ID | Screen | Electron Path | Tauri Path | Status |
|---|---------|--------|---------------|------------|--------|
| 21 | `tables` | Table Management | `renderer/pages/verticals/restaurant/TablesView.tsx` | `renderer/pages/verticals/restaurant/TablesView.tsx` | `[~]` |
| 22 | `reservations` | Reservations | `renderer/pages/verticals/restaurant/ReservationsView.tsx` | `renderer/pages/verticals/restaurant/ReservationsView.tsx` | `[~]` |

#### Hotel Vertical

| # | View ID | Screen | Electron Path | Tauri Path | Status |
|---|---------|--------|---------------|------------|--------|
| 23 | `rooms` | Room Management | `renderer/pages/verticals/hotel/RoomsView.tsx` | `renderer/pages/verticals/hotel/RoomsView.tsx` | `[~]` |
| 24 | `housekeeping` | Housekeeping | `renderer/pages/verticals/hotel/HousekeepingView.tsx` | `renderer/pages/verticals/hotel/HousekeepingView.tsx` | `[~]` |
| 25 | `guest_billing` | Guest Billing | `renderer/pages/verticals/hotel/GuestBillingView.tsx` | `renderer/pages/verticals/hotel/GuestBillingView.tsx` | `[~]` |

#### Salon Vertical

| # | View ID | Screen | Electron Path | Tauri Path | Status |
|---|---------|--------|---------------|------------|--------|
| 26 | `appointments` | Appointments | `renderer/pages/verticals/salon/AppointmentsView.tsx` | `renderer/pages/verticals/salon/AppointmentsView.tsx` | `[~]` |
| 27 | `staff_schedule` | Staff Schedule | `renderer/pages/verticals/salon/StaffScheduleView.tsx` | `renderer/pages/verticals/salon/StaffScheduleView.tsx` | `[~]` |
| 28 | `service_catalog` | Service Catalog | `renderer/pages/verticals/salon/ServiceCatalogView.tsx` | `renderer/pages/verticals/salon/ServiceCatalogView.tsx` | `[~]` |

#### Retail Vertical

| # | View ID | Screen | Electron Path | Tauri Path | Status |
|---|---------|--------|---------------|------------|--------|
| 29 | `product_catalog` | Product Catalog | `renderer/pages/verticals/retail/ProductCatalogView.tsx` | `renderer/pages/verticals/retail/ProductCatalogView.tsx` | `[~]` |

#### Cross-Vertical

| # | View ID | Screen | Electron Path | Tauri Path | Status |
|---|---------|--------|---------------|------------|--------|
| 30 | `coupons` | Coupons | `renderer/pages/CouponsPage.tsx` | `renderer/pages/CouponsPage.tsx` | `[~]` |
| 31 | `loyalty` | Loyalty Program | `renderer/pages/LoyaltyPage.tsx` | `renderer/pages/LoyaltyPage.tsx` | `[~]` |
| 32 | `suppliers` | Suppliers | `renderer/pages/SuppliersPage.tsx` | `renderer/pages/SuppliersPage.tsx` | `[~]` |
| 33 | `inventory` | Inventory | `renderer/pages/InventoryPage.tsx` | `renderer/pages/InventoryPage.tsx` | `[~]` |
| 34 | `plugin_integrations` | Integrations | `renderer/pages/IntegrationsPage.tsx` | `renderer/pages/IntegrationsPage.tsx` | `[~]` |

### 1.3 Modals

| # | Modal | Electron Path | Tauri Path | Status |
|---|-------|---------------|------------|--------|
| 35 | Z-Report | `renderer/components/modals/ZReportModal.tsx` | `renderer/components/modals/ZReportModal.tsx` | `[~]` |
| 36 | Connection Settings | `renderer/components/modals/ConnectionSettingsModal.tsx` | `renderer/components/modals/ConnectionSettingsModal.tsx` | `[~]` |
| 37 | Upgrade Prompt | `renderer/components/modals/UpgradePromptModal.tsx` | `renderer/components/modals/UpgradePromptModal.tsx` | `[~]` |
| 38 | Expense Recording | `renderer/components/modals/ExpenseModal.tsx` | `renderer/components/modals/ExpenseModal.tsx` | `[~]` |
| 39 | Payment | `renderer/components/modals/PaymentModal.tsx` | `renderer/components/modals/PaymentModal.tsx` | `[~]` |
| 40 | Order Details | `renderer/components/modals/OrderDetailsModal.tsx` | `renderer/components/modals/OrderDetailsModal.tsx` | `[~]` |
| 41 | Menu Item | `renderer/components/modals/MenuModal.tsx` | `renderer/components/modals/MenuModal.tsx` | `[~]` |
| 42 | Printer Settings | `renderer/components/modals/PrinterSettingsModal.tsx` | `renderer/components/modals/PrinterSettingsModal.tsx` | `[~]` |
| 43 | Customer Search | `renderer/components/modals/CustomerSearchModal.tsx` | `renderer/components/modals/CustomerSearchModal.tsx` | `[~]` |
| 44 | Add Customer | `renderer/components/modals/AddCustomerModal.tsx` | `renderer/components/modals/AddCustomerModal.tsx` | `[~]` |
| 45 | Customer Info | `renderer/components/modals/CustomerInfoModal.tsx` | `renderer/components/modals/CustomerInfoModal.tsx` | `[~]` |
| 46 | Customer Order History | `renderer/components/modals/CustomerOrderHistoryModal.tsx` | `renderer/components/modals/CustomerOrderHistoryModal.tsx` | `[~]` |
| 47 | Edit Customer Info | `renderer/components/modals/EditCustomerInfoModal.tsx` | `renderer/components/modals/EditCustomerInfoModal.tsx` | `[~]` |
| 48 | Add Address | `renderer/components/modals/AddNewAddressModal.tsx` | `renderer/components/modals/AddNewAddressModal.tsx` | `[~]` |
| 49 | Edit Address | `renderer/components/modals/EditAddressModal.tsx` | `renderer/components/modals/EditAddressModal.tsx` | `[~]` |
| 50 | Driver Assignment | `renderer/components/modals/DriverAssignmentModal.tsx` | `renderer/components/modals/DriverAssignmentModal.tsx` | `[~]` |
| 51 | Staff/Shift Check-in | `renderer/components/modals/StaffShiftModal.tsx` | `renderer/components/modals/StaffShiftModal.tsx` | `[~]` |
| 52 | Edit Order Items | `renderer/components/modals/EditOrderItemsModal.tsx` | `renderer/components/modals/EditOrderItemsModal.tsx` | `[~]` |
| 53 | Edit Options | `renderer/components/modals/EditOptionsModal.tsx` | `renderer/components/modals/EditOptionsModal.tsx` | `[~]` |
| 54 | Order Cancellation | `renderer/components/modals/OrderCancellationModal.tsx` | `renderer/components/modals/OrderCancellationModal.tsx` | `[~]` |
| 55 | Print Preview | `renderer/components/modals/PrintPreviewModal.tsx` | `renderer/components/modals/PrintPreviewModal.tsx` | `[~]` |
| 56 | Product Catalog | `renderer/components/modals/ProductCatalogModal.tsx` | `renderer/components/modals/ProductCatalogModal.tsx` | `[~]` |

### 1.4 Shared UI Components

| # | Component | Electron Path | Tauri Path | Status |
|---|-----------|---------------|------------|--------|
| 57 | Navigation Sidebar | `renderer/components/NavigationSidebar.tsx` | `renderer/components/NavigationSidebar.tsx` | `[~]` |
| 58 | Custom Title Bar | `renderer/components/CustomTitleBar.tsx` | `renderer/components/CustomTitleBar.tsx` | `[~]` |
| 59 | Fullscreen-Aware Layout | `renderer/components/FullscreenAwareLayout.tsx` | `renderer/components/FullscreenAwareLayout.tsx` | `[~]` |
| 60 | Animated Background | `renderer/components/AnimatedBackground.tsx` | `renderer/components/AnimatedBackground.tsx` | `[~]` |
| 61 | Theme Toggle | `renderer/components/ThemeToggle.tsx` | `renderer/components/ThemeToggle.tsx` | `[~]` |
| 62 | Theme Switcher | `renderer/components/ThemeSwitcher.tsx` | `renderer/components/ThemeSwitcher.tsx` | `[~]` |
| 63 | Sync Status Indicator | `renderer/components/SyncStatusIndicator.tsx` | `renderer/components/SyncStatusIndicator.tsx` | `[~]` |
| 64 | Sync Notification Manager | `renderer/components/SyncNotificationManager.tsx` | `renderer/components/SyncNotificationManager.tsx` | `[~]` |
| 65 | Shift Manager | `renderer/components/ShiftManager.tsx` | `renderer/components/ShiftManager.tsx` | `[~]` |
| 66 | Order Dashboard | `renderer/components/OrderDashboard.tsx` | `renderer/components/OrderDashboard.tsx` | `[~]` |
| 67 | Order Flow | `renderer/components/OrderFlow.tsx` | `renderer/components/OrderFlow.tsx` | `[~]` |
| 68 | Order Grid | `renderer/components/OrderGrid.tsx` | `renderer/components/OrderGrid.tsx` | `[~]` |
| 69 | Order Tabs Bar | `renderer/components/OrderTabsBar.tsx` | `renderer/components/OrderTabsBar.tsx` | `[~]` |
| 70 | Order Card | `renderer/components/order/OrderCard.tsx` | `renderer/components/order/OrderCard.tsx` | `[~]` |
| 71 | Order Actions | `renderer/components/order/OrderActions.tsx` | `renderer/components/order/OrderActions.tsx` | `[~]` |
| 72 | Order Approval Panel | `renderer/components/order/OrderApprovalPanel.tsx` | `renderer/components/order/OrderApprovalPanel.tsx` | `[~]` |
| 73 | Order Status Controls | `renderer/components/order/OrderStatusControls.tsx` | `renderer/components/order/OrderStatusControls.tsx` | `[~]` |
| 74 | Order Routing Badge | `renderer/components/order/OrderRoutingBadge.tsx` | `renderer/components/order/OrderRoutingBadge.tsx` | `[~]` |
| 75 | Order Conflict Banner | `renderer/components/OrderConflictBanner.tsx` | `renderer/components/OrderConflictBanner.tsx` | `[~]` |
| 76 | Order Sync Route Indicator | `renderer/components/OrderSyncRouteIndicator.tsx` | `renderer/components/OrderSyncRouteIndicator.tsx` | `[~]` |
| 77 | Financial Sync Panel | `renderer/components/FinancialSyncPanel.tsx` | `renderer/components/FinancialSyncPanel.tsx` | `[~]` |
| 78 | Customer Info Form | `renderer/components/CustomerInfoForm.tsx` | `renderer/components/CustomerInfoForm.tsx` | `[~]` |
| 79 | Terminal Type Indicator | `renderer/components/TerminalTypeIndicator.tsx` | `renderer/components/TerminalTypeIndicator.tsx` | `[~]` |
| 80 | Update Dialog | `renderer/components/UpdateDialog.tsx` | `renderer/components/UpdateDialog.tsx` | `[~]` |
| 81 | Error Boundary | `renderer/components/error/ErrorBoundary.tsx` | `renderer/components/error/ErrorBoundary.tsx` | `[~]` |
| 82 | Bulk Actions Bar | `renderer/components/BulkActionsBar.tsx` | `renderer/components/BulkActionsBar.tsx` | `[~]` |
| 83 | Dashboard Card | `renderer/components/DashboardCard.tsx` | `renderer/components/DashboardCard.tsx` | `[~]` |
| 84 | Content Container | `renderer/components/ui/ContentContainer.tsx` | `renderer/components/ui/ContentContainer.tsx` | `[~]` |
| 85 | Locked Feature Screen | `renderer/components/modules/LockedFeatureScreen.tsx` | `renderer/components/modules/LockedFeatureScreen.tsx` | `[~]` |
| 86 | Module Not Available View | `renderer/components/RefactoredMainLayout.tsx:85-109` | `renderer/components/RefactoredMainLayout.tsx:85-109` | `[~]` |

---

## 2. Critical User Flows

### 2.1 Terminal Boot Sequence

- [ ] Load environment variables from `.env`
- [ ] Configure platform-specific settings (app user model ID on Windows)
- [ ] Register process signal handlers (SIGINT, SIGTERM, SIGHUP)
- [ ] Start dev-server watchdog (dev only)
- [ ] Register system IPC handlers (clipboard, window, geo, etc.)
- [x] Initialize SQLite database with fallback (fresh DB on corruption)
- [ ] Register database in service registry
- [ ] Initialize all services (settings, auth, sync, heartbeat, etc.)
- [ ] Register domain IPC handlers (orders, payments, shifts, etc.)
- [ ] Create main window (frameless, custom title bar)
- [ ] Set up service callbacks for main window
- [x] Perform initial health check
- [ ] Start auto-sync and realtime subscriptions
- [ ] Run legacy status normalization
- [ ] Start periodic health checks (every 5 minutes)
- [ ] Initialize auto-updater (production only)
- [ ] Create application menu

### 2.2 Onboarding Flow

- [ ] Language selection (English / Greek)
- [ ] Connection string input (base64url-encoded JSON)
- [ ] Decode connection string: `{ key, url, tid, surl?, skey? }`
- [ ] Raw API key detection and rejection
- [ ] Store admin dashboard URL
- [ ] Store terminal ID
- [ ] Store POS API key
- [ ] Store Supabase URL and anon key (if provided)
- [ ] Verify connectivity to admin dashboard
- [ ] Transition to login screen

### 2.3 Login Flow

- [ ] PIN pad UI with numpad (touch-friendly)
- [ ] Organization branding/logo on login screen
- [ ] App version display
- [ ] Auto-submit on correct PIN length
- [ ] `auth:login` IPC -> bcrypt hash verification
- [ ] Rate limiting: 5 attempts, 15-min lockout
- [ ] Store session in localStorage (`pos-user`)
- [ ] Update ShiftContext with staff info
- [ ] Activity tracker initialization
- [ ] PIN setup flow (first-time / reset)
- [ ] Session validation on app restart
- [ ] Inactivity timeout (configurable, default 15 min)
- [ ] Session duration limit (2 hours max)

### 2.4 Shift Management

- [ ] Shift overlay when no active shift (blocks all operations)
- [ ] Shift check-in modal (select role, set opening cash)
- [x] Role types: cashier, manager, driver, kitchen, server
- [x] Opening cash amount entry
- [x] Active shift detection by terminal
- [ ] Shift restoration on app restart
- [ ] Shift checkout flow
- [x] Closing cash amount entry
- [x] Cash variance calculation (V1 + V2)
- [ ] Expense recording during shift
- [ ] Staff payment recording (wages, tips, bonuses)
- [ ] Driver earnings tracking
- [ ] Shift summary generation
- [ ] Checkout receipt printing
- [ ] Z-Report generation and submission

### 2.5 Order Creation Flow

- [ ] New Order page with menu browsing
- [ ] Category/subcategory navigation
- [ ] Item selection with ingredient customization
- [ ] Combo meal support
- [ ] Order type selection (dine-in, takeaway, delivery, drive-thru)
- [ ] Customer lookup by phone
- [ ] Customer creation inline
- [ ] Delivery address entry with zone validation
- [ ] Table number assignment (restaurant)
- [ ] Discount application (percentage/amount)
- [ ] Tip entry
- [ ] Special instructions
- [ ] Order item editing (add/remove/modify)
- [ ] Order total calculation (subtotal, tax, delivery fee, discount, tip)
- [ ] Save order to local SQLite
- [ ] Queue order for Supabase sync

### 2.6 Payment Flow

- [ ] Payment modal with method selection
- [ ] Cash payment (amount tendered, change calculation)
- [ ] Card payment (via ECR terminal)
- [ ] Mixed payment (split cash/card)
- [ ] Payment status tracking
- [ ] Payment transaction recording (local SQLite)
- [ ] Receipt generation
- [ ] Cash drawer auto-open on cash payment

### 2.7 Receipt Printing

- [ ] Customer receipt printing
- [ ] Kitchen ticket printing
- [ ] Receipt encoding (ESC/POS)
- [ ] Greek character support (CP737, CP1253, UTF-8)
- [ ] Network printer support (TCP/IP)
- [ ] USB printer support
- [ ] Windows system printer support
- [ ] Multi-printer job routing
- [ ] Print job queue with retry
- [ ] Print preview
- [ ] Barcode label printing
- [ ] Shelf label printing
- [ ] Price tag printing
- [ ] Batch label printing

### 2.8 Settings Management

- [ ] Connection settings modal (admin URL, credentials)
- [ ] Printer configuration modal
- [ ] ECR/payment terminal setup
- [ ] Language switching (en/el)
- [ ] Theme switching (dark/light)
- [ ] Discount max percentage
- [ ] Tax rate configuration
- [ ] Session timeout settings
- [ ] Update channel selection (stable/beta)
- [ ] Factory reset capability
- [ ] Database reset/clear operational data

---

## 3. Settings / Config Screens

### 3.1 Connection Settings Modal

- [ ] Admin dashboard URL display and edit
- [ ] Terminal ID display
- [ ] API key status indicator
- [ ] Supabase URL display
- [ ] Re-configure via new connection string
- [ ] Clear connection / factory reset
- [ ] Connectivity test

### 3.2 Printer Settings Modal

- [ ] Printer discovery (network scan, system printers, Bluetooth)
- [ ] Add printer configuration
- [ ] Edit printer settings (IP, port, encoding, paper width)
- [ ] Remove printer
- [ ] Set default printer
- [ ] Test print
- [ ] Printer status monitoring
- [ ] Cash drawer configuration

### 3.3 Payment Terminal Settings

- [ ] ECR device discovery
- [ ] Add payment terminal
- [ ] Configure terminal (connection type, IP, port)
- [ ] Set default terminal
- [ ] Connection test
- [ ] Device status monitoring
- [ ] Remove terminal

### 3.4 System Settings (via IPC)

- [ ] Language preference (en/el) - persisted in settings
- [ ] Theme preference (dark/light) - persisted in localStorage
- [ ] Discount max percentage
- [ ] Tax rate
- [ ] Session timeout enabled/disabled
- [ ] Session timeout duration (minutes)
- [ ] Update channel (stable/beta)

---

## 4. Offline Behavior

### 4.1 Offline-First Operations (work without network)

- [ ] Order creation and management
- [ ] Payment recording
- [ ] Receipt printing
- [x] Shift open/close
- [ ] Expense recording
- [ ] Staff payment recording
- [ ] Driver earnings recording
- [ ] Customer lookup (cached data)
- [ ] Menu browsing (cached data)
- [ ] PIN-based login (local staff table)
- [ ] Z-Report generation (from local data)

### 4.2 Sync Queue

- [ ] `sync_queue` table for pending operations
- [ ] Operation types: insert, update, delete
- [ ] Exponential backoff retry (starting at 5s)
- [ ] `next_retry_at` scheduling
- [ ] Maximum attempt tracking
- [ ] Error message logging per attempt
- [ ] Conflict detection via version numbers
- [ ] Routing metadata (main, via_parent, direct_cloud)

### 4.3 Conflict Resolution

- [ ] `order_sync_conflicts` table
- [ ] Conflict types: version_mismatch, simultaneous_update, pending_local_changes
- [ ] Resolution strategies: local_wins, remote_wins, manual_merge, force_update
- [ ] Conflict UI banner (OrderConflictBanner)
- [ ] Manual conflict resolution interface

### 4.4 Network Monitoring

- [ ] NetworkMonitor sub-service
- [ ] Online/offline state detection
- [ ] SyncStatusIndicator (heart icon UI)
- [ ] Network status event emission (`network:status`)
- [ ] Automatic sync resume on reconnection

### 4.5 Sync Sub-Services

- [ ] OrderSyncService - order sync with version conflict resolution
- [ ] InventorySyncService - menu/inventory data sync
- [ ] ConfigurationSyncService - settings sync
- [ ] InterTerminalCommunicationService - terminal-to-terminal via shared DB
- [ ] NetworkMonitor - connectivity detection

### 4.6 Background Sync

- [ ] Periodic sync interval (configurable)
- [ ] Force sync capability
- [ ] Menu version polling (`useMenuVersionPolling`)
- [ ] Financial sync stats tracking
- [ ] Failed financial item retry
- [ ] Orphaned financial record re-queue

---

## 5. Device Integrations

### 5.1 Receipt Printers

- [ ] Network printers (TCP/IP) via `@point-of-sale/network-receipt-printer`
- [ ] USB printers via system printer API
- [ ] Windows system printers via `pdf-to-printer`
- [ ] Bluetooth printer discovery
- [ ] ESC/POS command encoding via `@point-of-sale/receipt-printer-encoder`
- [ ] Greek character encoding (CP737, CP1253, UTF-8)
- [ ] Multi-printer management (PrinterManager)
- [ ] Printer discovery (network scan via Bonjour, system enumeration)
- [ ] Print job queue with retry logic
- [ ] Printer status monitoring
- [ ] Printer diagnostics

### 5.2 Cash Drawer

- [ ] Open via ESC/POS kick command through receipt printer
- [ ] Support for drawer 1 and drawer 2
- [ ] Auto-open on cash payment

### 5.3 ECR Payment Terminals

- [ ] Device discovery (multiple connection types)
- [ ] Device add/remove/update
- [ ] Device connect/disconnect
- [ ] Payment processing (sale)
- [ ] Refund processing
- [ ] Void transaction
- [ ] Cancel in-progress transaction
- [ ] End-of-day settlement
- [ ] Transaction history and queries
- [ ] Transaction statistics
- [ ] Transaction-to-order linking
- [ ] Real-time events (connected, disconnected, status change, display message, error)

### 5.4 Barcode Scanner

- [ ] BarcodeScannerProvider context
- [ ] Keyboard wedge mode (HID input capture)
- [ ] Product lookup by barcode
- [ ] Barcode scanning events

### 5.5 Other Hardware

- [ ] Serial port communication (`serialport`)
- [ ] USB device access (`usb`)
- [ ] Machine ID generation (`node-machine-id`)
- [ ] Screen capture (with consent dialog)

---

## 6. APIs Used

### 6.1 Admin Dashboard REST API

Auth headers: `X-Terminal-ID`, `X-POS-API-Key`

| # | Endpoint | Method | Purpose | Status |
|---|----------|--------|---------|--------|
| 1 | `/api/pos/orders` | GET | Fetch orders | `[ ]` |
| 2 | `/api/pos/orders` | POST | Create/sync order | `[ ]` |
| 3 | `/api/pos/orders/sync` | POST | Order sync with conflict detection | `[x]` |
| 4 | `/api/pos/orders/sync` | GET | Fetch synced orders | `[ ]` |
| 5 | `/api/pos/menu-sync` | GET | Full menu data sync | `[x]` |
| 6 | `/api/pos/menu-version` | GET | Menu version check (polling) | `[ ]` |
| 7 | `/api/pos/modules/enabled` | GET | Enabled modules for terminal | `[ ]` |
| 8 | `/api/pos/settings/{terminal_id}` | GET | Terminal settings | `[ ]` |
| 9 | `/api/pos/settings/{terminal_id}` | POST | Update terminal settings | `[ ]` |
| 10 | `/api/pos/terminal-heartbeat` | POST | Terminal heartbeat | `[ ]` |
| 11 | `/api/pos/tables` | GET | Restaurant tables | `[ ]` |
| 12 | `/api/pos/tables/{id}` | PATCH | Update table | `[ ]` |
| 13 | `/api/pos/reservations` | GET | Reservations | `[ ]` |
| 14 | `/api/pos/rooms` | GET | Hotel rooms | `[ ]` |
| 15 | `/api/pos/rooms/{id}` | PATCH | Update room | `[ ]` |
| 16 | `/api/pos/suppliers` | GET | Suppliers list | `[ ]` |
| 17 | `/api/pos/analytics` | GET | Analytics data | `[ ]` |
| 18 | `/api/pos/appointments` | GET, POST | Appointments CRUD | `[ ]` |
| 19 | `/api/pos/appointments/{id}/status` | PATCH | Update appointment status | `[ ]` |
| 20 | `/api/pos/drive-through` | GET, POST | Drive-thru queue | `[ ]` |
| 21 | `/api/pos/terminals/list` | GET | List child terminals | `[ ]` |
| 22 | `/api/pos/z-report` | GET | Fetch Z-report for terminal | `[ ]` |
| 23 | `/api/pos/z-report/submit` | POST | Submit Z-report | `[ ]` |
| 24 | `/api/pos/coupons` | GET | Coupons list | `[ ]` |
| 25 | `/api/pos/loyalty/settings` | GET | Loyalty settings | `[ ]` |
| 26 | `/api/pos/loyalty/customers` | GET | Loyalty customers | `[ ]` |
| 27 | `/api/pos/services` | GET | Services (salon) | `[ ]` |
| 28 | `/api/pos/sync/services` | GET | Services sync fallback | `[ ]` |
| 29 | `/api/pos/sync/service_categories` | GET | Service categories | `[ ]` |
| 30 | `/api/settings/pos` | GET | POS-specific settings | `[ ]` |
| 31 | `/api/settings/menu` | GET | Menu settings | `[ ]` |

### 6.2 Supabase Direct (via `@supabase/supabase-js`)

| # | Table | Operations | Purpose | Status |
|---|-------|------------|---------|--------|
| 1 | `orders` | SELECT | Connectivity test | `[ ]` |
| 2 | `order_items` | SELECT | Realtime order item fetch | `[ ]` |
| 3 | `pos_configurations` | SELECT, realtime | Terminal config | `[ ]` |
| 4 | `subcategories` | SELECT, realtime | Menu items (realtime sync) | `[ ]` |
| 5 | `delivery_zones` | SELECT | Delivery zone data | `[ ]` |
| 6 | `customers` | SELECT, INSERT, UPDATE | Customer CRUD | `[ ]` |
| 7 | `customer_addresses` | SELECT, INSERT, UPDATE | Address CRUD | `[ ]` |
| 8 | `customer_sync_conflicts` | SELECT, INSERT, UPDATE | Conflict resolution | `[ ]` |
| 9 | `menu_categories` | SELECT | Category data | `[ ]` |
| 10 | `ingredients` | SELECT | Ingredient data | `[ ]` |
| 11 | `menu_synchronization` | SELECT | Sync metadata | `[ ]` |
| 12 | `staff` | SELECT, UPDATE | Staff data (login, sync) | `[ ]` |
| 13 | `roles` | SELECT | Role definitions | `[ ]` |
| 14 | `role_permissions` | SELECT | Permission lookup | `[ ]` |
| 15 | `branches` | SELECT | Branch data | `[ ]` |
| 16 | `driver_earnings` | INSERT, UPDATE | Sync driver earnings to cloud | `[ ]` |
| 17 | `staff_payments` | INSERT, UPDATE | Sync staff payments to cloud | `[ ]` |
| 18 | `shift_expenses` | INSERT, UPDATE | Sync expenses to cloud | `[x]` |
| 19 | `enhanced_sync_queue` | SELECT, INSERT, UPDATE | Cloud sync queue with backoff metadata | `[ ]` |
| 20 | `pos_terminals` | SELECT, UPDATE | Terminal registration and status | `[ ]` |
| 21 | `pos_heartbeats` | INSERT | Terminal heartbeat records | `[ ]` |
| 22 | `app_control_commands` | SELECT, UPDATE | Remote control commands (shutdown, restart, reset) | `[ ]` |
| 23 | `organization_modules` | SELECT | Module enablement per organization | `[ ]` |

### 6.3 Supabase Realtime Channels

| # | Channel | Table/Topic | Purpose | Status |
|---|---------|-------------|---------|--------|
| 1 | Order updates | `orders` | New/updated orders from other terminals | `[ ]` |
| 2 | Customer updates | `customers` | Customer data changes | `[ ]` |
| 3 | Terminal config | `pos_configurations` | Settings pushed from admin | `[ ]` |
| 4 | Module sync | modules | Module enable/disable events | `[ ]` |

---

## 7. Data Models (SQLite Tables)

> Full column-level schema from `pos-system/src/main/database-schema.sql`.
> Source: DatabaseService.ts schema v6.0 (2026-01-11).

### 7.1 Local-Only Tables

#### 7.1.1 `orders` (Local-Only)

| Column | Type | Constraints | Status |
|--------|------|-------------|--------|
| `id` | TEXT | PRIMARY KEY | `[ ]` |
| `order_number` | TEXT | UNIQUE NOT NULL | `[ ]` |
| `status` | TEXT | NOT NULL | `[ ]` |
| `items` | TEXT (JSON) | NOT NULL | `[ ]` |
| `total_amount` | REAL | NOT NULL | `[ ]` |
| `customer_name` | TEXT | nullable | `[ ]` |
| `customer_phone` | TEXT | nullable | `[ ]` |
| `customer_email` | TEXT | nullable | `[ ]` |
| `order_type` | TEXT | NOT NULL | `[ ]` |
| `table_number` | TEXT | nullable | `[ ]` |
| `delivery_address` | TEXT | nullable | `[ ]` |
| `delivery_city` | TEXT | nullable | `[ ]` |
| `delivery_postal_code` | TEXT | nullable | `[ ]` |
| `delivery_floor` | TEXT | nullable | `[ ]` |
| `delivery_notes` | TEXT | nullable | `[ ]` |
| `name_on_ringer` | TEXT | nullable | `[ ]` |
| `special_instructions` | TEXT | nullable | `[ ]` |
| `created_at` | TEXT | NOT NULL | `[ ]` |
| `updated_at` | TEXT | NOT NULL | `[ ]` |
| `estimated_time` | INTEGER | nullable | `[ ]` |
| `supabase_id` | TEXT | nullable | `[ ]` |
| `sync_status` | TEXT | DEFAULT 'pending' | `[ ]` |
| `payment_status` | TEXT | DEFAULT 'pending' | `[ ]` |
| `payment_method` | TEXT | nullable | `[ ]` |
| `payment_transaction_id` | TEXT | nullable | `[ ]` |
| `version` | INTEGER | DEFAULT 1 NOT NULL | `[ ]` |
| `updated_by` | TEXT | nullable | `[ ]` |
| `last_synced_at` | TEXT | nullable | `[ ]` |
| `remote_version` | INTEGER | nullable | `[ ]` |
| `routing_path` | TEXT | nullable ('main', 'via_parent', 'direct_cloud') | `[ ]` |
| `source_terminal_id` | TEXT | nullable | `[ ]` |
| `forwarded_at` | TEXT | nullable | `[ ]` |
| `driver_id` | TEXT | nullable (Supabase ref, NO FK) | `[ ]` |
| `driver_name` | TEXT | nullable | `[ ]` |
| `staff_shift_id` | TEXT | nullable | `[ ]` |
| `staff_id` | TEXT | nullable (Supabase ref, NO FK) | `[ ]` |
| `discount_percentage` | REAL | nullable | `[ ]` |
| `discount_amount` | REAL | nullable | `[ ]` |
| `tip_amount` | REAL | nullable | `[ ]` |

Indexes: `idx_orders_sync_status`, `idx_orders_version`, `idx_orders_supabase_id`, `idx_orders_status`, `idx_orders_created_at`

#### 7.1.2 `payment_transactions` (Local-Only, FK -> orders CASCADE)

| Column | Type | Constraints | Status |
|--------|------|-------------|--------|
| `id` | TEXT | PRIMARY KEY | `[ ]` |
| `order_id` | TEXT | NOT NULL, FK -> orders(id) CASCADE | `[ ]` |
| `amount` | REAL | NOT NULL | `[ ]` |
| `payment_method` | TEXT | NOT NULL | `[ ]` |
| `status` | TEXT | NOT NULL | `[ ]` |
| `gateway_transaction_id` | TEXT | nullable | `[ ]` |
| `gateway_response` | TEXT | nullable | `[ ]` |
| `processed_at` | TEXT | NOT NULL | `[ ]` |
| `refunded_amount` | REAL | DEFAULT 0 | `[ ]` |
| `metadata` | TEXT (JSON) | nullable | `[ ]` |
| `created_at` | TEXT | NOT NULL | `[ ]` |
| `updated_at` | TEXT | NOT NULL | `[ ]` |

Indexes: `idx_payment_transactions_order_id`, `idx_payment_transactions_status`, `idx_payment_transactions_created_at`

#### 7.1.3 `payment_receipts` (Local-Only, FK -> payment_transactions CASCADE)

| Column | Type | Constraints | Status |
|--------|------|-------------|--------|
| `id` | TEXT | PRIMARY KEY | `[ ]` |
| `transaction_id` | TEXT | NOT NULL, FK -> payment_transactions(id) CASCADE | `[ ]` |
| `receipt_number` | TEXT | UNIQUE NOT NULL | `[ ]` |
| `order_details` | TEXT (JSON) | NOT NULL | `[ ]` |
| `subtotal` | REAL | NOT NULL | `[ ]` |
| `tax` | REAL | NOT NULL | `[ ]` |
| `delivery_fee` | REAL | DEFAULT 0 | `[ ]` |
| `total_amount` | REAL | NOT NULL | `[ ]` |
| `payment_method` | TEXT | NOT NULL | `[ ]` |
| `cash_received` | REAL | nullable | `[ ]` |
| `change_given` | REAL | nullable | `[ ]` |
| `printed` | BOOLEAN | DEFAULT FALSE | `[ ]` |
| `emailed` | BOOLEAN | DEFAULT FALSE | `[ ]` |
| `email_address` | TEXT | nullable | `[ ]` |
| `created_at` | TEXT | NOT NULL | `[ ]` |

#### 7.1.4 `payment_refunds` (Local-Only, FK -> payment_transactions CASCADE)

| Column | Type | Constraints | Status |
|--------|------|-------------|--------|
| `id` | TEXT | PRIMARY KEY | `[ ]` |
| `transaction_id` | TEXT | NOT NULL, FK -> payment_transactions(id) CASCADE | `[ ]` |
| `amount` | REAL | NOT NULL | `[ ]` |
| `reason` | TEXT | nullable | `[ ]` |
| `status` | TEXT | NOT NULL | `[ ]` |
| `gateway_refund_id` | TEXT | nullable | `[ ]` |
| `processed_at` | TEXT | NOT NULL | `[ ]` |
| `created_at` | TEXT | NOT NULL | `[ ]` |

#### 7.1.5 `sync_queue` (Local-Only, no FKs)

| Column | Type | Constraints | Status |
|--------|------|-------------|--------|
| `id` | TEXT | PRIMARY KEY | `[ ]` |
| `table_name` | TEXT | NOT NULL | `[ ]` |
| `record_id` | TEXT | NOT NULL | `[ ]` |
| `operation` | TEXT | NOT NULL, CHECK IN ('insert','update','delete') | `[ ]` |
| `data` | TEXT (JSON) | NOT NULL | `[ ]` |
| `created_at` | TEXT | NOT NULL | `[ ]` |
| `attempts` | INTEGER | NOT NULL DEFAULT 0 | `[ ]` |
| `last_attempt` | TEXT | nullable | `[ ]` |
| `error_message` | TEXT | nullable | `[ ]` |
| `next_retry_at` | TEXT | nullable | `[ ]` |
| `retry_delay_ms` | INTEGER | DEFAULT 5000 | `[ ]` |
| `has_conflict` | INTEGER | DEFAULT 0 | `[ ]` |
| `conflict_id` | TEXT | nullable | `[ ]` |
| `routing_attempt` | INTEGER | DEFAULT 0 | `[ ]` |
| `routing_path` | TEXT | nullable | `[ ]` |

Indexes: `idx_sync_queue_next_retry`, `idx_sync_queue_conflict`, `idx_sync_queue_attempts`, `idx_sync_queue_created_at`, `idx_sync_queue_table_record`

#### 7.1.6 `order_sync_conflicts` (Local-Only)

| Column | Type | Constraints | Status |
|--------|------|-------------|--------|
| `id` | TEXT | PRIMARY KEY | `[ ]` |
| `order_id` | TEXT | NOT NULL | `[ ]` |
| `local_version` | INTEGER | NOT NULL | `[ ]` |
| `remote_version` | INTEGER | NOT NULL | `[ ]` |
| `local_data` | TEXT (JSON) | NOT NULL | `[ ]` |
| `remote_data` | TEXT (JSON) | NOT NULL | `[ ]` |
| `conflict_type` | TEXT | NOT NULL, CHECK IN ('version_mismatch','simultaneous_update','pending_local_changes') | `[ ]` |
| `resolution_strategy` | TEXT | nullable, CHECK IN ('local_wins','remote_wins','manual_merge','force_update') | `[ ]` |
| `resolved` | INTEGER | DEFAULT 0 | `[ ]` |
| `resolved_at` | TEXT | nullable | `[ ]` |
| `resolved_by` | TEXT | nullable | `[ ]` |
| `terminal_id` | TEXT | NOT NULL | `[ ]` |
| `created_at` | TEXT | NOT NULL | `[ ]` |
| `updated_at` | TEXT | NOT NULL | `[ ]` |

Indexes: `idx_conflicts_unresolved`, `idx_conflicts_order`, `idx_conflicts_terminal`

#### 7.1.7 `order_retry_queue` (Local-Only, no FKs)

| Column | Type | Constraints | Status |
|--------|------|-------------|--------|
| `id` | TEXT | PRIMARY KEY | `[ ]` |
| `order_data` | TEXT (JSON) | NOT NULL | `[ ]` |
| `created_at` | TEXT | NOT NULL | `[ ]` |
| `attempts` | INTEGER | NOT NULL DEFAULT 0 | `[ ]` |
| `last_attempt` | TEXT | nullable | `[ ]` |
| `error_message` | TEXT | nullable | `[ ]` |

Indexes: `idx_order_retry_queue_attempts`, `idx_order_retry_queue_created_at`

#### 7.1.8 `local_settings` (Local-Only)

| Column | Type | Constraints | Status |
|--------|------|-------------|--------|
| `id` | TEXT | PRIMARY KEY | `[ ]` |
| `setting_category` | TEXT | NOT NULL | `[ ]` |
| `setting_key` | TEXT | NOT NULL | `[ ]` |
| `setting_value` | TEXT | NOT NULL | `[ ]` |
| `last_sync` | TEXT | NOT NULL | `[ ]` |
| `created_at` | TEXT | NOT NULL | `[ ]` |
| `updated_at` | TEXT | NOT NULL | `[ ]` |

Unique constraint: `(setting_category, setting_key)`

#### 7.1.9 `pos_local_config` (Local-Only)

| Column | Type | Constraints | Status |
|--------|------|-------------|--------|
| `id` | TEXT | PRIMARY KEY | `[ ]` |
| `terminal_id` | TEXT | NOT NULL | `[ ]` |
| `config_key` | TEXT | NOT NULL | `[ ]` |
| `config_value` | TEXT | NOT NULL | `[ ]` |
| `last_sync` | TEXT | NOT NULL | `[ ]` |
| `created_at` | TEXT | NOT NULL | `[ ]` |
| `updated_at` | TEXT | NOT NULL | `[ ]` |

Unique constraint: `(terminal_id, config_key)`

### 7.2 Supabase-Managed Cache Tables

#### 7.2.1 `terminal_settings` (Supabase Cache)

| Column | Type | Constraints | Status |
|--------|------|-------------|--------|
| `terminal_id` | TEXT | PRIMARY KEY | `[ ]` |
| `branch_id` | TEXT | nullable | `[ ]` |
| `organization_id` | TEXT | nullable | `[ ]` |
| `business_type` | TEXT | nullable | `[ ]` |
| `settings` | TEXT (JSON) | NOT NULL | `[ ]` |
| `version` | INTEGER | DEFAULT 1 | `[ ]` |
| `updated_at` | TEXT | NOT NULL | `[ ]` |
| `synced_at` | TEXT | DEFAULT CURRENT_TIMESTAMP | `[ ]` |

Index: `idx_terminal_settings_organization`

#### 7.2.2 `staff` (Supabase Cache)

| Column | Type | Constraints | Status |
|--------|------|-------------|--------|
| `id` | TEXT | PRIMARY KEY | `[ ]` |
| `user_id` | TEXT | nullable | `[ ]` |
| `staff_code` | TEXT | UNIQUE | `[ ]` |
| `first_name` | TEXT | NOT NULL | `[ ]` |
| `last_name` | TEXT | NOT NULL | `[ ]` |
| `email` | TEXT | UNIQUE | `[ ]` |
| `phone` | TEXT | nullable | `[ ]` |
| `role_id` | TEXT | nullable | `[ ]` |
| `branch_id` | TEXT | nullable | `[ ]` |
| `department` | TEXT | nullable | `[ ]` |
| `employment_type` | TEXT | DEFAULT 'full-time' | `[ ]` |
| `hire_date` | TEXT | nullable | `[ ]` |
| `hourly_rate` | REAL | nullable | `[ ]` |
| `pin_hash` | TEXT | nullable | `[ ]` |
| `is_active` | INTEGER | NOT NULL DEFAULT 1 | `[ ]` |
| `can_login_pos` | INTEGER | NOT NULL DEFAULT 1 | `[ ]` |
| `last_login_at` | TEXT | nullable | `[ ]` |
| `created_at` | TEXT | NOT NULL | `[ ]` |
| `updated_at` | TEXT | NOT NULL | `[ ]` |

Indexes: `idx_staff_branch`, `idx_staff_role`, `idx_staff_active`

#### 7.2.3 `subcategories_cache` (Supabase Cache)

| Column | Type | Constraints | Status |
|--------|------|-------------|--------|
| `id` | TEXT | PRIMARY KEY | `[ ]` |
| `name` | TEXT | NOT NULL | `[ ]` |
| `name_en` | TEXT | nullable | `[ ]` |
| `name_el` | TEXT | nullable | `[ ]` |
| `category_id` | TEXT | nullable | `[ ]` |
| `updated_at` | TEXT | NOT NULL | `[ ]` |

Indexes: `idx_subcategories_cache_updated`, `idx_subcategories_cache_category`

### 7.3 Hybrid Tables (local + Supabase references)

#### 7.3.1 `staff_sessions` (Hybrid, staff_id = Supabase ref NO FK)

| Column | Type | Constraints | Status |
|--------|------|-------------|--------|
| `id` | TEXT | PRIMARY KEY | `[ ]` |
| `staff_id` | TEXT | NOT NULL (Supabase ref, NO FK) | `[ ]` |
| `pin_hash` | TEXT | NOT NULL | `[ ]` |
| `role` | TEXT | NOT NULL, CHECK IN ('admin','staff') | `[ ]` |
| `login_time` | TEXT | NOT NULL | `[ ]` |
| `logout_time` | TEXT | nullable | `[ ]` |
| `is_active` | BOOLEAN | NOT NULL DEFAULT 1 | `[ ]` |

Indexes: `idx_staff_sessions_staff_id`, `idx_staff_sessions_active`

#### 7.3.2 `staff_shifts` (Hybrid, staff_id = Supabase ref NO FK)

| Column | Type | Constraints | Status |
|--------|------|-------------|--------|
| `id` | TEXT | PRIMARY KEY | `[x]` |
| `staff_id` | TEXT | NOT NULL (Supabase ref, NO FK) | `[x]` |
| `staff_name` | TEXT | nullable | `[x]` |
| `branch_id` | TEXT | nullable | `[x]` |
| `terminal_id` | TEXT | nullable | `[x]` |
| `role_type` | TEXT | NOT NULL, CHECK IN ('cashier','manager','driver','kitchen','server') | `[x]` |
| `check_in_time` | TEXT | NOT NULL | `[x]` |
| `check_out_time` | TEXT | nullable | `[x]` |
| `scheduled_start` | TEXT | nullable | `[x]` |
| `scheduled_end` | TEXT | nullable | `[x]` |
| `opening_cash_amount` | REAL | DEFAULT 0 | `[x]` |
| `closing_cash_amount` | REAL | nullable | `[x]` |
| `expected_cash_amount` | REAL | nullable | `[x]` |
| `cash_variance` | REAL | nullable | `[x]` |
| `status` | TEXT | NOT NULL DEFAULT 'active', CHECK IN ('active','closed','abandoned') | `[x]` |
| `total_orders_count` | INTEGER | DEFAULT 0 | `[x]` |
| `total_sales_amount` | REAL | DEFAULT 0 | `[x]` |
| `total_cash_sales` | REAL | DEFAULT 0 | `[x]` |
| `total_card_sales` | REAL | DEFAULT 0 | `[x]` |
| `payment_amount` | REAL | nullable | `[x]` |
| `calculation_version` | INTEGER | DEFAULT 2 | `[x]` |
| `is_day_start` | INTEGER | DEFAULT 0 | `[x]` |
| `is_transfer_pending` | INTEGER | DEFAULT 0 | `[x]` |
| `notes` | TEXT | nullable | `[x]` |
| `closed_by` | TEXT | nullable | `[x]` |
| `transferred_to_cashier_shift_id` | TEXT | nullable | `[x]` |
| `created_at` | TEXT | NOT NULL | `[x]` |
| `updated_at` | TEXT | NOT NULL | `[x]` |

Indexes: `idx_staff_shifts_staff`, `idx_staff_shifts_branch`, `idx_staff_shifts_status`, `idx_staff_shifts_check_in`, `idx_staff_shifts_role_type`, `idx_staff_shifts_terminal`

#### 7.3.3 `cash_drawer_sessions` (Hybrid, FK -> staff_shifts CASCADE)

| Column | Type | Constraints | Status |
|--------|------|-------------|--------|
| `id` | TEXT | PRIMARY KEY | `[x]` |
| `staff_shift_id` | TEXT | NOT NULL UNIQUE, FK -> staff_shifts(id) CASCADE | `[x]` |
| `cashier_id` | TEXT | NOT NULL (Supabase ref, NO FK) | `[x]` |
| `branch_id` | TEXT | NOT NULL | `[x]` |
| `terminal_id` | TEXT | NOT NULL | `[x]` |
| `opening_amount` | REAL | NOT NULL DEFAULT 0 | `[x]` |
| `closing_amount` | REAL | nullable | `[x]` |
| `expected_amount` | REAL | nullable | `[x]` |
| `variance_amount` | REAL | nullable | `[x]` |
| `total_cash_sales` | REAL | DEFAULT 0 | `[x]` |
| `total_card_sales` | REAL | DEFAULT 0 | `[x]` |
| `total_refunds` | REAL | DEFAULT 0 | `[x]` |
| `total_expenses` | REAL | DEFAULT 0 | `[x]` |
| `cash_drops` | REAL | DEFAULT 0 | `[x]` |
| `driver_cash_given` | REAL | DEFAULT 0 | `[x]` |
| `driver_cash_returned` | REAL | DEFAULT 0 | `[x]` |
| `total_staff_payments` | REAL | DEFAULT 0 | `[x]` |
| `opened_at` | TEXT | NOT NULL | `[x]` |
| `closed_at` | TEXT | nullable | `[x]` |
| `reconciled` | INTEGER | DEFAULT 0 | `[x]` |
| `reconciled_at` | TEXT | nullable | `[x]` |
| `reconciled_by` | TEXT | nullable | `[x]` |
| `reconciliation_notes` | TEXT | nullable | `[x]` |
| `created_at` | TEXT | NOT NULL | `[x]` |
| `updated_at` | TEXT | NOT NULL | `[x]` |

CHECK constraints: `closed_at IS NULL OR closed_at >= opened_at`, `reconciled = 0 OR (reconciled_at IS NOT NULL AND reconciled_by IS NOT NULL)`

#### 7.3.4 `shift_expenses` (Hybrid, FK -> staff_shifts CASCADE)

| Column | Type | Constraints | Status |
|--------|------|-------------|--------|
| `id` | TEXT | PRIMARY KEY | `[x]` |
| `staff_shift_id` | TEXT | NOT NULL, FK -> staff_shifts(id) CASCADE | `[x]` |
| `staff_id` | TEXT | NOT NULL (Supabase ref, NO FK) | `[x]` |
| `branch_id` | TEXT | NOT NULL | `[x]` |
| `expense_type` | TEXT | NOT NULL, CHECK IN ('supplies','maintenance','petty_cash','refund','other') | `[x]` |
| `amount` | REAL | NOT NULL | `[x]` |
| `description` | TEXT | NOT NULL | `[x]` |
| `receipt_number` | TEXT | nullable | `[x]` |
| `status` | TEXT | NOT NULL DEFAULT 'pending', CHECK IN ('pending','approved','rejected') | `[x]` |
| `approved_by` | TEXT | nullable | `[x]` |
| `approved_at` | TEXT | nullable | `[x]` |
| `rejection_reason` | TEXT | nullable | `[x]` |
| `created_at` | TEXT | NOT NULL | `[x]` |
| `updated_at` | TEXT | NOT NULL | `[x]` |

CHECK constraints: `status != 'approved' OR (approved_by IS NOT NULL AND approved_at IS NOT NULL)`, `status != 'rejected' OR rejection_reason IS NOT NULL`

#### 7.3.5 `driver_earnings` (Hybrid, FK -> staff_shifts SET NULL, FK -> orders CASCADE)

| Column | Type | Constraints | Status |
|--------|------|-------------|--------|
| `id` | TEXT | PRIMARY KEY | `[ ]` |
| `driver_id` | TEXT | NOT NULL (Supabase ref, NO FK) | `[ ]` |
| `staff_shift_id` | TEXT | nullable, FK -> staff_shifts(id) SET NULL | `[ ]` |
| `order_id` | TEXT | UNIQUE NOT NULL, FK -> orders(id) CASCADE | `[ ]` |
| `branch_id` | TEXT | NOT NULL | `[ ]` |
| `delivery_fee` | REAL | DEFAULT 0 | `[ ]` |
| `tip_amount` | REAL | DEFAULT 0 | `[ ]` |
| `total_earning` | REAL | NOT NULL | `[ ]` |
| `payment_method` | TEXT | NOT NULL, CHECK IN ('cash','card','mixed') | `[ ]` |
| `cash_collected` | REAL | DEFAULT 0 | `[ ]` |
| `card_amount` | REAL | DEFAULT 0 | `[ ]` |
| `cash_to_return` | REAL | DEFAULT 0 | `[ ]` |
| `order_details` | TEXT (JSON) | nullable | `[ ]` |
| `settled` | INTEGER | DEFAULT 0 | `[ ]` |
| `settled_at` | TEXT | nullable | `[ ]` |
| `settlement_batch_id` | TEXT | nullable | `[ ]` |
| `is_transferred` | INTEGER | DEFAULT 0 | `[ ]` |
| `supabase_id` | TEXT | nullable | `[ ]` |
| `created_at` | TEXT | NOT NULL | `[ ]` |
| `updated_at` | TEXT | NOT NULL | `[ ]` |

CHECK constraints: `total_earning = delivery_fee + tip_amount`, `settled = 0 OR settled_at IS NOT NULL`

#### 7.3.6 `staff_payments` (Hybrid, FK -> staff_shifts SET NULL + CASCADE)

| Column | Type | Constraints | Status |
|--------|------|-------------|--------|
| `id` | TEXT | PRIMARY KEY | `[ ]` |
| `staff_shift_id` | TEXT | nullable, FK -> staff_shifts(id) SET NULL | `[ ]` |
| `paid_to_staff_id` | TEXT | NOT NULL (Supabase ref, NO FK) | `[ ]` |
| `paid_by_cashier_shift_id` | TEXT | NOT NULL, FK -> staff_shifts(id) CASCADE | `[ ]` |
| `amount` | REAL | NOT NULL, CHECK (amount > 0) | `[ ]` |
| `payment_type` | TEXT | NOT NULL, CHECK IN ('wage','tip','bonus','advance','other') | `[ ]` |
| `notes` | TEXT | nullable | `[ ]` |
| `supabase_id` | TEXT | nullable | `[ ]` |
| `created_at` | TEXT | NOT NULL | `[ ]` |
| `updated_at` | TEXT | NOT NULL | `[ ]` |

Indexes: `idx_staff_payments_staff_shift`, `idx_staff_payments_paid_to`, `idx_staff_payments_paid_by`, `idx_staff_payments_created_at`, `idx_staff_payments_payment_type`

### 7.4 Database Infrastructure

- [ ] Foreign keys enabled globally (`PRAGMA foreign_keys = ON`)
- [ ] CASCADE DELETE for local parent-child relationships
- [ ] SET NULL for optional shift references
- [ ] NO FK constraints on Supabase-managed references (staff_id, driver_id, customer_id)
- [ ] Database migration system (v1.0 through v6.0)
- [ ] Database initialization with fallback (fresh DB on corruption)
- [ ] Database health checks
- [ ] Database reset capability

### 7.5 Sync Engine Configuration

> These are the runtime parameters of the Electron POS sync engine that must be replicated in Tauri.

| Parameter | Value | Source |
|-----------|-------|--------|
| Main sync polling interval | 30 seconds | `SyncService.ts` |
| Admin dashboard sync interval | 2 minutes | `AdminDashboardSyncService.ts` |
| Module sync interval | 2 minutes | `ModuleSyncService.ts` |
| Sync queue initial retry delay | 5,000 ms | `sync_queue.retry_delay_ms` DEFAULT |
| Retry delay multiplier | 2x (exponential backoff) | `SyncService.ts` |
| Max retry delay | 5 minutes (300,000 ms) | `SyncService.ts` |
| Max retry attempts | 5 | `SyncService.ts` |
| Order sync 3-tier strategy | 1. Admin REST API -> 2. Supabase RPC -> 3. Direct Supabase insert | `OrderSyncService.ts` |

- [ ] Implement polling-based sync with configurable intervals
- [ ] Implement exponential backoff (5s initial, 2x multiplier, 5min cap, 5 retries)
- [ ] Implement 3-tier order sync fallback strategy
- [ ] Implement sync queue processing with next_retry_at scheduling

### 7.6 Auth & Credential Storage

> Maps Electron's credential storage model to Tauri equivalents.

| Aspect | Electron Implementation | Tauri Equivalent |
|--------|------------------------|------------------|
| PIN hashing | bcrypt, 14 salt rounds | Same (via Rust `bcrypt` crate) |
| Login attempt limit | 5 attempts | Same |
| Lockout duration | 15 minutes | Same |
| Session timeout | Configurable, default 15 min | Same |
| Max session duration | 2 hours | Same |
| API key storage | Electron `safeStorage` (DPAPI on Windows, Keychain on macOS) | Tauri `tauri-plugin-stronghold` or OS keychain |
| Credential memory cache | In-memory singleton (renderer-side) | Tauri state management |

- [ ] Implement bcrypt PIN verification (14 rounds)
- [ ] Implement rate limiting (5 attempts, 15-min lockout)
- [ ] Implement session timeout (configurable, 15-min default)
- [ ] Implement max session duration (2 hours)
- [ ] Implement secure API key storage (OS keychain equivalent)
- [ ] Implement credential cache in Tauri managed state

---

## 8. Module System

### 8.1 Module Infrastructure

- [ ] ModuleSyncService - fetch enabled modules from admin API
- [~] ModuleProvider context - exposes enabled/locked modules to UI
- [~] NavigationModule type - precomputed access flags for sidebar
- [~] Module access checking (useModuleAccess hook)
- [~] Locked module upgrade prompt
- [~] Module Not Available view (for unimplemented modules)
- [~] Coming Soon view placeholder
- [ ] Periodic module sync (2-minute interval)
- [ ] Supabase Realtime module sync
- [ ] Offline module queue
- [ ] Module dependency validation

### 8.2 Business Type Detection

- [ ] `business_type` field from terminal config
- [ ] Types: `fast_food`, `restaurant`, `bar_cafe`, `food_truck`, `hotel`, `salon`, `retail`
- [ ] Default fallback: `fast_food`
- [ ] Dashboard auto-selection by business type (Food/Service/Product)

### 8.3 Core Modules (always available)

- [ ] `dashboard` - Business category dashboard
- [ ] `orders` - Order management
- [ ] `menu` - Menu management
- [ ] `users` - Staff/customer management
- [ ] `reports` - Reports
- [ ] `analytics` - Analytics

### 8.4 Food Vertical Modules

- [ ] `drive_through` - Drive-thru queue management
- [ ] `delivery` - Delivery order management
- [ ] `delivery_zones` - Delivery zone configuration
- [ ] `kiosk` - Self-service kiosk management
- [ ] `kitchen_display` - Kitchen display system
- [ ] `tables` - Table management (restaurant/bar)
- [ ] `reservations` - Reservation management

### 8.5 Hotel Vertical Modules

- [ ] `rooms` - Room management
- [ ] `housekeeping` - Housekeeping task tracking
- [ ] `guest_billing` - Guest folio and billing

### 8.6 Salon Vertical Modules

- [ ] `appointments` - Appointment booking and management
- [ ] `staff_schedule` - Staff scheduling
- [ ] `service_catalog` - Service catalog management

### 8.7 Retail Vertical Modules

- [ ] `product_catalog` - Product catalog with barcode support

### 8.8 Cross-Vertical Modules

- [ ] `coupons` - Coupon management
- [ ] `loyalty` - Loyalty program
- [ ] `suppliers` - Supplier management
- [ ] `inventory` - Inventory tracking
- [ ] `plugin_integrations` - Third-party integrations

---

## 9. IPC Commands -> Tauri Commands

> Maps Electron IPC channels to planned Tauri command groups.
> In Tauri, these become `#[tauri::command]` functions invoked via `invoke()`.

### 9.1 App Control

| Electron IPC | Tauri Command | Status |
|--------------|---------------|--------|
| `app:shutdown` | `app_shutdown` | `[x]` |
| `app:restart` | `app_restart` | `[x]` |
| `app:get-shutdown-status` | `app_get_shutdown_status` | `[x]` |
| `app:get-version` | `app_get_version` | `[x]` |

### 9.2 Window Control

| Electron IPC | Tauri Command | Status |
|--------------|---------------|--------|
| `window-minimize` | `window_minimize` | `[x]` |
| `window-maximize` | `window_maximize` | `[x]` |
| `window-close` | `window_close` | `[x]` |
| `window-toggle-fullscreen` | `window_toggle_fullscreen` | `[x]` |
| `window-get-state` | `window_get_state` | `[x]` |
| `window-reload` | `window_reload` | `[ ]` |
| `window-force-reload` | `window_force_reload` | `[ ]` |
| `window-toggle-devtools` | `window_toggle_devtools` | `[ ]` |
| `window-zoom-in` | `window_zoom_in` | `[ ]` |
| `window-zoom-out` | `window_zoom_out` | `[ ]` |
| `window-zoom-reset` | `window_zoom_reset` | `[ ]` |

### 9.3 Auth

| Electron IPC | Tauri Command | Status |
|--------------|---------------|--------|
| `auth:login` | `auth_login` | `[x]` |
| `auth:logout` | `auth_logout` | `[x]` |
| `auth:get-current-session` | `auth_get_current_session` | `[x]` |
| `auth:validate-session` | `auth_validate_session` | `[x]` |
| `auth:has-permission` | `auth_has_permission` | `[x]` |
| `auth:get-session-stats` | `auth_get_session_stats` | `[x]` |
| `auth:setup-pin` | `auth_setup_pin` | `[x]` |

### 9.4 Staff Auth

| Electron IPC | Tauri Command | Status |
|--------------|---------------|--------|
| `staff-auth:authenticate-pin` | `staff_auth_authenticate_pin` | `[x]` |
| `staff-auth:get-session` | `staff_auth_get_session` | `[x]` |
| `staff-auth:get-current` | `staff_auth_get_current` | `[x]` |
| `staff-auth:has-permission` | `staff_auth_has_permission` | `[x]` |
| `staff-auth:has-any-permission` | `staff_auth_has_any_permission` | `[x]` |
| `staff-auth:logout` | `staff_auth_logout` | `[x]` |
| `staff-auth:validate-session` | `staff_auth_validate_session` | `[x]` |
| `staff-auth:track-activity` | `staff_auth_track_activity` | `[x]` |

### 9.5 Orders

| Electron IPC | Tauri Command | Status |
|--------------|---------------|--------|
| `order:get-all` | `order_get_all` | `[x]` |
| `order:get-by-id` | `order_get_by_id` | `[x]` |
| `order:create` | `order_create` | `[x]` |
| `order:update-status` | `order_update_status` | `[ ]` |
| `order:update-items` | `order_update_items` | `[ ]` |
| `order:delete` | `order_delete` | `[ ]` |
| `order:save-from-remote` | `order_save_from_remote` | `[ ]` |
| `order:save-for-retry` | `order_save_for_retry` | `[ ]` |
| `order:get-retry-queue` | `order_get_retry_queue` | `[ ]` |
| `order:process-retry-queue` | `order_process_retry_queue` | `[ ]` |
| `order:approve` | `order_approve` | `[ ]` |
| `order:decline` | `order_decline` | `[ ]` |
| `order:assign-driver` | `order_assign_driver` | `[ ]` |
| `order:notify-platform-ready` | `order_notify_platform_ready` | `[ ]` |
| `order:update-preparation` | `order_update_preparation` | `[ ]` |
| `order:update-type` | `order_update_type` | `[ ]` |
| `order:fetch-items-from-supabase` | `order_fetch_items_from_supabase` | `[ ]` |

### 9.6 Order Conflicts & Retry

| Electron IPC | Tauri Command | Status |
|--------------|---------------|--------|
| `orders:get-conflicts` | `orders_get_conflicts` | `[ ]` |
| `orders:resolve-conflict` | `orders_resolve_conflict` | `[ ]` |
| `orders:force-sync-retry` | `orders_force_sync_retry` | `[ ]` |
| `orders:get-retry-info` | `orders_get_retry_info` | `[ ]` |
| `orders:clear-all` | `orders_clear_all` | `[ ]` |

### 9.7 Payments

| Electron IPC | Tauri Command | Status |
|--------------|---------------|--------|
| `payment:update-payment-status` | `payment_update_status` | `[ ]` |
| `payment:print-receipt` | `payment_print_receipt` | `[x]` |
| `kitchen:print-ticket` | `kitchen_print_ticket` | `[x]` |

### 9.8 Sync

| Electron IPC | Tauri Command | Status |
|--------------|---------------|--------|
| `sync:get-status` | `sync_get_status` | `[x]` |
| `sync:force` | `sync_force` | `[x]` |
| `sync:get-network-status` | `sync_get_network_status` | `[x]` |
| `sync:get-inter-terminal-status` | `sync_get_inter_terminal_status` | `[ ]` |
| `sync:clear-all` | `sync_clear_all` | `[ ]` |
| `sync:clear-failed` | `sync_clear_failed` | `[ ]` |
| `sync:clear-old-orders` | `sync_clear_old_orders` | `[ ]` |
| `sync:clear-all-orders` | `sync_clear_all_orders` | `[ ]` |
| `sync:cleanup-deleted-orders` | `sync_cleanup_deleted_orders` | `[ ]` |
| `sync:get-financial-stats` | `sync_get_financial_stats` | `[ ]` |
| `sync:get-failed-financial-items` | `sync_get_failed_financial_items` | `[ ]` |
| `sync:retry-financial-item` | `sync_retry_financial_item` | `[ ]` |
| `sync:retry-all-failed-financial` | `sync_retry_all_failed_financial` | `[ ]` |
| `sync:get-unsynced-financial-summary` | `sync_get_unsynced_financial_summary` | `[ ]` |
| `sync:validate-financial-integrity` | `sync_validate_financial_integrity` | `[ ]` |
| `sync:requeue-orphaned-financial` | `sync_requeue_orphaned_financial` | `[ ]` |
| `sync:test-parent-connection` | `sync_test_parent_connection` | `[x]` |
| `sync:rediscover-parent` | `sync_rediscover_parent` | `[ ]` |

### 9.9 Admin Dashboard Sync

| Electron IPC | Tauri Command | Status |
|--------------|---------------|--------|
| `sync:fetch-tables` | `sync_fetch_tables` | `[ ]` |
| `sync:fetch-reservations` | `sync_fetch_reservations` | `[ ]` |
| `sync:fetch-suppliers` | `sync_fetch_suppliers` | `[ ]` |
| `sync:fetch-analytics` | `sync_fetch_analytics` | `[ ]` |
| `sync:fetch-orders` | `sync_fetch_orders` | `[ ]` |
| `api:fetch-from-admin` | `api_fetch_from_admin` | `[x]` |

### 9.10 Customers

| Electron IPC | Tauri Command | Status |
|--------------|---------------|--------|
| `customer:invalidate-cache` | `customer_invalidate_cache` | `[ ]` |
| `customer:get-cache-stats` | `customer_get_cache_stats` | `[ ]` |
| `customer:clear-cache` | `customer_clear_cache` | `[ ]` |
| `customer:lookup-by-phone` | `customer_lookup_by_phone` | `[ ]` |
| `customer:lookup-by-id` | `customer_lookup_by_id` | `[ ]` |
| `customer:search` | `customer_search` | `[ ]` |
| `customer:create` | `customer_create` | `[ ]` |
| `customer:update` | `customer_update` | `[ ]` |
| `customer:update-ban-status` | `customer_update_ban_status` | `[ ]` |
| `customer:add-address` | `customer_add_address` | `[ ]` |
| `customer:update-address` | `customer_update_address` | `[ ]` |
| `customer:resolve-conflict` | `customer_resolve_conflict` | `[ ]` |
| `customer:get-conflicts` | `customer_get_conflicts` | `[ ]` |

### 9.11 Settings

| Electron IPC | Tauri Command | Status |
|--------------|---------------|--------|
| `get-settings` | `get_settings` | `[ ]` |
| `update-settings` | `update_settings` | `[ ]` |
| `settings:get` | `settings_get` | `[x]` |
| `settings:get-local` | `settings_get_local` | `[x]` |
| `settings:update-local` | `settings_update_local` | `[x]` |
| `settings:set` | `settings_set` | `[x]` |
| `settings:get-discount-max` | `settings_get_discount_max` | `[x]` |
| `settings:set-discount-max` | `settings_set_discount_max` | `[x]` |
| `settings:get-tax-rate` | `settings_get_tax_rate` | `[x]` |
| `settings:set-tax-rate` | `settings_set_tax_rate` | `[x]` |
| `settings:get-language` | `settings_get_language` | `[x]` |
| `settings:set-language` | `settings_set_language` | `[x]` |
| `settings:update-terminal-credentials` | `settings_update_terminal_credentials` | `[x]` |
| `settings:is-configured` | `settings_is_configured` | `[x]` |
| `settings:factory-reset` | `settings_factory_reset` | `[x]` |
| `settings:get-admin-url` | `settings_get_admin_url` | `[x]` |
| `settings:clear-connection` | `settings_clear_connection` | `[x]` |

### 9.12 Terminal Config

| Electron IPC | Tauri Command | Status |
|--------------|---------------|--------|
| `terminal-config:get-settings` | `terminal_config_get_settings` | `[x]` |
| `terminal-config:get-setting` | `terminal_config_get_setting` | `[x]` |
| `terminal-config:get-branch-id` | `terminal_config_get_branch_id` | `[x]` |
| `terminal-config:get-terminal-id` | `terminal_config_get_terminal_id` | `[x]` |
| `terminal-config:refresh` | `terminal_config_refresh` | `[x]` |
| `terminal-config:get-organization-id` | `terminal_config_get_organization_id` | `[x]` |
| `terminal-config:get-business-type` | `terminal_config_get_business_type` | `[x]` |
| `terminal-config:get-full-config` | `terminal_config_get_full_config` | `[x]` |

### 9.13 Shifts

| Electron IPC | Tauri Command | Status |
|--------------|---------------|--------|
| `shift:open` | `shift_open` | `[x]` |
| `shift:close` | `shift_close` | `[x]` |
| `shift:get-active` | `shift_get_active` | `[x]` |
| `shift:get-active-by-terminal` | `shift_get_active_by_terminal` | `[x]` |
| `shift:get-active-by-terminal-loose` | `shift_get_active_by_terminal_loose` | `[x]` |
| `shift:get-active-cashier-by-terminal` | `shift_get_active_cashier_by_terminal` | `[x]` |
| `shift:list-staff-for-checkin` | `shift_list_staff_for_checkin` | `[ ]` |
| `shift:get-staff-roles` | `shift_get_staff_roles` | `[ ]` |
| `shift:get-summary` | `shift_get_summary` | `[x]` |
| `shift:record-expense` | `shift_record_expense` | `[x]` |
| `shift:get-expenses` | `shift_get_expenses` | `[x]` |
| `shift:record-staff-payment` | `shift_record_staff_payment` | `[ ]` |
| `shift:get-staff-payments` | `shift_get_staff_payments` | `[ ]` |
| `shift:backfill-driver-earnings` | `shift_backfill_driver_earnings` | `[ ]` |

### 9.14 Drivers

| Electron IPC | Tauri Command | Status |
|--------------|---------------|--------|
| `driver:record-earning` | `driver_record_earning` | `[ ]` |
| `driver:get-earnings` | `driver_get_earnings` | `[ ]` |
| `driver:get-shift-summary` | `driver_get_shift_summary` | `[ ]` |
| `driver:get-active` | `driver_get_active` | `[ ]` |

### 9.15 Delivery Zones

| Electron IPC | Tauri Command | Status |
|--------------|---------------|--------|
| `delivery-zone:track-validation` | `delivery_zone_track_validation` | `[ ]` |
| `delivery-zone:get-analytics` | `delivery_zone_get_analytics` | `[ ]` |
| `delivery-zone:request-override` | `delivery_zone_request_override` | `[ ]` |

### 9.16 Reports

| Electron IPC | Tauri Command | Status |
|--------------|---------------|--------|
| `report:get-today-statistics` | `report_get_today_statistics` | `[ ]` |
| `report:get-sales-trend` | `report_get_sales_trend` | `[ ]` |
| `report:get-top-items` | `report_get_top_items` | `[ ]` |
| `report:get-weekly-top-items` | `report_get_weekly_top_items` | `[ ]` |
| `report:generate-z-report` | `report_generate_z_report` | `[ ]` |
| `report:get-daily-staff-performance` | `report_get_daily_staff_performance` | `[ ]` |
| `report:submit-z-report` | `report_submit_z_report` | `[ ]` |

### 9.17 Menu

| Electron IPC | Tauri Command | Status |
|--------------|---------------|--------|
| `menu:get-categories` | `menu_get_categories` | `[x]` |
| `menu:get-subcategories` | `menu_get_subcategories` | `[x]` |
| `menu:get-ingredients` | `menu_get_ingredients` | `[x]` |
| `menu:get-subcategory-ingredients` | `menu_get_subcategory_ingredients` | `[ ]` |
| `menu:get-combos` | `menu_get_combos` | `[x]` |
| `menu:update-category` | `menu_update_category` | `[ ]` |
| `menu:update-subcategory` | `menu_update_subcategory` | `[ ]` |
| `menu:update-ingredient` | `menu_update_ingredient` | `[ ]` |
| `menu:update-combo` | `menu_update_combo` | `[ ]` |
| `menu:trigger-check-for-updates` | `menu_trigger_check_for_updates` | `[ ]` |

### 9.18 Printers

| Electron IPC | Tauri Command | Status |
|--------------|---------------|--------|
| `printer:list-system-printers` | `printer_list_system_printers` | `[ ]` |
| `printer:scan-network` | `printer_scan_network` | `[ ]` |
| `printer:scan-bluetooth` | `printer_scan_bluetooth` | `[ ]` |
| `printer:discover` | `printer_discover` | `[ ]` |
| `printer:add` | `printer_add` | `[ ]` |
| `printer:update` | `printer_update` | `[ ]` |
| `printer:remove` | `printer_remove` | `[ ]` |
| `printer:get-all` | `printer_get_all` | `[ ]` |
| `printer:get` | `printer_get` | `[ ]` |
| `printer:get-status` | `printer_get_status` | `[ ]` |
| `printer:get-all-statuses` | `printer_get_all_statuses` | `[ ]` |
| `printer:submit-job` | `printer_submit_job` | `[ ]` |
| `printer:cancel-job` | `printer_cancel_job` | `[ ]` |
| `printer:retry-job` | `printer_retry_job` | `[ ]` |
| `printer:test` | `printer_test` | `[ ]` |
| `printer:diagnostics` | `printer_diagnostics` | `[ ]` |
| `printer:bluetooth-status` | `printer_bluetooth_status` | `[ ]` |
| `printer:open-cash-drawer` | `printer_open_cash_drawer` | `[ ]` |

### 9.19 ECR Payment Terminals

| Electron IPC | Tauri Command | Status |
|--------------|---------------|--------|
| `ecr:discover-devices` | `ecr_discover_devices` | `[ ]` |
| `ecr:get-devices` | `ecr_get_devices` | `[ ]` |
| `ecr:get-device` | `ecr_get_device` | `[ ]` |
| `ecr:add-device` | `ecr_add_device` | `[ ]` |
| `ecr:update-device` | `ecr_update_device` | `[ ]` |
| `ecr:remove-device` | `ecr_remove_device` | `[ ]` |
| `ecr:get-default-terminal` | `ecr_get_default_terminal` | `[ ]` |
| `ecr:connect-device` | `ecr_connect_device` | `[ ]` |
| `ecr:disconnect-device` | `ecr_disconnect_device` | `[ ]` |
| `ecr:get-device-status` | `ecr_get_device_status` | `[ ]` |
| `ecr:get-all-statuses` | `ecr_get_all_statuses` | `[ ]` |
| `ecr:process-payment` | `ecr_process_payment` | `[ ]` |
| `ecr:process-refund` | `ecr_process_refund` | `[ ]` |
| `ecr:void-transaction` | `ecr_void_transaction` | `[ ]` |
| `ecr:cancel-transaction` | `ecr_cancel_transaction` | `[ ]` |
| `ecr:settlement` | `ecr_settlement` | `[ ]` |
| `ecr:get-recent-transactions` | `ecr_get_recent_transactions` | `[ ]` |
| `ecr:query-transactions` | `ecr_query_transactions` | `[ ]` |
| `ecr:get-transaction-stats` | `ecr_get_transaction_stats` | `[ ]` |
| `ecr:get-transaction-for-order` | `ecr_get_transaction_for_order` | `[ ]` |

### 9.20 Modules

| Electron IPC | Tauri Command | Status |
|--------------|---------------|--------|
| `modules:fetch-from-admin` | `modules_fetch_from_admin` | `[~]` |
| `modules:get-cached` | `modules_get_cached` | `[~]` |
| `modules:save-cache` | `modules_save_cache` | `[ ]` |

### 9.21 Database

| Electron IPC | Tauri Command | Status |
|--------------|---------------|--------|
| `database:health-check` | `database_health_check` | `[x]` |
| `database:get-stats` | `database_get_stats` | `[x]` |
| `database:reset` | `database_reset` | `[ ]` |
| `database:clear-operational-data` | `database_clear_operational_data` | `[ ]` |

### 9.22 Updates

| Electron IPC | Tauri Command | Status |
|--------------|---------------|--------|
| `update:install` | `update_install` | `[ ]` |
| `update:get-state` | `update_get_state` | `[~]` |
| `update:check` | `update_check` | `[~]` |
| `update:download` | `update_download` | `[ ]` |
| `update:cancel-download` | `update_cancel_download` | `[ ]` |
| `update:set-channel` | `update_set_channel` | `[ ]` |

### 9.23 System / Utilities

| Electron IPC | Tauri Command | Status |
|--------------|---------------|--------|
| `system:get-info` | `system_get_info` | `[x]` |
| `show-notification` | `show_notification` | `[ ]` |
| `clipboard:read-text` | `clipboard_read_text` | `[ ]` |
| `clipboard:write-text` | `clipboard_write_text` | `[ ]` |
| `geo:ip` | `geo_ip` | `[ ]` |
| `screen-capture:get-sources` | `screen_capture_get_sources` | `[ ]` |

### 9.24 Tauri Event Channels (replaces Electron push events)

> In Tauri, use `app.emit()` / `window.emit()` from Rust and `listen()` in JS.

| Electron Event Channel | Tauri Event | Status |
|-------------------------|-------------|--------|
| `order-realtime-update` | `order:realtime-update` | `[ ]` |
| `order-status-updated` | `order:status-updated` | `[ ]` |
| `order-created` | `order:created` | `[ ]` |
| `order-deleted` | `order:deleted` | `[ ]` |
| `order-payment-updated` | `order:payment-updated` | `[ ]` |
| `customer-created` | `customer:created` | `[ ]` |
| `customer-updated` | `customer:updated` | `[ ]` |
| `customer-deleted` | `customer:deleted` | `[ ]` |
| `customer-sync-conflict` | `customer:sync-conflict` | `[ ]` |
| `customer-conflict-resolved` | `customer:conflict-resolved` | `[ ]` |
| `order-sync-conflict` | `order:sync-conflict` | `[ ]` |
| `order-conflict-resolved` | `order:conflict-resolved` | `[ ]` |
| `sync-retry-scheduled` | `sync:retry-scheduled` | `[ ]` |
| `sync:status` | `sync:status` | `[ ]` |
| `network:status` | `network:status` | `[ ]` |
| `sync:error` | `sync:error` | `[ ]` |
| `sync:complete` | `sync:complete` | `[ ]` |
| `settings:update` | `settings:update` | `[ ]` |
| `staff:permission-update` | `staff:permission-update` | `[ ]` |
| `hardware-config:update` | `hardware-config:update` | `[ ]` |
| `shift-updated` | `shift:updated` | `[ ]` |
| `database-health-update` | `database:health-update` | `[ ]` |
| `terminal-settings-updated` | `terminal:settings-updated` | `[ ]` |
| `terminal-credentials-updated` | `terminal:credentials-updated` | `[ ]` |
| `terminal-config-updated` | `terminal:config-updated` | `[ ]` |
| `session-timeout` | `session:timeout` | `[ ]` |
| `menu:sync` | `menu:sync` | `[ ]` |
| `modules:sync-complete` | `modules:sync-complete` | `[ ]` |
| `modules:sync-error` | `modules:sync-error` | `[ ]` |
| `modules:refresh-needed` | `modules:refresh-needed` | `[ ]` |
| `printer:status-changed` | `printer:status-changed` | `[ ]` |
| `ecr:event:device-connected` | `ecr:device-connected` | `[ ]` |
| `ecr:event:device-disconnected` | `ecr:device-disconnected` | `[ ]` |
| `ecr:event:device-status-changed` | `ecr:device-status-changed` | `[ ]` |
| `ecr:event:transaction-started` | `ecr:transaction-started` | `[ ]` |
| `ecr:event:transaction-status` | `ecr:transaction-status` | `[ ]` |
| `ecr:event:transaction-completed` | `ecr:transaction-completed` | `[ ]` |
| `ecr:event:display-message` | `ecr:display-message` | `[ ]` |
| `ecr:event:error` | `ecr:error` | `[ ]` |
| `update-checking` | `update:checking` | `[ ]` |
| `update-available` | `update:available` | `[ ]` |
| `update-not-available` | `update:not-available` | `[ ]` |
| `update-error` | `update:error` | `[ ]` |
| `download-progress` | `update:download-progress` | `[ ]` |
| `update-downloaded` | `update:downloaded` | `[ ]` |
| `control-command-received` | `control:command-received` | `[ ]` |
| `app-shutdown-initiated` | `app:shutdown-initiated` | `[ ]` |
| `app-restart-initiated` | `app:restart-initiated` | `[ ]` |
| `app:reset` | `app:reset` | `[ ]` |
| `terminal-disabled` | `terminal:disabled` | `[ ]` |
| `terminal-enabled` | `terminal:enabled` | `[ ]` |

---

## Summary Statistics

| Category | Count |
|----------|-------|
| Screens (pages + views) | 34 |
| Modals | 22 |
| Shared UI Components | 30 |
| User Flows | 8 major flows |
| Admin API Endpoints | 31 |
| Supabase Direct Tables | 23 |
| Realtime Channels | 4 |
| SQLite Tables | 18 (9 local-only, 3 cache, 6 hybrid) |
| SQLite Columns (total) | ~250 |
| IPC Invoke Commands | ~180 |
| IPC Event Channels | ~48 |
| Vertical Modules | 5 verticals, 15 modules |
| Device Integrations | 4 categories |
| Sync Engine Parameters | 8 configurable values |
| Auth/Credential Items | 6 |
| **Total Parity Items** | **~450+** |
