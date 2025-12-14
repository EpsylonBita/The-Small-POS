# Complete POS System Architecture Documentation

## 🏗️ System Overview
The **Creperie POS System** is a comprehensive **Electron-based desktop application** built with **React + TypeScript**, featuring offline-first capabilities, real-time synchronization, and modern glassmorphism UI design. The system provides complete restaurant management functionality with robust data persistence and customer integration.

## 📋 Technology Stack

### **Core Technologies**
- **Desktop Framework**: Electron 35.7.5
- **Frontend**: React 19.1.0 + TypeScript 5.8.3
- **Bundling**: Webpack 5 with custom configurations
- **Styling**: Tailwind CSS 3.3.6 with custom glassmorphism components
- **Database**: Better-SQLite3 12.4.1 (local) + Supabase (cloud sync)
- **State Management**: Zustand 4.4.7 + Custom hooks
- **Routing**: React Router DOM 6.30.1 (HashRouter)
- **Notifications**: React Hot Toast 2.4.1

### **Development Tools**
- **Build System**: Webpack with separate main/renderer configs
- **Development**: Concurrently for parallel dev servers
- **Code Quality**: ESLint + TypeScript strict mode
- **Packaging**: Electron Builder 24.9.1

## 🏛️ Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│                    CREPERIE POS SYSTEM                     │
├─────────────────────────────────────────────────────────────┤
│  🖥️  MAIN PROCESS (Node.js/Electron)                      │
│  ├── 🗄️  Database Layer (SQLite + Supabase Sync)          │
│  ├── 🔐  Authentication & Security                         │
│  ├── ⚙️  Settings & Configuration Management               │
│  ├── 💳  Payment Processing                                │
│  └── 🔄  Real-time Synchronization                         │
├─────────────────────────────────────────────────────────────┤
│  🎨  RENDERER PROCESS (React/TypeScript)                   │
│  ├── 📱  POS Interface (Order Management)                  │
│  ├── 🍽️  Menu System (Item Selection & Customization)     │
│  ├── 👥  Customer Management (Profiles & Lookup)           │
│  ├── 🎯  Glassmorphism UI Components                       │
│  └── 🔄  Real-time State Management                        │
├─────────────────────────────────────────────────────────────┤
│  🤝  SHARED LAYER                                          │
│  ├── 📡  Supabase Client Configuration                     │
│  ├── 🔗  IPC Communication Protocols                       │
│  └── 📝  Type Definitions & Interfaces                     │
└─────────────────────────────────────────────────────────────┘
```

## 📁 Complete Folder Structure

```
pos-system/
├── 📁 src/
│   ├── 📁 main/                    # Electron Main Process (8 files)
│   │   ├── 🎯 main.ts              # Application entry point (22KB, 689 lines)
│   │   ├── 🗄️  database.ts         # SQLite database manager (33KB, 1069 lines)
│   │   ├── 🔐 auth-service.ts      # Authentication service (10KB, 362 lines)
│   │   ├── 👤 staff-auth-service.ts # Staff authentication (14KB, 555 lines)
│   │   ├── ⚙️  settings-service.ts  # Settings management (18KB, 581 lines)
│   │   ├── 🔄 sync-service.ts      # Data synchronization (11KB, 345 lines)
│   │   ├── 💳 payment-handlers.ts  # Payment processing (12KB, 444 lines)
│   │   └── 🔗 preload.ts           # IPC bridge security (11KB, 249 lines)
│   ├── 📁 renderer/                # React Frontend (15 files)
│   │   ├── 📄 App.tsx              # Main React application (9.1KB, 281 lines)
│   │   ├── 📄 index.tsx            # React DOM entry point (414B, 20 lines)
│   │   ├── 📁 components/          # UI Components (11 files)
│   │   │   ├── 🎯 SimpleMainLayout.tsx    # Main POS interface (32KB, 792 lines)
│   │   │   ├── 📝 CustomerInfoForm.tsx    # Customer data form (16KB, 386 lines)
│   │   │   ├── 🧭 NavigationSidebar.tsx   # Navigation panel (6.4KB, 156 lines)
│   │   │   ├── 📊 OrderTabsBar.tsx        # Order status tabs (2.9KB, 78 lines)
│   │   │   ├── ⚡ BulkActionsBar.tsx      # Bulk operations (6.0KB, 149 lines)
│   │   │   ├── 📋 OrdersSection.tsx       # Orders container (2.5KB, 87 lines)
│   │   │   ├── 💊 OrderPill.tsx           # Order cards (14KB, 359 lines)
│   │   │   ├── 🎨 ThemeSwitcher.tsx       # Theme toggle (898B, 26 lines)
│   │   │   ├── 📦 PlaceholderView.tsx     # Placeholder screens (1.4KB, 40 lines)
│   │   │   ├── 📁 modals/
│   │   │   │   └── 🔍 OrderDetailsModal.tsx # Order details popup (7.8KB, 202 lines)
│   │   │   └── 📁 ui/
│   │   │       └── ✨ pos-glass-components.tsx # Glassmorphism library (15KB, 550 lines)
│   │   ├── 📁 pages/               # Route Pages (2 files)
│   │   │   ├── 🍽️ MenuPage.tsx           # Menu & ordering (38KB, 960 lines)
│   │   │   └── ➕ NewOrderPage.tsx        # Order creation flow (19KB, 500 lines)
│   │   ├── 📁 services/            # Business Logic (1 file)
│   │   │   └── 👥 MCPCustomerService.ts   # Customer operations (3.7KB, 123 lines)
│   │   ├── 📁 hooks/               # React Hooks (1 file)
│   │   │   └── 🛒 useOrderStore.ts        # Order state management (17KB, 498 lines)
│   │   ├── 📁 contexts/            # React Contexts
│   │   │   └── 🎨 theme-context.tsx       # Theme provider
│   │   ├── 📁 types/               # TypeScript Definitions
│   │   │   ├── 🔗 electron.d.ts          # Electron API types
│   │   │   ├── 🗄️  database.ts           # Database types
│   │   │   ├── 🔐 auth.ts                # Authentication types
│   │   │   ├── 🛒 orders.ts              # Order types
│   │   │   └── 🎨 ui.ts                  # UI component types
│   │   ├── 📁 utils/               # Utility Functions
│   │   └── 📁 styles/              # CSS & Styling
│   │       ├── 🎨 globals.css            # Global styles
│   │       └── ✨ glassmorphism.css      # Glassmorphism effects
│   ├── 📁 shared/                  # Shared Resources (1 file)
│   │   └── 📡 supabase.ts          # Supabase client config (3.8KB, 163 lines)
│   └── 📁 types/                   # Global Types (1 file)
│       └── 📝 stagewise.d.ts       # Stagewise plugin types (354B, 16 lines)
├── 📁 public/                      # Static Assets (1 active file)
│   └── 📄 index.html               # Main HTML template (1.8KB, 56 lines)
├── 📁 dist/                        # Built Application
├── 📁 node_modules/                # Dependencies
├── ⚙️  Configuration Files
│   ├── 📄 package.json             # Project configuration (2.8KB, 96 lines)
│   ├── 📄 tsconfig.json            # TypeScript config (759B, 34 lines)
│   ├── 📄 tsconfig.main.json       # Main process TS config (341B, 19 lines)
│   ├── 📄 tsconfig.renderer.json   # Renderer process TS config (400B, 21 lines)
│   ├── 📄 webpack.main.config.js   # Main process webpack (842B, 42 lines)
│   ├── 📄 webpack.renderer.config.js # Renderer webpack (2.4KB, 95 lines)
│   ├── 📄 tailwind.config.js       # Tailwind CSS config (3.5KB, 113 lines)
│   └── 📄 postcss.config.js        # PostCSS config (81B, 6 lines)
└── 📄 ARCHITECTURE.md              # This documentation (9.4KB, 274 lines)
```

## 🔧 Main Process Architecture

### **Core Services**

#### **🎯 main.ts** - Application Entry Point
- **Purpose**: Electron app lifecycle management
- **Key Features**:
  - Window creation and management
  - Service initialization and coordination
  - Development/production environment handling
  - Touch-optimized window settings
  - Security configurations (sandbox, preload)
- **Service Dependencies**: All main process services

#### **🗄️ database.ts** - Data Persistence Layer
- **Purpose**: Local SQLite database management with cloud sync
- **Key Features**:
  - Schema management and migrations
  - CRUD operations for all entities
  - Data validation and integrity
  - Backup and restore functionality
  - Supabase synchronization
- **Tables**: Orders, customers, menu items, staff, settings, payments

#### **🔐 auth-service.ts** - Authentication System
- **Purpose**: User session and security management
- **Key Features**:
  - PIN-based authentication
  - Session management with timeouts
  - Activity tracking
  - Security logging
  - Auto-logout on inactivity

#### **👤 staff-auth-service.ts** - Staff Management
- **Purpose**: Staff-specific authentication and permissions
- **Key Features**:
  - Role-based access control
  - Staff profile management
  - Permission validation
  - Shift tracking
  - Manager overrides

#### **⚙️ settings-service.ts** - Configuration Management
- **Purpose**: Application settings and preferences
- **Key Features**:
  - POS configuration (printers, displays, payments)
  - Menu settings and pricing
  - System preferences
  - Real-time settings sync
  - Backup and restore

#### **🔄 sync-service.ts** - Data Synchronization
- **Purpose**: Real-time data sync with cloud services
- **Key Features**:
  - Bidirectional sync with Supabase
  - Conflict resolution
  - Offline queue management
  - Real-time subscriptions
  - Sync status monitoring

#### **💳 payment-handlers.ts** - Payment Processing
- **Purpose**: Payment transaction management
- **Key Features**:
  - Multiple payment methods
  - Transaction logging
  - Receipt generation
  - Refund processing
  - Payment validation

#### **🔗 preload.ts** - IPC Security Bridge
- **Purpose**: Secure communication between main and renderer
- **Key Features**:
  - Contextual isolation
  - API exposure control
  - Type-safe IPC methods
  - Security validation
  - Error handling

## 🎨 Renderer Process Architecture

### **Application Structure**

#### **📄 App.tsx** - Main Application
- **Purpose**: Root React component with routing
- **Key Features**:
  - Authentication flow management
  - Route configuration
  - Theme provider setup
  - Global error handling
  - Toast notification system

#### **🎯 SimpleMainLayout.tsx** - Main POS Interface
- **Purpose**: Primary POS dashboard and order management
- **Key Features**:
  - Real-time order grid with interactive cards
  - Order status management (pending, preparing, ready, delivered)
  - Bulk operations for multiple orders
  - New order creation with modal flow
  - Navigation between POS sections
  - Customer lookup and management integration

#### **🍽️ MenuPage.tsx** - Menu & Ordering System
- **Purpose**: Menu browsing and item selection
- **Key Features**:
  - Category-based menu filtering
  - Item customization with modifiers
  - Real-time pricing calculations
  - Cart management with totals
  - Customer context integration
  - Glassmorphism design throughout

#### **➕ NewOrderPage.tsx** - Order Creation Flow
- **Purpose**: Guided order creation process
- **Key Features**:
  - Order type selection (pickup/delivery)
  - Customer phone lookup
  - Customer information collection
  - Address validation for delivery
  - Navigation to menu with context

### **Component System**

#### **Navigation & Layout**
- **🧭 NavigationSidebar.tsx**: Left navigation with sections
- **📊 OrderTabsBar.tsx**: Order status filtering tabs
- **📦 PlaceholderView.tsx**: Loading and empty states

#### **Order Management**
- **📋 OrdersSection.tsx**: Responsive order grid container
- **💊 OrderPill.tsx**: Interactive order cards with actions
- **⚡ BulkActionsBar.tsx**: Multi-order operations
- **🔍 OrderDetailsModal.tsx**: Detailed order information

#### **Customer Management**
- **📝 CustomerInfoForm.tsx**: Customer data collection
- **👥 MCPCustomerService.ts**: Customer API integration

#### **UI System**
- **✨ pos-glass-components.tsx**: Glassmorphism component library
- **🎨 ThemeSwitcher.tsx**: Light/dark mode toggle
- **🎨 theme-context.tsx**: Theme state management

### **State Management**

#### **🛒 useOrderStore.ts** - Order State Management
- **Purpose**: Centralized order state with Zustand
- **Key Features**:
  - Order creation and updates
  - Cart management
  - Status transitions
  - Local storage persistence
  - Real-time synchronization

## 🔄 Data Flow Architecture

### **Order Creation Flow**
```
1. SimpleMainLayout (FAB Button)
   ↓
2. OrderTypeModal (Pickup/Delivery Selection)
   ↓
3. PhoneLookupModal (Customer Search) [Delivery Only]
   ↓
4. CustomerInfoModal (Data Collection)
   ↓
5. MenuPage (Item Selection & Customization)
   ↓
6. Order Completion & Database Storage
   ↓
7. Real-time Sync to Cloud
```

### **Data Synchronization Flow**
```
Local SQLite Database ↔ Sync Service ↔ Supabase Cloud
                       ↓
                   Real-time Updates
                       ↓
              React State Management
                       ↓
                UI Component Updates
```

### **Authentication Flow**
```
PIN Entry → Auth Service → Session Creation → Main Interface
    ↓              ↓             ↓              ↓
Activity    Security      Local Storage    Auto-logout
Tracking    Logging       Persistence      on Timeout
```

## 🧩 Module Synchronization & Feature Gating

The POS application is **module-driven** - it queries the Admin Dashboard to discover which modules are enabled and dynamically adjusts its UI and behavior.

### Module Sync Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│                    MODULE SYNCHRONIZATION FLOW                          │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│   MAIN PROCESS                           RENDERER PROCESS               │
│   ────────────                           ────────────────               │
│                                                                         │
│   ┌──────────────────┐                  ┌──────────────────┐           │
│   │ ModuleSyncService│                  │   ModuleContext  │           │
│   │                  │                  │                  │           │
│   │ • fetchModules() │ ──── IPC ────▶  │ • modules[]      │           │
│   │ • cacheModules() │                  │ • hasModule()    │           │
│   │ • scheduleSync() │                  │ • isLoading      │           │
│   └──────────────────┘                  └──────────────────┘           │
│           │                                      │                      │
│           │                                      ▼                      │
│           │                             ┌──────────────────┐           │
│           ▼                             │ useAcquiredModules│           │
│   ┌──────────────────┐                  │                  │           │
│   │  SQLite Cache    │                  │ • hasModule(id)  │           │
│   │ (module_cache)   │                  │ • modules        │           │
│   └──────────────────┘                  └──────────────────┘           │
│                                                  │                      │
│                                                  ▼                      │
│                                          ┌──────────────────┐          │
│                                          │   UI Components  │          │
│                                          │ (conditionally   │          │
│                                          │  rendered)       │          │
│                                          └──────────────────┘          │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

### ModuleSyncService Implementation

The main process service that manages module synchronization:

```typescript
// src/main/services/ModuleSyncService.ts
class ModuleSyncService {
  private adminDashboardUrl: string;
  private terminalId: string;
  private apiKey: string;
  private syncInterval = 5 * 60 * 1000; // 5 minutes

  async fetchEnabledModules(): Promise<POSModulesEnabledResponse> {
    const response = await fetch(
      `${this.adminDashboardUrl}/api/pos/modules/enabled`,
      {
        headers: {
          'x-terminal-id': this.terminalId,
          'x-pos-api-key': this.apiKey,
        },
      }
    );
    return response.json();
  }

  async syncModules(): Promise<void> {
    const data = await this.fetchEnabledModules();
    await this.cacheModules(data.modules);
    this.notifyRenderer(data.modules);
  }

  private async cacheModules(modules: Module[]): Promise<void> {
    await db.run(`
      INSERT OR REPLACE INTO module_cache (data, updated_at)
      VALUES (?, datetime('now'))
    `, [JSON.stringify(modules)]);
  }
}
```

### API Response Format

```typescript
interface POSModulesEnabledResponse {
  success: boolean;
  organization_id: string;
  branch_id: string;
  modules: Array<{
    module_id: string;          // e.g., 'delivery', 'tables'
    name: string;               // Display name
    description: string;        // Module description
    module_type: 'core' | 'vertical' | 'add_on';
    enabled: boolean;           // Purchased by organization
    pos_enabled: boolean;       // Has POS functionality
  }>;
  synced_at: string;           // ISO timestamp
}
```

### Module Context & Hook

```typescript
// src/renderer/contexts/ModuleContext.tsx
interface ModuleContextValue {
  modules: Module[];
  hasModule: (moduleId: string) => boolean;
  isLoading: boolean;
  lastSynced: Date | null;
}

// Usage in components
function OrderTypeSelector() {
  const { hasModule } = useAcquiredModules();

  return (
    <div className="order-types">
      <Button>Pickup</Button>
      {hasModule('tables') && <Button>Dine-in</Button>}
      {hasModule('delivery') && <Button>Delivery</Button>}
      {hasModule('hotel_rooms') && <Button>Room Service</Button>}
    </div>
  );
}
```

### Module-Based Features

| Module ID | Feature | UI Element |
|-----------|---------|------------|
| `delivery` | Delivery orders | Delivery button, driver assignment |
| `tables` | Table management | Tables screen, dine-in button |
| `reservations` | Reservations | Reservations screen |
| `hotel_rooms` | Room service | Rooms screen, room service button |
| `appointments` | Appointments | Appointments screen |

### Offline Behavior

- Modules cached in SQLite for offline access
- UI uses cached modules when offline
- Sync resumes when connection restored
- No feature lockout during temporary offline

## 🎨 Design System

### **Glassmorphism Components**
The system features a comprehensive glassmorphism design library:

- **POSGlassCard**: Translucent containers with backdrop blur
- **POSGlassButton**: Interactive buttons with glass effects
- **POSGlassInput**: Form inputs with transparent styling
- **POSGlassModal**: Modal dialogs with layered blur effects
- **POSGlassContainer**: Layout containers with depth
- **POSGlassBadge**: Status indicators with glass styling

### **Theme System**
- **Light Mode**: Bright glassmorphism with subtle shadows
- **Dark Mode**: Deep glass effects with enhanced contrast
- **Responsive**: Adapts to different screen sizes and orientations
- **Consistent**: Unified styling across all components

## 🔧 Build & Development

### **Development Scripts**
```bash
npm run dev          # Start both main and renderer in development
npm run dev:main     # Main process development with watch
npm run dev:renderer # Renderer process with webpack dev server
npm run build        # Production build for both processes
npm run start        # Start the built Electron app
npm run pack         # Package app for current platform
npm run dist         # Create distributable packages
```

### **Webpack Configuration**
- **Main Process**: `webpack.main.config.js` - Node.js target
- **Renderer Process**: `webpack.renderer.config.js` - Web target with React

### **TypeScript Configuration**
- **Root**: `tsconfig.json` - Global TypeScript settings
- **Main**: `tsconfig.main.json` - Node.js specific settings
- **Renderer**: `tsconfig.renderer.json` - DOM and React settings

## 🔒 Security Features

### **Electron Security**
- **Contextual Isolation**: Enabled for security
- **Sandbox Mode**: Renderer process sandboxed
- **Preload Script**: Secure IPC communication
- **Node Integration**: Disabled in renderer
- **External Link Handling**: Opens in default browser

### **Authentication Security**
- **PIN-based Authentication**: Simple but secure
- **Session Management**: Automatic timeout
- **Activity Tracking**: User interaction monitoring
- **Security Logging**: Authentication attempts logged

## 📊 Performance Optimizations

### **Bundle Size Optimization**
- **Removed 24 unused files** (reduced ~400KB)
- **Tree-shaking enabled** for unused code elimination
- **Code splitting** for route-based loading
- **Dynamic imports** for heavy components

### **Database Performance**
- **SQLite optimization** with proper indexing
- **Batch operations** for bulk updates
- **Connection pooling** for concurrent access
- **Query optimization** with prepared statements

### **UI Performance**
- **React optimization** with memo and callbacks
- **Efficient re-renders** with proper state management
- **Lazy loading** for heavy components
- **Debounced inputs** for search and filters

## 🧪 Testing Strategy

### **Component Testing**
- **Unit tests** for individual components
- **Integration tests** for component interactions
- **Snapshot tests** for UI consistency
- **Accessibility tests** for usability

### **E2E Testing**
- **Order creation flow** testing
- **Payment processing** validation
- **Data synchronization** testing
- **Cross-platform** compatibility

## 📈 Monitoring & Analytics

### **Performance Monitoring**
- **Bundle size tracking** with webpack-bundle-analyzer
- **Memory usage** monitoring
- **Database query performance** tracking
- **Sync operation** timing

### **Error Handling**
- **Global error boundaries** for React components
- **IPC error handling** with proper fallbacks
- **Database error recovery** with transactions
- **User-friendly error messages** with toast notifications

## 🚀 Deployment

### **Build Process**
1. **TypeScript Compilation**: Main and renderer processes
2. **Webpack Bundling**: Optimized production builds
3. **Asset Processing**: Images, styles, and static files
4. **Electron Packaging**: Platform-specific applications

### **Distribution**
- **Windows**: NSIS installer with auto-updater
- **Cross-platform**: Electron Builder configuration
- **Auto-updates**: Electron updater integration
- **Code signing**: Security certificates for trust

---

## 📋 Recent Cleanup Summary

### **Files Removed (24 total)**
- **Components**: 16 unused React components
- **Pages**: 2 demo/test pages  
- **Services**: 5 redundant service files
- **Hooks**: 4 unused custom hooks

### **Files Cleaned (3 total)**
- **Test HTML files**: Removed development-only HTML files
- **Component exports**: Updated index.ts to remove broken imports
- **Dependencies**: Cleaned up unused service dependencies

### **Result**
- **Cleaner codebase** with focused functionality
- **Reduced bundle size** by approximately 400KB
- **Improved maintainability** with fewer files to manage
- **Better performance** with optimized imports and exports

---

---

## Cross-References

- [Module System](../../../docs/13-MODULE-SYSTEM.md) - Complete module marketplace documentation
- [Integration Architecture](../../../docs/14-INTEGRATION-ARCHITECTURE.md) - Cross-app integration
- [Admin Dashboard Architecture](../../../admin-dashboard/docs/02-architecture/ARCHITECTURE.md) - API provider
- [Landing Architecture](../../../Landing/docs/02-ARCHITECTURE.md) - Super Admin Console

---

*Last Updated: December 2025*
*Architecture Version: 2.0 (Module-Driven)*
*Total Lines of Code: ~8,500 (active files only)* 