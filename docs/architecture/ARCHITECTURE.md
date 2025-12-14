# POS System Architecture

This document details the architecture of the Electron-based POS system, focusing on process communication, service management, synchronization, and updates.

## Main Process Initialization Flow

The application startup sequence coordinates the initialization of database, services, and IPC handlers before creating the main window.

```mermaid
sequenceDiagram
    participant App as Electron App
    participant Main as main.ts
    participant SR as ServiceRegistry
    participant DB as DatabaseManager
    participant Services as Services Layer
    participant Handlers as IPC Handlers
    participant Window as Main Window
    
    App->>Main: app.whenReady()
    Main->>Handlers: registerAllMainHandlers()
    Main->>DB: initializeDatabase()
    DB-->>Main: dbManager instance
    Main->>SR: register('dbManager', dbManager)
    Main->>Services: initializeServices(dbManager)
    Services->>SR: register all services
    Services-->>Main: services initialized
    Main->>Window: createMainWindow()
    Main->>Handlers: registerAllDomainHandlers()
    Main->>Services: startSync()
    Main->>Services: startHealthChecks()
    Main->>Services: initializeAutoUpdater()
```

## IPC Communication Architecture

The system uses a secure context-bridge pattern to expose Main process capabilities to the Renderer process.

```mermaid
graph LR
    subgraph "Renderer Process (React)"
        UI[Components]
        API[Window.API]
    end
    
    subgraph "Preload Script"
        Bridge[Context Bridge]
        Whitelist[Channel Whitelist]
    end
    
    subgraph "Main Process (Node.js)"
        Router[IPC Main Listener]
        Handlers[Domain Handlers]
        Services[Service Registry]
    end
    
    UI --> API
    API --> Bridge
    Bridge -->|Invoke/Send| Router
    Router -->|Dispatch| Handlers
    Handlers -->|Call| Services
    Services -->|Result| Handlers
    Handlers -->|Response| Bridge
    Bridge -->|Promise Resolve| API
    API --> UI
```

## Service Registry Pattern

The application uses a Service Registry pattern for dependency injection and singleton management.

```mermaid
classDiagram
    class ServiceRegistry {
        -services: Map
        +register(name, service)
        +get(name)
        +clear()
    }
    
    class BaseService {
        #dbManager
        #logger
    }
    
    class OrderService
    class SyncService
    class AuthService
    class InventoryService
    
    ServiceRegistry o-- OrderService
    ServiceRegistry o-- SyncService
    ServiceRegistry o-- AuthService
    ServiceRegistry o-- InventoryService
    
    OrderService --|> BaseService
    SyncService --|> BaseService
    AuthService --|> BaseService
```

## Sync Architecture

The system employs a robust offline-first synchronization strategy.

```mermaid
graph TD
    subgraph "Local POS State"
        Action[User Action]
        Queue[Sync Queue Table]
        LocalDB[SQLite Data]
    end
    
    subgraph "Sync Services"
        SyncSvc[SyncService]
        Retry[Retry Logic]
        NetCheck[Network Monitor]
    end
    
    subgraph "Remote Backend"
        Supabase[Supabase DB]
    end
    
    Action -->|Write| LocalDB
    Action -->|Queued| Queue
    
    Queue -->|Poll/Trigger| SyncSvc
    SyncSvc -->|Check| NetCheck
    NetCheck -->|Online| SyncSvc
    
    SyncSvc -->|Push Changes| Supabase
    Supabase -->|Success| SyncSvc
    SyncSvc -->|Remove| Queue
    
    Supabase -->|Fail| Retry
    Retry -->|Backoff| SyncSvc
```

## Module Integration Flow

Modules are dynamically enabled based on the organization's subscription status (Trial vs Active). The POS verifies the license status before loading module features.

```mermaid
graph LR
    Admin[Admin Dashboard] -->|Manage Subscription| DB[Supabase]
    DB -->|Sync| POS[POS System]
    POS -->|Update Config| LocalConfig[Local Configuration]
    LocalConfig -->|Check License| Valid{Active?}
    Valid -->|Yes| Modules[Load Modules]
    Valid -->|No| Lock[Lock Features]
    Modules -->|Event: modules-updated| UI[Renderer UI]
    UI -->|Conditional Render| Features[Order/Tables/etc]
```

## Database Schema Overview

The local SQLite database mirrors key Supabase tables for offline functionality.

| Table Category | Key Tables |
|----------------|------------|
| **Core** | `users`, `settings`, `sync_queue` |
| **Catalog** | `categories`, `products`, `variations`, `modifiers` |
| **Operations** | `orders`, `order_items`, `payments`, `shifts` |
| **Customers** | `customers`, `addresses` |

## Handler Organization

IPC Handlers are organized by domain to maintain separation of concerns.

| Domain | Handler File | Responsibility |
|--------|--------------|----------------|
| **Auth** | `auth-handlers.ts` | Login, pin verification, user sessions |
| **Orders** | `order-handlers.ts` | Creation, modification, status updates |
| **Menu** | `menu-handlers.ts` | Product fetching, stock updates |
| **Sync** | `sync-handlers.ts` | Manual sync, status checks |
| **System** | `system-handlers.ts` | Hardware, app info, printing |

## Sequence Diagrams

### Menu Sync Flow

```mermaid
sequenceDiagram
    participant Admin as Admin Dashboard
    participant API as Menu API
    participant DB as Supabase
    participant RT as Realtime
    participant POS as POS Main Process
    participant SQLite as Local SQLite
    participant Renderer as POS Renderer
    
    Admin->>API: Update menu item
    API->>DB: UPDATE subcategories
    DB-->>API: Success
    DB->>RT: Broadcast menu:sync
    RT->>POS: WebSocket: menu update
    POS->>SQLite: UPDATE local cache
    POS->>Renderer: IPC: menu:sync event
    Renderer->>Renderer: Refresh menu UI
```

### OTA Update Flow

```mermaid
sequenceDiagram
    participant User as User
    participant Renderer as POS Renderer
    participant Main as Main Process
    participant Updater as AutoUpdaterService
    participant GitHub as GitHub Releases
    participant Installer as Installer
    
    Main->>Updater: startPeriodicChecks()
    Updater->>GitHub: checkForUpdates()
    GitHub-->>Updater: Update available (v2.1.0)
    Updater->>Renderer: IPC: update-available
    Renderer->>User: Show UpdateNotification
    User->>Renderer: Click "Download"
    Renderer->>Updater: IPC: update:download
    Updater->>GitHub: downloadUpdate()
    GitHub-->>Updater: Download progress
    Updater->>Renderer: IPC: download-progress
    Renderer->>User: Show UpdateProgressModal
    Updater->>Renderer: IPC: update-downloaded
    Renderer->>User: Show UpdateReadyModal
    User->>Renderer: Click "Install & Restart"
    Renderer->>Updater: IPC: update:install
    Updater->>Installer: quitAndInstall()
    Installer->>Installer: Install update
    Installer->>Main: Restart app
```
