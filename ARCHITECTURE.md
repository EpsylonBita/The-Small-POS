# The Small POS - Tauri Architecture

> Status update (2026-02-16): IPC contract gate passes at `243/243` mapped invoke channels and `58/58` mapped bridge events (`npm run parity:contract`).
> Note: this document still contains planned module-layout sections from earlier phases; the current source of truth for runtime contract parity is `scripts/check-parity-contract.mjs` plus `src/lib/ipc-adapter.ts`, `src/lib/event-bridge.ts`, and `src-tauri/src/lib.rs`.

## 1. High-Level Architecture

```
+------------------------------------------------------------------+
|                        Tauri Application                          |
|                                                                   |
|  +----------------------------+  +-----------------------------+  |
|  |     React Frontend         |  |      Rust Backend           |  |
|  |     (Webview)              |  |      (Core Process)         |  |
|  |                            |  |                             |  |
|  |  +----------------------+  |  |  +-------+ +----------+    |  |
|  |  | Reused Electron UI   |  |  |  | Tauri | | Command  |    |  |
|  |  | Components (~100+)   |<-+--+->| IPC   | | Router   |    |  |
|  |  +----------------------+  |  |  +-------+ +----+-----+    |  |
|  |  | IPC Adapter Layer    |  |  |                 |           |  |
|  |  | (electron-compat.ts) |  |  |  +--------------v--------+ |  |
|  |  +----------------------+  |  |  |   Service Layer        | |  |
|  |  | Contexts & Hooks     |  |  |  |   - AuthService       | |  |
|  |  | (Theme, Shift, i18n) |  |  |  |   - OrderService      | |  |
|  |  +----------------------+  |  |  |   - SyncService        | |  |
|  |  | Zustand Stores       |  |  |  |   - SettingsService    | |  |
|  |  +----------------------+  |  |  |   - PrinterService     | |  |
|  |                            |  |  |   - EcrService         | |  |
|  |  Vite + Tailwind 3         |  |  +-------+----------------+ |  |
|  |  React 19 + TypeScript     |  |          |                   |  |
|  +----------------------------+  |  +-------v----------------+ |  |
|                                  |  |   Data Layer           | |  |
|                                  |  |   - rusqlite (SQLite)  | |  |
|                                  |  |   - 17 tables          | |  |
|                                  |  |   - WAL mode           | |  |
|                                  |  +-------+----------------+ |  |
|                                  |          |                   |  |
|                                  |  +-------v----------------+ |  |
|                                  |  |   Sync Engine          | |  |
|                                  |  |   - reqwest (HTTP)     | |  |
|                                  |  |   - Supabase Realtime  | |  |
|                                  |  |   - Offline queue      | |  |
|                                  |  +------------------------+ |  |
|                                  |                             |  |
|                                  |  +------------------------+ |  |
|                                  |  |   Secure Storage       | |  |
|                                  |  |   - keyring-rs (DPAPI) | |  |
|                                  |  +------------------------+ |  |
|                                  +-----------------------------+  |
+------------------------------------------------------------------+
```

**Key difference from Electron:** Rust replaces the Node.js main process. All database access, sync, auth, and hardware communication happen in Rust. The React frontend is identical - reused via an IPC adapter shim that translates `window.electron.ipcRenderer.invoke()` calls to Tauri `invoke()` commands.

---

## 2. Frontend Architecture

### Stack
| Technology | Version | Purpose |
|-----------|---------|---------|
| React | 19.x | UI framework |
| TypeScript | 5.x | Type safety |
| Vite | 6.x | Build tool (replaces Webpack) |
| Tailwind CSS | 3.3.6 | Utility-first CSS |
| lucide-react | 0.427+ | Icon library |
| framer-motion | 12.x | Animations |
| react-window | 2.x | Virtualized lists |
| recharts | 2.x | Charts |
| react-i18next | 15.x | Internationalization (en/el) |
| zustand | 4.x | State management |
| react-router-dom | 6.x | HashRouter routing |
| react-hot-toast | 2.x | Toast notifications |

### Component Reuse Strategy

The Electron POS has ~100+ React components. Approximately 40% are directly reusable with zero changes. The remaining 60% call `window.electron.ipcRenderer.invoke()` and require the IPC adapter layer.

**Reuse approach:**
1. Copy renderer components from `pos-system/src/renderer/` into `pos-tauri/src/`
2. The `electron-compat.ts` shim installs `window.electron` + `window.electronAPI` backed by Tauri's `invoke()`
3. Components work without code changes - the bridge handles routing

```
pos-tauri/src/lib/
  platform-detect.ts    # Detect Tauri/Electron/browser at runtime
  ipc-adapter.ts        # PlatformBridge interface + TauriBridge + ElectronBridge
  electron-compat.ts    # window.electron/electronAPI shim (Proxy-based)
  event-bridge.ts       # Tauri events -> Electron IPC channel events
  index.ts              # Barrel export
```

### State Management
- **React Contexts** (6): Theme, Shift, Module, Navigation, i18n, BarcodeScanner
- **Zustand stores**: Order state, UI state
- **localStorage**: Theme preference, language, terminal ID, session data

### Navigation
State-driven (not URL-driven). Single `RefactoredMainLayout` component with `currentView` state determines which page renders. Only 3 actual React Router routes: `/`, `/dashboard`, `/new-order`.

### Design System
- **Glassmorphism CSS** (`glassmorphism.css`, ~600 lines) with CSS custom properties
- **Light/dark/auto themes** (auto = time-based, 6AM-6PM)
- **Touch-first**: 44px minimum touch targets
- **Component library**: `pos-glass-components.tsx` (POSGlassCard, POSGlassButton, POSGlassInput, POSGlassModal, etc.)
- **Custom title bar**: Frameless window with `-webkit-app-region: drag`

---

## 3. Rust Backend Architecture

### Module Structure

```
src-tauri/src/
  main.rs                  # App entry, plugin registration
  lib.rs                   # Module declarations
  commands/                # Tauri command handlers (grouped by domain)
    mod.rs
    auth.rs                # auth_login, auth_logout, auth_setup_pin, staff_auth_*
    settings.rs            # settings_get, settings_set, settings_is_configured, settings_factory_reset
    terminal_config.rs     # terminal_config_get_settings, terminal_config_get_branch_id, etc.
    orders.rs              # order_get_all, order_create, order_update_status, order_delete, etc.
    sync.rs                # sync_get_status, sync_force, sync_fetch_orders, sync_fetch_tables, etc.
    menu.rs                # menu_get_categories, menu_get_subcategories, menu_get_ingredients, etc.
    shifts.rs              # shift_open, shift_close, shift_get_active, shift_get_summary, etc.
    payments.rs            # payment_update_payment_status, payment_print_receipt
    reports.rs             # report_get_today_statistics, report_generate_z_report, etc.
    customers.rs           # customer_lookup_by_phone, customer_search, customer_create, etc.
    printer.rs             # printer_discover, printer_add, printer_submit_job, printer_test, etc.
    ecr.rs                 # ecr_discover_devices, ecr_process_payment, ecr_process_refund, etc.
    modules.rs             # modules_fetch_from_admin, modules_get_cached, modules_save_cache
    window.rs              # window_minimize, window_maximize, window_toggle_fullscreen, etc.
    updates.rs             # update_check, update_download, update_install, update_set_channel
    admin_api.rs           # api_fetch_from_admin (generic authenticated proxy)
    database.rs            # database_health_check, database_get_stats, database_reset
  services/                # Business logic layer
    mod.rs
    auth_service.rs        # PIN bcrypt verification, session management, rate limiting
    order_service.rs       # Order CRUD + financial derivation + sync queue integration
    sync_service.rs        # Main sync orchestrator (30s polling + realtime triggers)
    sync_queue_service.rs  # Exponential backoff queue management
    order_sync_service.rs  # 3-tier order sync (API -> RPC -> direct Supabase)
    settings_service.rs    # Local settings + terminal config
    payment_service.rs     # Payment transactions + receipts
    report_service.rs      # Dashboard metrics + Z-reports
    customer_service.rs    # Customer cache + CRUD + conflict resolution
    heartbeat_service.rs   # Terminal health reporting to admin dashboard
    module_sync_service.rs # Module enabled/disabled sync
    printer_service.rs     # ESC/POS printing over TCP/USB
    ecr_service.rs         # Payment terminal integration (serial/TCP)
  db/                      # Database layer
    mod.rs
    schema.rs              # CREATE TABLE statements (17 tables)
    migrations.rs          # Schema versioning
    connection.rs          # rusqlite connection pool + WAL mode
  sync/                    # Sync engine
    mod.rs
    engine.rs              # Main sync loop + network monitoring
    queue.rs               # sync_queue table operations
    conflict.rs            # Version-based conflict detection + resolution
    admin_api.rs           # reqwest HTTP client for admin dashboard API
    supabase.rs            # Supabase direct client (PostgREST)
    realtime.rs            # Supabase Realtime WebSocket channels
  security/                # Security
    mod.rs
    credentials.rs         # keyring-rs for API key/Supabase key storage
    pin_auth.rs            # bcrypt PIN hashing + verification
    rate_limiter.rs        # In-memory rate limiting (5 attempts, 15min lockout)
  hardware/                # Hardware integrations
    mod.rs
    printer.rs             # ESC/POS encoder + TCP/USB transport
    cash_drawer.rs         # ESC/POS kick command
    ecr.rs                 # ECR protocol implementation
```

### Rust Dependencies

| Crate | Version | Purpose |
|-------|---------|---------|
| `tauri` | 2.x | App framework |
| `rusqlite` | 0.32+ | SQLite (bundled) |
| `serde` / `serde_json` | 1.x | Serialization |
| `reqwest` | 0.12+ | HTTP client (admin API) |
| `keyring` | 3.x | Secure credential storage (DPAPI on Windows) |
| `bcrypt` | 0.16+ | PIN hashing (14 rounds) |
| `tokio` | 1.x | Async runtime |
| `chrono` | 0.4+ | Timestamps (ISO 8601) |
| `uuid` | 1.x | RFC4122 v4 ID generation |
| `zstd` | 0.13+ | Compression for large sync payloads |
| `tracing` | 0.1+ | Structured logging |
| `tungstenite` | 0.24+ | WebSocket for Supabase Realtime |

### Command Registration

~180 Tauri commands organized in 24 groups, matching the Electron IPC channel namespaces. Each Electron `ipcRenderer.invoke('namespace:action', ...args)` maps to a Tauri command `namespace_action(args)`.

---

## 4. Offline-First Data Flow

```
User Action
    |
    v
React Component
    |
    v
IPC Adapter (ipc-adapter.ts)
    |
    v
Tauri Command (Rust)
    |
    v
Service Layer (Rust)
    |
    +---> Write to SQLite (ALWAYS first)
    |         |
    |         +---> Insert into sync_queue
    |
    v
Return to UI immediately (optimistic)

Background Sync Loop (every 30s):
    |
    +---> Read pending items from sync_queue
    |       (WHERE attempts < 5 AND next_retry_at <= now AND has_conflict = 0)
    |
    +---> For each item (priority: orders > shifts > cash_drawer > payments/expenses):
    |       |
    |       +---> Try Admin Dashboard API (POST /api/pos/orders/sync)
    |       |       |
    |       |       +---> Success: DELETE from sync_queue, update supabase_id
    |       |       |
    |       |       +---> Conflict: Create order_sync_conflicts entry
    |       |       |
    |       |       +---> Failure: Fallback to Supabase RPC (pos_upsert_order)
    |       |               |
    |       |               +---> Failure: Fallback to direct Supabase upsert
    |       |                       |
    |       |                       +---> Failure: Increment attempts,
    |       |                               double retry_delay (5s -> 10s -> 20s -> 40s -> 80s)
    |       |                               set next_retry_at
    |
    +---> Network Monitor (1s polling via reqwest health check)
            |
            +---> Online: Resume sync
            +---> Offline: Pause sync, queue accumulates
```

### Backpressure + Legacy Backend Compatibility (2026-02-17)

- Primary order write path remains `POST /api/pos/orders/sync`.
- During prolonged queue backpressure (`HTTP 429` with high `queue_age_seconds`), POS can attempt `DELETE /api/pos/orders/sync` to clear stale pending receipts.
- Some deployments do not support that `DELETE` route and return `404/405`. The POS client now detects that once and disables further cleanup `DELETE` attempts for the current app session.
- For stale backpressure cases, POS can fallback to direct order inserts via `POST /api/pos/orders` (insert operations only).
- Fallback errors are classified:
  - Permanent validation/business errors (for example invalid menu item IDs) consume retry budget and eventually quarantine the queue row (`status='failed'`).
  - Transient/network/server errors remain retryable.
  - Pure backpressure keeps deferred retries without incrementing `retry_count`.

### Conflict Resolution

| Strategy | When Used |
|----------|-----------|
| Version-based optimistic locking | Orders (`version` / `remote_version` columns) |
| Last-write-wins | Non-order tables (staff_shifts, cash_drawer_sessions, etc.) |
| Manual merge | Customer conflicts (UI-driven resolution) |

---

## 5. Backend Communication

### Admin Dashboard REST API

HTTP client: `reqwest` with connection pooling

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/pos/terminal-heartbeat` | POST | Terminal health + status |
| `/api/pos/menu-sync?terminal_id=...&last_sync=...` | GET | Incremental menu data (45s timeout, 3 retries) |
| `/api/pos/settings/{terminal_id}` | GET/POST | Terminal settings push/pull |
| `/api/pos/orders/sync` | POST | **Primary** order sync (batch operations) |
| `/api/pos/orders/sync` | DELETE | Optional stale-receipt cleanup (compat-dependent; POS disables after first `404/405`) |
| `/api/pos/modules/enabled?terminal_id=...` | GET | Fetch enabled modules |

**Auth headers on every request:**
```
x-terminal-id: {terminal_id}
x-pos-api-key: {api_key}        # From keyring secure storage
```

### Supabase Direct (PostgREST via reqwest)

| Table | Operations |
|-------|-----------|
| `orders` + `order_items` | Upsert/select/delete (fallback sync) |
| `staff_shifts` | Upsert (shift sync) |
| `cash_drawer_sessions` | Upsert |
| `driver_earnings` / `staff_payments` / `shift_expenses` | Upsert |
| `customers` / `customer_addresses` | Upsert |
| `pos_configurations` | Select/update |
| `pos_terminals` | Update |
| `pos_heartbeats` | Insert |

### Supabase Realtime (WebSocket)

3 channels with automatic reconnection + exponential backoff:

| Channel | Filter | Triggers |
|---------|--------|----------|
| `enhanced_sync_queue` | `terminal_id=eq.{id}` | Immediate sync on incoming changes |
| `pos_configurations` | `terminal_id=eq.{id}` | Settings refresh |
| `organization_modules` | `organization_id=eq.{id}` | Module re-fetch |

### Adapter Pattern

All backend communication goes through an adapter layer:
```rust
pub trait BackendAdapter: Send + Sync {
    async fn sync_orders(&self, operations: Vec<SyncOperation>) -> Result<SyncResult>;
    async fn fetch_menu(&self, last_sync: Option<String>) -> Result<MenuData>;
    async fn heartbeat(&self, status: TerminalStatus) -> Result<HeartbeatResponse>;
    // ...
}

pub struct AdminApiAdapter { /* reqwest client + auth headers */ }
pub struct SupabaseDirectAdapter { /* PostgREST client */ }
```

This allows swapping endpoints without UI changes.

---

## 6. Security Model

### Terminal Pairing
1. Terminal receives connection string (base64url-encoded JSON) during onboarding
2. Connection string contains: `apiKey`, `terminalId`, `adminUrl`, `supabaseUrl`, `supabaseAnonKey`
3. API key stored in **Windows Credential Manager** via `keyring-rs` (replacing Electron's `safeStorage`/DPAPI)
4. Other settings stored in SQLite `local_settings` table

### PIN Authentication
- Algorithm: bcrypt, 14 salt rounds
- Minimum: 6-digit PIN
- Rate limiting: 5 max attempts, 15-minute lockout (in-memory HashMap)
- Session duration: 2 hours max
- Inactivity timeout: 15 minutes (configurable)
- Inactivity check: every 60 seconds

### API Security
- Terminal API key: never stored in plaintext (keyring-rs → DPAPI on Windows)
- Auth headers: `x-terminal-id` + `x-pos-api-key` on every admin API request
- Supabase anon key: for direct Supabase client calls
- Service role key: **NEVER** exposed in POS builds

### Tauri-Specific Security
- **CSP**: `default-src 'self'; connect-src 'self' https://*.supabase.co https://*.supabase.in; style-src 'self' 'unsafe-inline'; script-src 'self'`
- **contextIsolation**: Enabled by default in Tauri v2
- **IPC filtering**: Only registered commands are callable
- **No Node.js**: Eliminates entire class of Node.js vulnerabilities

---

## 7. Build & Packaging

### Development
```bash
cd pos-tauri
npm install                    # Install frontend dependencies
npm run pos:tauri:dev          # Start Vite + Tauri dev mode (hot reload)
```

### Production Build
```bash
npm run pos:tauri:build        # Build optimized frontend + Rust binary + NSIS installer
```

### Build Pipeline
1. **Vite** bundles React frontend → `dist/`
2. **Cargo** compiles Rust backend → native binary
3. **Tauri bundler** packages both → Windows NSIS installer (`.exe`)

### Auto-Updater
Tauri's built-in updater plugin (replacing `electron-updater`):
- Checks for updates from a configured endpoint
- Downloads + verifies signature
- Installs on next restart
- Supports stable/beta channels

### Output
| Artifact | Format | Platform |
|----------|--------|----------|
| Installer | `.exe` (NSIS) | Windows |
| Portable | `.exe` | Windows |
| MSI | `.msi` (future) | Windows |

### Size Comparison (expected)
| | Electron POS | Tauri POS |
|---|---|---|
| Installer size | ~120-150 MB | ~15-25 MB |
| RAM at idle | ~200-300 MB | ~50-80 MB |
| Startup time | 3-5s | 1-2s |

---

## 8. Migration Strategy

### Phase Approach
Matches `PARITY_CHECKLIST.md` (400+ items):

| Phase | Focus | Approach |
|-------|-------|----------|
| 0 | Repo Discovery | **Complete** - Full architecture mapping |
| 1 | Tauri Scaffold | **In Progress** - Project structure + IPC adapter |
| 2 | UI Parity | Copy/reuse renderer components via electron-compat shim |
| 3 | Feature Parity | Implement Rust commands for core POS flows |
| 4 | Offline/Sync | Rust sync engine with exponential backoff queue |
| 5 | Backend Compat | Match existing API contracts, adapter layer |
| 6 | Packaging | Windows NSIS installer, auto-updater |

### IPC Migration Path

**Step 1 (Now):** electron-compat shim lets existing components work unchanged
```typescript
// Existing code works as-is:
window.electron.ipcRenderer.invoke('auth:login', { pin });
```

**Step 2 (Gradual):** New code uses typed PlatformBridge
```typescript
import { getBridge } from './lib';
const bridge = getBridge();
await bridge.auth.login({ pin: '1234' });
```

**Step 3 (Eventually):** Remove compat shim, all code uses typed bridge

### Shared Code
- Types from `pos-system/src/shared/` can be reused directly
- i18n locale files (`en.json`, `el.json`) shared between both apps
- Design tokens (Tailwind config, CSS custom properties) shared

---

## 9. SQLite Schema

17 tables in 3 categories, matching Electron POS exactly:

### Local-Only Tables (9)
- `orders` - Orders with sync_status, versioning, conflict resolution, routing fields
- `payment_transactions` - FK → orders(id) CASCADE
- `payment_receipts` - FK → payment_transactions(id) CASCADE
- `payment_refunds` - FK → payment_transactions(id) CASCADE
- `sync_queue` - Pending sync operations with exponential backoff
- `order_sync_conflicts` - Version conflict tracking
- `order_retry_queue` - Failed orders for retry
- `local_settings` - Key-value settings (category + key)
- `pos_local_config` - Per-terminal config

### Supabase Cache Tables (3)
- `staff` - Staff data synced from Supabase
- `subcategories_cache` - Menu items for offline resolution
- `terminal_settings` - Terminal config from Supabase

### Hybrid Tables (6)
- `staff_sessions` - Login sessions
- `staff_shifts` - Shift tracking (cashier/driver/etc)
- `cash_drawer_sessions` - Cash drawer management
- `shift_expenses` - Expenses during shifts
- `driver_earnings` - Per-delivery driver earnings
- `staff_payments` - Wage/tip payments

### Database Configuration
```sql
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA cache_size = 1000;
PRAGMA foreign_keys = ON;
```

---

## 10. Hardware Integrations

### Receipt Printer
- **Protocol**: ESC/POS over TCP (network printers) and USB
- **Encoding**: Greek character support (CP737, CP1253, UTF-8)
- **Rust crate**: Custom ESC/POS encoder (port from `@point-of-sale/receipt-printer-encoder`)
- **Discovery**: Network scanning (mDNS/Bonjour), system printer enumeration
- **Queue**: Job queue with priority (receipts > labels)

### Cash Drawer
- Connected to receipt printer
- ESC/POS kick command (`ESC p 0 25 250`)
- Triggered via `printer:open-cash-drawer` command

### ECR (Payment Terminals)
- Device discovery, connect/disconnect
- Payment processing, refunds, voids, settlement
- Serial/TCP communication
- Transaction history tracking

### Barcode Scanner
- USB HID input (keyboard emulation)
- Handled in renderer via `BarcodeScannerProvider` context
- No Rust-side integration needed
