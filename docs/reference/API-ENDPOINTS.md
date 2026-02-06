# API Endpoints Reference

Centralized reference of all admin dashboard API endpoints the POS system calls.

**Last Updated:** 2026-01-20
**Version:** 2.0.0

---

## Health & Settings Endpoints

| Endpoint | Method | Service | Purpose |
|----------|--------|---------|---------|
| `/api/health` | GET | AdminDashboardSyncService | Health check |
| `/api/pos/menu-sync` | GET | AdminDashboardSyncService | Fetch menu data |
| `/api/pos/settings/:terminal_id` | GET | AdminDashboardSyncService | Terminal settings |
| `/api/pos/terminal-heartbeat` | POST | AdminDashboardSyncService | Terminal heartbeat |

`/api/pos/menu-sync` query params:
- `terminal_id` (required)
- `last_sync` (optional, ISO timestamp)
- `include_inactive` (optional, when true returns inactive/unavailable items for management views)

---

## Module & Data Sync Endpoints

| Endpoint | Method | Service | Purpose |
|----------|--------|---------|---------|
| `/api/pos/modules/enabled` | GET | ModuleSyncService | Enabled modules for org |
| `/api/pos/modules/core` | GET | ModuleSyncService | Deprecated. POS core screens are standard (no fetch) |
| `/api/pos/tables` | GET | api-sync.ts | Table layout |
| `/api/pos/reservations` | GET | api-sync.ts | Reservations |
| `/api/pos/suppliers` | GET | api-sync.ts | Suppliers list |
| `/api/pos/analytics` | GET | api-sync.ts | Analytics data |
| `/api/pos/orders` | GET | api-sync.ts | Orders |

---

## Operational Endpoints

| Endpoint | Method | Handler | Purpose |
|----------|--------|---------|---------|
| `/api/plugin-sync/notify` | POST | order-status-handlers | Plugin sync notification |
| `/api/pos/payments` | POST | payment-handlers | Payment processing |
| `/api/pos/z-report` | GET | report-handlers | Get Z-report |
| `/api/pos/z-report/submit` | POST | report-handlers | Submit Z-report |
| `/api/pos/terminals` | GET | Various | Terminal management |

---

## Customer Endpoints

| Endpoint | Method | Service | Purpose |
|----------|--------|---------|---------|
| `/api/customers` | GET | CustomerService | **PRIMARY** Customer list |
| `/api/customers` | POST | CustomerService | **PRIMARY** Create/find customer |
| `/api/pos/customers` | GET | CustomerService | Legacy redirect |
| `/customers?search=` | GET | CustomerService | Customer search |

> **Note:** `/api/customers` is now the primary endpoint for all customer operations. The `/api/pos/customers` endpoint redirects to it for backward compatibility.

---

## Supabase RPC Functions

| Function | Type | Service | Purpose |
|----------|------|---------|---------|
| `pos_checkin_staff` | RPC | StaffAuthService | Staff check-in |
| `pos_validate_staff_session` | RPC | StaffAuthService | Session validation |
| `pos_lookup_customer_by_phone` | RPC | CustomerService | Phone lookup |
| `log_staff_activity` | RPC | StaffAuthService | Activity logging |

---

## Supabase Realtime Channels

| Channel | Type | Service | Purpose |
|---------|------|---------|---------|
| `screen_share_requests` | Realtime | ScreenCaptureService | Screen sharing requests |

---

## Service Files Reference

| Service | Location | Description |
|---------|----------|-------------|
| AdminDashboardSyncService | `src/main/services/AdminDashboardSyncService.ts` | Admin dashboard sync with rate-limit retry |
| ModuleSyncService | `src/main/services/ModuleSyncService.ts` | Module enablement sync |
| CustomerService | `src/main/services/CustomerService.ts` | Customer data management |
| StaffAuthService | `src/main/services/StaffAuthService.ts` | Staff authentication |
| ScreenCaptureService | `src/renderer/services/ScreenCaptureHandler.ts` | Remote screen capture |
| api-sync | `src/main/api-sync.ts` | General data sync utilities |

---

## Deprecated Endpoints

### GET `/api/pos/modules/core`

Deprecated. POS core screens are standard and always available, so POS clients no longer fetch them.
This endpoint returns an empty list for backward compatibility.

**Authentication:** Terminal API Key (x-pos-api-key header)

**Query Parameters:**
- `terminal_id` (required): The terminal requesting modules

**Response:**
```json
{
  "success": true,
  "deprecated": true,
  "modules": [],
  "count": 0,
  "timestamp": "2026-01-20T10:30:00Z",
  "processing_time_ms": 45
}
```

**Rate Limiting:** API_GENERAL preset (100 req/min per terminal)

---

### GET `/api/customers`

Primary endpoint for customer data management.

**Query Parameters:**
- `page` (default: 1): Page number
- `limit` (default: 50, max: 250): Items per page
- `search`: Search by name, phone, or email
- `status`: 'active' | 'inactive' | 'all'
- `branch_id`: Filter by branch
- `sortBy`: Field to sort by
- `sortOrder`: 'asc' | 'desc'

**Response:**
```json
{
  "success": true,
  "customers": [...],
  "users": [...],  // Legacy field
  "pagination": {
    "page": 1,
    "limit": 50,
    "total": 150
  }
}
```

---

## Notes

### Module Terminology: Users vs Customers
The `users` module is for **customer management**, NOT staff management:
- **Module ID**: `users` (for backward compatibility)
- **Display Name**: `Customers`
- **Purpose**: Customer database, loyalty, order history
- **Staff Management**: Handled separately under Branches/POS settings

The CustomerService (`src/main/services/CustomerService.ts`) handles all customer-related operations.

### Authentication
All API calls require proper authentication headers:
- `Authorization: Bearer <token>` - JWT token from Supabase auth
- `x-organization-id: <org_id>` - Organization context for multi-tenancy

### Error Handling
All endpoints follow consistent error response format:
```json
{
  "error": "Error message",
  "code": "ERROR_CODE"
}
```
