import React, { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from 'react-i18next';
import { useTheme } from '../contexts/theme-context';
import { useShift } from '../contexts/shift-context';
import { useModules } from '../contexts/module-context';
import { isModuleComingSoon } from '../../shared/constants/pos-modules';
import {
  Clock,
  LogOut,
  LayoutDashboard,
  ClipboardList,
  BookOpen,
  Package,
  BarChart3,
  Users,
  Building2,
  Settings,
  Car,
  Zap,
  MapPin,
  Utensils,
  Calendar,
  Bed,
  Sparkles,
  Receipt,
  CalendarClock,
  CalendarDays,
  Scissors,
  Globe,
  Smartphone,
  FileText,
  Lock,
  CreditCard,
  Hourglass,
  Truck,
  Link,
  Coffee,
  ShoppingCart,
  Boxes,
  Tag,
  Percent,
  Gift,
  Heart,
  ChefHat,
  UtensilsCrossed,
  Warehouse,
  ScanBarcode,
  Ticket,
  MonitorPlay,
  Award,
  Plug2,
} from 'lucide-react';
import UpgradePromptModal from './modals/UpgradePromptModal';

const NAVIGATION_SWIPE_THRESHOLD_PX = 45;
const NAVIGATION_SWIPE_VERTICAL_LIMIT_PX = 40;
const NAVIGATION_DRAG_HOLD_MS = 280;
const NAVIGATION_ORDER_STORAGE_PREFIX = 'pos-navigation-module-order';

interface NavigationDragSession {
  pointerId: number;
  moduleId: string;
  startX: number;
  startY: number;
  offsetX: number;
  offsetY: number;
  insertIndex: number;
  holdTimer: number | null;
  isDragging: boolean;
  originalOrder: string[];
}

const areStringArraysEqual = (first: string[], second: string[]) => {
  if (first.length !== second.length) {
    return false;
  }

  return first.every((value, index) => value === second[index]);
};

const buildNavigationOrder = (storedOrder: string[], moduleIds: string[]) => {
  const availableIds = new Set(moduleIds);
  const addedIds = new Set<string>();
  const nextOrder: string[] = [];

  for (const moduleId of storedOrder) {
    if (availableIds.has(moduleId) && !addedIds.has(moduleId)) {
      nextOrder.push(moduleId);
      addedIds.add(moduleId);
    }
  }

  for (const moduleId of moduleIds) {
    if (!addedIds.has(moduleId)) {
      nextOrder.push(moduleId);
      addedIds.add(moduleId);
    }
  }

  return nextOrder;
};

const moveNavigationIdToIndex = (order: string[], draggedId: string, targetIndex: number) => {
  const sourceIndex = order.indexOf(draggedId);

  if (sourceIndex === -1) {
    return order;
  }

  const nextOrder = order.filter((moduleId) => moduleId !== draggedId);
  const boundedIndex = Math.max(0, Math.min(targetIndex, nextOrder.length));
  nextOrder.splice(boundedIndex, 0, draggedId);

  if (areStringArraysEqual(order, nextOrder)) {
    return order;
  }

  return nextOrder;
};

interface NavigationSidebarProps {
  currentView: string;
  onViewChange: (view: string) => void;
  onLogout: () => void;
  onEndShift?: () => void;
  onStartShift?: () => void;
  onOpenZReport?: () => void;
  isZReportOpen?: boolean;
  hasPendingLocalSubmit?: boolean;
  onOpenSettings?: () => void;
}

const NavigationSidebar: React.FC<NavigationSidebarProps> = ({
  currentView,
  onViewChange,
  onLogout,
  // onEndShift - currently unused, kept in props for future use
  onStartShift,
  onOpenZReport,
  isZReportOpen,
  hasPendingLocalSubmit = false,
  onOpenSettings
}) => {
  const { t } = useTranslation();
  const { resolvedTheme } = useTheme();
  const { staff, isShiftActive } = useShift();
  const { navigationModules, isLoading } = useModules();

  // State for upgrade modal
  const [showUpgradeModal, setShowUpgradeModal] = useState(false);
  const [selectedLockedModule, setSelectedLockedModule] = useState<{ moduleId: string; requiredPlan: string } | null>(null);
  const [isCollapsed, setIsCollapsed] = useState(false);
  const [moduleOrder, setModuleOrder] = useState<string[]>([]);
  const [draggingModuleId, setDraggingModuleId] = useState<string | null>(null);
  const [dragInsertIndex, setDragInsertIndex] = useState<number | null>(null);
  const [dragPosition, setDragPosition] = useState<{ x: number; y: number } | null>(null);
  const railRef = useRef<HTMLDivElement>(null);
  const swipeStartRef = useRef<{ x: number; y: number } | null>(null);
  const suppressClickRef = useRef(false);
  const moduleOrderRef = useRef<string[]>([]);
  const moduleButtonRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const dragSessionRef = useRef<NavigationDragSession | null>(null);
  const [availableHeight, setAvailableHeight] = useState<number | null>(null);

  const navigationOrderStorageKey = useMemo(() => {
    const organizationKey = staff?.organizationId ?? 'unknown-organization';
    const terminalKey = staff?.terminalId ?? 'unknown-terminal';
    const staffKey = staff?.staffId ?? 'unknown-staff';

    return `${NAVIGATION_ORDER_STORAGE_PREFIX}:${organizationKey}:${terminalKey}:${staffKey}`;
  }, [staff?.organizationId, staff?.staffId, staff?.terminalId]);

  const navigationModuleIds = useMemo(
    () => navigationModules.map(({ module }) => module.id),
    [navigationModules],
  );

  useEffect(() => {
    let storedOrder: string[] = [];

    try {
      const rawStoredOrder = localStorage.getItem(navigationOrderStorageKey);
      const parsedOrder = rawStoredOrder ? JSON.parse(rawStoredOrder) : [];
      if (Array.isArray(parsedOrder)) {
        storedOrder = parsedOrder.filter((value): value is string => typeof value === 'string');
      }
    } catch (error) {
      console.warn('[NavigationSidebar] Failed to load navigation order:', error);
    }

    const nextOrder = buildNavigationOrder(storedOrder, navigationModuleIds);
    moduleOrderRef.current = nextOrder;
    setModuleOrder((currentOrder) => (
      areStringArraysEqual(currentOrder, nextOrder) ? currentOrder : nextOrder
    ));
  }, [navigationModuleIds, navigationOrderStorageKey]);

  const orderedNavigationModules = useMemo(() => {
    if (moduleOrder.length === 0) {
      return navigationModules;
    }

    const modulesById = new Map(navigationModules.map((navModule) => [navModule.module.id, navModule]));
    const orderedModules = moduleOrder.reduce<typeof navigationModules>((items, moduleId) => {
      const navModule = modulesById.get(moduleId);
      if (navModule) {
        items.push(navModule);
      }
      return items;
    }, []);
    const orderedIds = new Set(orderedModules.map((navModule) => navModule.module.id));
    const newModules = navigationModules.filter((navModule) => !orderedIds.has(navModule.module.id));

    return [...orderedModules, ...newModules];
  }, [moduleOrder, navigationModules]);

  const draggedNavigationModule = useMemo(
    () => orderedNavigationModules.find((navModule) => navModule.module.id === draggingModuleId) ?? null,
    [draggingModuleId, orderedNavigationModules],
  );

  const dropSlotBeforeModuleId = useMemo(() => {
    if (!draggingModuleId || dragInsertIndex === null) {
      return null;
    }

    const orderedIdsWithoutDragged = orderedNavigationModules
      .map((navModule) => navModule.module.id)
      .filter((moduleId) => moduleId !== draggingModuleId);

    return orderedIdsWithoutDragged[dragInsertIndex] ?? '__navigation_drop_end__';
  }, [draggingModuleId, dragInsertIndex, orderedNavigationModules]);

  useEffect(() => {
    moduleOrderRef.current = moduleOrder;
  }, [moduleOrder]);

  useEffect(() => {
    const rail = railRef.current;
    if (!rail) {
      return;
    }

    const updateAvailableHeight = () => {
      setAvailableHeight(rail.clientHeight);
    };

    updateAvailableHeight();

    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', updateAvailableHeight);
      return () => window.removeEventListener('resize', updateAvailableHeight);
    }

    const observer = new ResizeObserver(updateAvailableHeight);
    observer.observe(rail);
    window.addEventListener('resize', updateAvailableHeight);

    return () => {
      observer.disconnect();
      window.removeEventListener('resize', updateAvailableHeight);
    };
  }, []);

  const handleNavClick = (id: string, isLocked: boolean, requiredPlan?: string) => {
    if (id === 'settings') {
      onOpenSettings && onOpenSettings();
      return;
    }

    // Check if module is locked - show upgrade modal regardless of shift state
    if (isLocked && requiredPlan) {
      setSelectedLockedModule({ moduleId: id, requiredPlan });
      setShowUpgradeModal(true);
      return;
    }

    // For unlocked modules, enforce shift requirement
    if (!isShiftActive) {
      onStartShift && onStartShift();
      return;
    }

    onViewChange(id);
  };

  // Navigation modules are precomputed by ModuleContext
  // Already filtered by showInNavigation and sorted by sortOrder

  // Map icon string names to Lucide React components
  const getModuleIcon = (iconName: string) => {
    const iconClass = "w-5 h-5";
    switch (iconName) {
      case 'LayoutDashboard':
        return <LayoutDashboard className={iconClass} strokeWidth={2} />;
      case 'ClipboardList':
        return <ClipboardList className={iconClass} strokeWidth={2} />;
      case 'BookOpen':
        return <BookOpen className={iconClass} strokeWidth={2} />;
      case 'Package':
        return <Package className={iconClass} strokeWidth={2} />;
      case 'Users':
        return <Users className={iconClass} strokeWidth={2} />;
      case 'Building2':
        return <Building2 className={iconClass} strokeWidth={2} />;
      case 'CreditCard':
        return <CreditCard className={iconClass} strokeWidth={2} />;
      case 'Settings':
        return <Settings className={iconClass} strokeWidth={2} />;
      case 'Car':
        return <Car className={iconClass} strokeWidth={2} />;
      case 'Zap':
        return <Zap className={iconClass} strokeWidth={2} />;
      case 'MapPin':
        return <MapPin className={iconClass} strokeWidth={2} />;
      case 'Utensils':
        return <Utensils className={iconClass} strokeWidth={2} />;
      case 'UtensilsCrossed':
        return <UtensilsCrossed className={iconClass} strokeWidth={2} />;
      case 'Calendar':
        return <Calendar className={iconClass} strokeWidth={2} />;
      case 'Bed':
        return <Bed className={iconClass} strokeWidth={2} />;
      case 'Sparkles':
        return <Sparkles className={iconClass} strokeWidth={2} />;
      case 'Receipt':
        return <Receipt className={iconClass} strokeWidth={2} />;
      case 'CalendarClock':
        return <CalendarClock className={iconClass} strokeWidth={2} />;
      case 'CalendarDays':
        return <CalendarDays className={iconClass} strokeWidth={2} />;
      case 'Scissors':
        return <Scissors className={iconClass} strokeWidth={2} />;
      case 'Globe':
        return <Globe className={iconClass} strokeWidth={2} />;
      case 'Smartphone':
        return <Smartphone className={iconClass} strokeWidth={2} />;
      case 'BarChart3':
        return <BarChart3 className={iconClass} strokeWidth={2} />;
      case 'FileText':
        return <FileText className={iconClass} strokeWidth={2} />;
      case 'ShoppingCart':
        return <ShoppingCart className={iconClass} strokeWidth={2} />;
      case 'Truck':
        return <Truck className={iconClass} strokeWidth={2} />;
      case 'Link':
        return <Link className={iconClass} strokeWidth={2} />;
      case 'Coffee':
        return <Coffee className={iconClass} strokeWidth={2} />;
      case 'Boxes':
        return <Boxes className={iconClass} strokeWidth={2} />;
      case 'Tag':
        return <Tag className={iconClass} strokeWidth={2} />;
      case 'Percent':
        return <Percent className={iconClass} strokeWidth={2} />;
      case 'Gift':
        return <Gift className={iconClass} strokeWidth={2} />;
      case 'Heart':
        return <Heart className={iconClass} strokeWidth={2} />;
      case 'ChefHat':
        return <ChefHat className={iconClass} strokeWidth={2} />;
      case 'Warehouse':
        return <Warehouse className={iconClass} strokeWidth={2} />;
      case 'ScanBarcode':
        return <ScanBarcode className={iconClass} strokeWidth={2} />;
      case 'Ticket':
        return <Ticket className={iconClass} strokeWidth={2} />;
      case 'MonitorPlay':
        return <MonitorPlay className={iconClass} strokeWidth={2} />;
      case 'Award':
        return <Award className={iconClass} strokeWidth={2} />;
      case 'Plug2':
        return <Plug2 className={iconClass} strokeWidth={2} />;
      default:
        // Log unknown icons for debugging
        console.warn(`[NavigationSidebar] Unknown icon: ${iconName}, using default`);
        return <Package className={iconClass} strokeWidth={2} />;
    }
  };

  // Get color based on module ID for stable, consistent colors
  // Uses module ID instead of index to prevent color changes when modules are added/removed
  const getModuleColor = (moduleId: string, category: string): string => {
    // Specific color assignments for well-known modules
    const moduleColorMap: Record<string, string> = {
      // Core modules - blue theme
      dashboard: 'blue',
      orders: 'blue',
      menu: 'green',
      users: 'orange',
      subscription: 'purple',
      settings: 'green',

      // Restaurant vertical - warm colors
      tables: 'orange',
      reservations: 'purple',

      // Hotel vertical - cool colors
      rooms: 'blue',
      housekeeping: 'green',
      guest_billing: 'purple',

      // Salon vertical - vibrant colors
      appointments: 'purple',
      staff_schedule: 'orange',
      service_catalog: 'green',

      // Fast-food vertical - energetic colors
      drive_through: 'orange',
      kiosk: 'green',
      delivery_zones: 'purple',

      // Analytics & reporting - professional colors
      analytics: 'purple',
      reports: 'blue',

      // Customer-facing - friendly colors
      customer_web: 'green',
      customer_app: 'blue',

      // Addon modules
      loyalty: 'purple',
      plugin_integrations: 'green',
      kitchen_display: 'orange',
    };

    // Return mapped color or default based on category
    if (moduleColorMap[moduleId]) {
      return moduleColorMap[moduleId];
    }

    // Fallback based on category
    if (category === 'core') return 'blue';
    if (category === 'vertical') return 'orange';
    return 'purple'; // addon
  };



  const handleOpenZ = () => {
    if (!isShiftActive && !hasPendingLocalSubmit) {
      onStartShift && onStartShift();
      return;
    }
    onOpenZReport && onOpenZReport();
  };

  const handleOpenSettings = () => {
    // Allow Settings to be opened even without an active shift
    // This is needed for initial setup (PIN, terminal config, etc.)
    onOpenSettings && onOpenSettings();
  };

  const persistNavigationOrder = (nextOrder: string[]) => {
    try {
      localStorage.setItem(navigationOrderStorageKey, JSON.stringify(nextOrder));
    } catch (error) {
      console.warn('[NavigationSidebar] Failed to save navigation order:', error);
    }
  };

  const findModuleInsertIndex = (draggedModuleId: string, clientY: number) => {
    const orderWithoutDragged = moduleOrderRef.current.filter((moduleId) => moduleId !== draggedModuleId);

    for (let index = 0; index < orderWithoutDragged.length; index += 1) {
      const moduleId = orderWithoutDragged[index];
      const element = moduleButtonRefs.current[moduleId];
      if (!element) {
        continue;
      }

      const rect = element.getBoundingClientRect();
      const centerY = rect.top + rect.height / 2;

      if (clientY < centerY) {
        return index;
      }
    }

    return orderWithoutDragged.length;
  };

  const clearDragHoldTimer = (session: NavigationDragSession) => {
    if (session.holdTimer !== null) {
      window.clearTimeout(session.holdTimer);
      session.holdTimer = null;
    }
  };

  const beginModuleDrag = (session: NavigationDragSession) => {
    session.isDragging = true;
    clearDragHoldTimer(session);
    swipeStartRef.current = null;
    setDraggingModuleId(session.moduleId);
    session.insertIndex = findModuleInsertIndex(session.moduleId, session.startY);
    setDragInsertIndex(session.insertIndex);
    setDragPosition({
      x: session.startX - session.offsetX,
      y: session.startY - session.offsetY,
    });
  };

  const handleModulePointerDown = (moduleId: string) => (event: React.PointerEvent<HTMLButtonElement>) => {
    if (event.pointerType === 'mouse' && event.button !== 0) {
      return;
    }

    const rect = event.currentTarget.getBoundingClientRect();
    const session: NavigationDragSession = {
      pointerId: event.pointerId,
      moduleId,
      startX: event.clientX,
      startY: event.clientY,
      offsetX: event.clientX - rect.left,
      offsetY: event.clientY - rect.top,
      insertIndex: moduleOrderRef.current.indexOf(moduleId),
      holdTimer: null,
      isDragging: false,
      originalOrder: moduleOrderRef.current,
    };

    session.holdTimer = window.setTimeout(() => {
      if (dragSessionRef.current === session) {
        beginModuleDrag(session);
      }
    }, NAVIGATION_DRAG_HOLD_MS);

    dragSessionRef.current = session;
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const handleModulePointerMove = (event: React.PointerEvent<HTMLButtonElement>) => {
    const session = dragSessionRef.current;
    if (!session || session.pointerId !== event.pointerId) {
      return;
    }

    if (!session.isDragging) {
      session.startX = event.clientX;
      session.startY = event.clientY;
      return;
    }

    event.preventDefault();
    event.stopPropagation();

    const insertIndex = findModuleInsertIndex(session.moduleId, event.clientY);
    session.insertIndex = insertIndex;
    setDragInsertIndex(insertIndex);
    setDragPosition({
      x: event.clientX - session.offsetX,
      y: event.clientY - session.offsetY,
    });
  };

  const finishModuleDrag = (event: React.PointerEvent<HTMLButtonElement>, persistOrder: boolean) => {
    const session = dragSessionRef.current;
    if (!session || session.pointerId !== event.pointerId) {
      return;
    }

    clearDragHoldTimer(session);

    if (session.isDragging) {
      event.preventDefault();
      event.stopPropagation();
      suppressClickRef.current = true;
      setDraggingModuleId(null);
      setDragInsertIndex(null);
      setDragPosition(null);

      if (persistOrder) {
        const nextOrder = moveNavigationIdToIndex(session.originalOrder, session.moduleId, session.insertIndex);
        moduleOrderRef.current = nextOrder;
        setModuleOrder(nextOrder);
        persistNavigationOrder(nextOrder);
      } else {
        moduleOrderRef.current = session.originalOrder;
        setModuleOrder(session.originalOrder);
      }

      window.setTimeout(() => {
        suppressClickRef.current = false;
      }, 0);
    }

    dragSessionRef.current = null;

    try {
      event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {
      // Pointer capture may already be released by the browser.
    }
  };

  const handleModulePointerUp = (event: React.PointerEvent<HTMLButtonElement>) => {
    finishModuleDrag(event, true);
  };

  const handleModulePointerCancel = (event: React.PointerEvent<HTMLButtonElement>) => {
    finishModuleDrag(event, false);
  };

  const finishSwipeGesture = (clientX: number, clientY: number) => {
    const start = swipeStartRef.current;
    swipeStartRef.current = null;

    if (!start) {
      return;
    }

    const deltaX = clientX - start.x;
    const deltaY = Math.abs(clientY - start.y);

    if (deltaY > NAVIGATION_SWIPE_VERTICAL_LIMIT_PX || Math.abs(deltaX) < NAVIGATION_SWIPE_THRESHOLD_PX) {
      return;
    }

    setIsCollapsed(deltaX < 0);
    suppressClickRef.current = true;
    window.setTimeout(() => {
      suppressClickRef.current = false;
    }, 0);
  };

  const handleSwipeStart = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.pointerType === 'mouse' && event.button !== 0) {
      return;
    }

    swipeStartRef.current = { x: event.clientX, y: event.clientY };

    const handleWindowPointerUp = (pointerEvent: PointerEvent) => {
      finishSwipeGesture(pointerEvent.clientX, pointerEvent.clientY);
      window.removeEventListener('pointercancel', handleWindowPointerCancel);
    };

    const handleWindowPointerCancel = () => {
      swipeStartRef.current = null;
      window.removeEventListener('pointerup', handleWindowPointerUp);
    };

    window.addEventListener('pointerup', handleWindowPointerUp, { once: true });
    window.addEventListener('pointercancel', handleWindowPointerCancel, { once: true });
  };

  const handleSwipeEnd = (event: React.PointerEvent<HTMLDivElement>) => {
    finishSwipeGesture(event.clientX, event.clientY);
  };

  const handleSwipeCancel = () => {
    swipeStartRef.current = null;
  };

  const handleClickCapture = (event: React.MouseEvent<HTMLDivElement>) => {
    if (!suppressClickRef.current) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    suppressClickRef.current = false;
  };



  const getNeonClass = (color: string, isActive: boolean, theme: string) => {
    if (!isActive) {
      return theme === 'dark' ? 'text-white' : 'text-black';
    }
    switch (color) {
      case 'green':
        return 'text-green-500 drop-shadow-[0_0_10px_rgba(34,197,94,0.9)]';
      case 'purple':
        return 'text-purple-500 drop-shadow-[0_0_10px_rgba(168,85,247,0.9)]';
      case 'orange':
        return 'text-orange-500 drop-shadow-[0_0_10px_rgba(251,146,60,0.9)]';
      case 'blue':
      default:
        return 'text-blue-500 drop-shadow-[0_0_10px_rgba(59,130,246,0.9)]';
    }
  };


  return (
    <div
      ref={railRef}
      className="pointer-events-none absolute left-0 top-4 z-50 h-[calc(100%-2rem)] transition-all duration-300 sm:top-6 sm:h-[calc(100%-3rem)] md:top-8 md:h-[calc(100%-4rem)] lg:top-12 lg:h-[calc(100%-6rem)]"
    >
      {/* Theme-aware Sidebar */}
      <div
        className={`pointer-events-auto relative max-h-full transition-transform duration-300 ease-out will-change-transform ${isCollapsed ? '-translate-x-[calc(100%-0.75rem)]' : 'translate-x-0'}`}
        style={{ maxHeight: availableHeight ?? undefined, touchAction: 'pan-y' }}
        onPointerDown={handleSwipeStart}
        onPointerUp={handleSwipeEnd}
        onPointerCancel={handleSwipeCancel}
        onClickCapture={handleClickCapture}
      >
        <div className={`${resolvedTheme === 'dark'
          ? 'bg-black backdrop-blur-xl rounded-r-3xl p-4 shadow-[0_8px_32px_0_rgba(255,221,0,0.6)] border-r border-amber-400/25'
          : 'bg-white/90 backdrop-blur-xl rounded-r-3xl p-4 shadow-[0_8px_32px_0_rgba(255,221,0,0.34)] border-r border-amber-200/70'} max-h-full overflow-y-auto overflow-x-hidden touch-pan-y scrollbar-hide`}
          style={{
            maxHeight: availableHeight ?? undefined,
            scrollbarWidth: 'none',
            msOverflowStyle: 'none',
            WebkitOverflowScrolling: 'touch',
          }}>
          <nav className="flex select-none flex-col gap-4">
            {/* Divider */}
            <div className="w-8 h-px mx-auto bg-gradient-to-r from-transparent via-amber-400/60 to-transparent"></div>

          {/* Check In Button - Always shows staff list */}
          <button
            onClick={onStartShift}
            data-testid="check-in-btn"
            className={`w-12 h-12 flex items-center justify-center transition-colors ${resolvedTheme === 'dark' ? 'text-white hover:text-amber-300' : 'text-black hover:text-amber-600'}`}
            title={t('navigation.checkIn')}
          >
            <Clock className="w-5 h-5" strokeWidth={2} />
          </button>

          {/* Divider */}
          <div className="w-8 h-px mx-auto bg-gradient-to-r from-transparent via-amber-400/60 to-transparent"></div>

          {/* Navigation Items - Dynamic from ModuleContext */}
          {isLoading ? (
            // Loading skeleton
            <>
              {[1, 2, 3, 4].map((i) => (
                <div
                  key={i}
                  className="w-12 h-12 rounded-xl bg-gray-700/30 animate-pulse"
                />
              ))}
            </>
          ) : (
            <>
              {/* Navigation modules from context - precomputed, filtered, and sorted */}
              {orderedNavigationModules.map((navModule) => {
                const { module, isEnabled, isLocked, requiredPlan } = navModule;
                const isActive = currentView === module.id;
                const color = getModuleColor(module.id, module.category || 'other');
                const isComingSoon = isModuleComingSoon(module.id);
                const isDraggingThisModule = draggingModuleId === module.id;
                const isDraggingAnotherModule = Boolean(draggingModuleId) && !isDraggingThisModule;

                // Different titles for locked, coming soon, or unlocked modules
                let title: string;
                if (isComingSoon) {
                  title = t('modules.comingSoon', {
                    module: t(`navigation.${module.id}`, { defaultValue: module.name }),
                    defaultValue: `${module.name} - Coming Soon`
                  });
                } else if (isLocked && requiredPlan) {
                  title = t('modules.lockedModule', {
                    module: t(`navigation.${module.id}`, { defaultValue: module.name }),
                    plan: requiredPlan,
                    defaultValue: `${module.name} - Requires ${requiredPlan} plan`
                  });
                } else {
                  title = t(`navigation.${module.id}`, { defaultValue: module.name });
                }

                // Handle click for coming soon modules
                const handleClick = () => {
                  if (isComingSoon) {
                    // Coming soon modules are not clickable - just show tooltip
                    return;
                  }
                  handleNavClick(module.id, isLocked, requiredPlan);
                };

                return (
                  <React.Fragment key={module.id}>
                  {dropSlotBeforeModuleId === module.id && (
                    <div className="navigation-drop-slot -my-2 mx-auto h-1 w-8 rounded-full bg-amber-400/85 shadow-[0_0_12px_rgba(250,204,21,0.78)]" />
                  )}
                  <button
                    ref={(element) => {
                      if (element) {
                        moduleButtonRefs.current[module.id] = element;
                      } else {
                        delete moduleButtonRefs.current[module.id];
                      }
                    }}
                    onClick={handleClick}
                    onPointerDown={handleModulePointerDown(module.id)}
                    onPointerMove={handleModulePointerMove}
                    onPointerUp={handleModulePointerUp}
                    onPointerCancel={handleModulePointerCancel}
                    onLostPointerCapture={handleModulePointerCancel}
                    draggable={false}
                    aria-grabbed={isDraggingThisModule}
                    disabled={isComingSoon}
                    className={`relative w-12 h-12 flex items-center justify-center transition-all duration-150 ease-out ${isComingSoon
                        ? `opacity-40 cursor-not-allowed ${resolvedTheme === 'dark' ? 'text-gray-600' : 'text-gray-300'}`
                        : isLocked
                          ? `opacity-60 ${resolvedTheme === 'dark' ? 'text-gray-500' : 'text-gray-400'}`
                          : getNeonClass(color, isActive, resolvedTheme)
                      } ${isComingSoon
                        ? ''
                        : isDraggingThisModule
                          ? resolvedTheme === 'dark'
                            ? 'cursor-grabbing rounded-2xl bg-amber-400/10 opacity-25'
                            : 'cursor-grabbing rounded-2xl bg-amber-100/60 opacity-25'
                          : 'cursor-grab active:cursor-grabbing'
                      } ${isDraggingAnotherModule ? 'duration-150 ease-out' : ''}`}
                    style={{ touchAction: isComingSoon ? 'pan-y' : 'none' }}
                    title={title}
                  >
                    {getModuleIcon(module.icon || 'Package')}
                    {/* Coming Soon badge for unimplemented modules */}
                    {isComingSoon && (
                      <div className="absolute -top-1 -right-1 w-4 h-4 rounded-full bg-blue-600/90 flex items-center justify-center">
                        <Hourglass className="w-2.5 h-2.5 text-white" />
                      </div>
                    )}
                    {/* Lock overlay for locked modules (only if not coming soon) */}
                    {isLocked && !isComingSoon && (
                      <div className="absolute -top-1 -right-1 w-4 h-4 rounded-full bg-gray-800/90 flex items-center justify-center">
                        <Lock className="w-2.5 h-2.5 text-yellow-500" />
                      </div>
                    )}
                  </button>
                  </React.Fragment>
                );
              })}
              {dropSlotBeforeModuleId === '__navigation_drop_end__' && (
                <div className="navigation-drop-slot -my-2 mx-auto h-1 w-8 rounded-full bg-amber-400/85 shadow-[0_0_12px_rgba(250,204,21,0.78)]" />
              )}
            </>
          )}

          {/* Z Report Button */}
          <button
            onClick={handleOpenZ}
            className={`relative w-12 h-12 flex items-center justify-center transition-colors ${getNeonClass('blue', !!isZReportOpen, resolvedTheme)}`}
            title={t('navigation.zReport')}
          >
            <span className="font-bold text-base">Z</span>
            {hasPendingLocalSubmit && (
              <span className="absolute -top-1 -right-1 h-3 w-3 rounded-full bg-amber-400 shadow-[0_0_10px_rgba(251,191,36,0.8)]" />
            )}
          </button>

          {/* Settings Button */}
          <button
            onClick={handleOpenSettings}
            className={`w-12 h-12 flex items-center justify-center transition-colors ${getNeonClass('green', false, resolvedTheme)}`}
            title={t('navigation.settings')}
          >
            <Settings className={`w-5 h-5 ${resolvedTheme === 'dark' ? 'text-white' : 'text-black'}`} />
          </button>

          {/* Divider */}
          <div className="w-8 h-px mx-auto bg-gradient-to-r from-transparent via-amber-400/60 to-transparent"></div>

          {/* Logout Button */}
          <button
            onClick={onLogout}
            className="w-12 h-12 rounded-lg flex items-center justify-center border border-red-500/70 bg-transparent text-red-500"
            title={t('navigation.logout')}>
            <LogOut className="w-5 h-5 text-red-500" strokeWidth={2} />
          </button>

          </nav>
        </div>
      </div>

      {draggingModuleId && dragPosition && draggedNavigationModule && (() => {
        const { module, isLocked } = draggedNavigationModule;
        const color = getModuleColor(module.id, module.category || 'other');
        const isActive = currentView === module.id;
        const isComingSoon = isModuleComingSoon(module.id);

        return (
          <div
            aria-hidden="true"
            className={`navigation-dragging-icon pointer-events-none fixed z-[2147483000] flex h-12 w-12 items-center justify-center rounded-2xl border transition-none ${getNeonClass(color, isActive, resolvedTheme)} ${resolvedTheme === 'dark'
              ? 'border-amber-300/45 bg-black/95 shadow-[0_0_24px_rgba(250,204,21,0.45)]'
              : 'border-amber-300/70 bg-white/95 shadow-[0_0_24px_rgba(250,204,21,0.34)]'
            }`}
            style={{
              left: dragPosition.x,
              top: dragPosition.y,
              touchAction: 'none',
            }}
          >
            {getModuleIcon(module.icon || 'Package')}
            {isComingSoon && (
              <div className="absolute -top-1 -right-1 w-4 h-4 rounded-full bg-blue-600/90 flex items-center justify-center">
                <Hourglass className="w-2.5 h-2.5 text-white" />
              </div>
            )}
            {isLocked && !isComingSoon && (
              <div className="absolute -top-1 -right-1 w-4 h-4 rounded-full bg-gray-800/90 flex items-center justify-center">
                <Lock className="w-2.5 h-2.5 text-yellow-500" />
              </div>
            )}
          </div>
        );
      })()}

      {isCollapsed && (
        <div
          aria-hidden="true"
          className="pointer-events-auto absolute left-0 top-0 z-10 h-full w-10 touch-pan-y"
          style={{ touchAction: 'pan-y' }}
          onPointerDown={handleSwipeStart}
          onPointerUp={handleSwipeEnd}
          onPointerCancel={handleSwipeCancel}
        />
      )}

      {/* Upgrade Prompt Modal */}
      <UpgradePromptModal
        isOpen={showUpgradeModal}
        onClose={() => setShowUpgradeModal(false)}
        moduleId={selectedLockedModule?.moduleId}
        requiredPlan={selectedLockedModule?.requiredPlan}
      />
    </div>
  );
};

export default NavigationSidebar;
