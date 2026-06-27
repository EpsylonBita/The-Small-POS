import React, { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from 'react-i18next';
import { useTheme } from '../contexts/theme-context';
import { useShift } from '../contexts/shift-context';
import { useModules } from '../contexts/module-context';
import { isModuleComingSoon } from '../../shared/constants/pos-modules';
import { resolveNavigationLabel } from '../utils/i18nLabels';
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

const NAVIGATION_DRAG_HOLD_MS = 280;
const NAVIGATION_DRAG_SCROLL_CANCEL_THRESHOLD_PX = 8;
const NAVIGATION_ORDER_STORAGE_PREFIX = 'pos-navigation-module-order';
// Round 302: base focus reset shared by every sidebar icon button -- the native focus rectangle is ALWAYS
// removed (it lingered after a pointer/touch tap and read like a selected state on this touchscreen POS).
// The yellow keyboard ring is appended IN-COMPONENT only while keyboard modality is active (see
// sidebarFocusRing below); `rounded-xl` just shapes that ring (the icon buttons have no background, so the
// inactive/active icon appearance is unchanged). No hover.
const SIDEBAR_FOCUS_BASE = 'rounded-xl focus:outline-none';
const SIDEBAR_FOCUS_RING_KEYBOARD = `${SIDEBAR_FOCUS_BASE} focus-visible:ring-2 focus-visible:ring-yellow-400/70`;

interface NavigationDragSession {
  pointerId: number;
  pointerType: string;
  moduleId: string;
  startX: number;
  startY: number;
  offsetX: number;
  offsetY: number;
  insertIndex: number;
  holdTimer: number | null;
  isDragging: boolean;
  isScrolling: boolean;
  scrollStartTop: number;
  originalOrder: string[];
}

const areStringArraysEqual = (first: string[], second: string[]) => {
  if (first.length !== second.length) {
    return false;
  }

  return first.every((value, index) => value === second[index]);
};

// Round 236 (Orders hub IA migration): tables, rooms, and appointments/services are now reached
// through the Orders order-taking hub (tabs + New Order modal), so they are hidden from the
// primary navigation rail. The underlying pages, routes, and route guards are untouched and remain
// reachable for direct/internal rendering and tests.
const HUB_MIGRATED_NAV_IDS = new Set<string>([
  'tables',
  'rooms',
  'appointments',
  'services',
  'service_catalog',
]);

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
  const { navigationModules: rawNavigationModules, isLoading } = useModules();
  // Hide the hub-migrated modules from the rail (Round 236). Everything downstream
  // (ordering, drag-reorder, render) consumes this filtered list.
  const navigationModules = useMemo(
    () => rawNavigationModules.filter((navModule) => !HUB_MIGRATED_NAV_IDS.has(navModule.module.id)),
    [rawNavigationModules],
  );

  // State for upgrade modal
  const [showUpgradeModal, setShowUpgradeModal] = useState(false);
  const [selectedLockedModule, setSelectedLockedModule] = useState<{ moduleId: string; requiredPlan: string } | null>(null);
  const [moduleOrder, setModuleOrder] = useState<string[]>([]);
  const [draggingModuleId, setDraggingModuleId] = useState<string | null>(null);
  const [dragInsertIndex, setDragInsertIndex] = useState<number | null>(null);
  const [dragPosition, setDragPosition] = useState<{ x: number; y: number } | null>(null);
  const railRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const suppressClickRef = useRef(false);
  const moduleOrderRef = useRef<string[]>([]);
  const moduleButtonRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const dragSessionRef = useRef<NavigationDragSession | null>(null);
  const [availableHeight, setAvailableHeight] = useState<number | null>(null);
  const [canScrollUp, setCanScrollUp] = useState(false);
  const [canScrollDown, setCanScrollDown] = useState(false);
  // Round 302 correction: input-modality guard. `:focus-visible` alone was not enough -- when a modal's
  // close X is tapped (pointer) and focus returns to the opener sidebar button via .focus(), Chromium's
  // focus-visible heuristic could still paint the yellow ring, so a tapped-then-closed control looked
  // selected. We track keyboard vs pointer modality at the window level (capture phase, so a pointerdown
  // -- including the modal close tap -- flips to pointer modality BEFORE focus returns) and only attach the
  // yellow keyboard ring class while keyboard modality is active. focus:outline-none stays on always.
  const [keyboardMode, setKeyboardMode] = useState(false);

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

  // Keep the active module fully inside the rounded rail. After logging out and
  // back in, the scroll container can preserve a previous scrollTop, leaving the
  // selected icon clipped/floating at the top edge. When the current view
  // changes or the module list/order settles (e.g. after login), nudge the rail
  // by the minimum amount so the active button is fully visible. This only moves
  // the rail's own scrollTop (never the page) and never runs while dragging, so
  // it does not disturb drag/reorder.
  useEffect(() => {
    if (draggingModuleId) {
      return;
    }
    const container = scrollContainerRef.current;
    const activeButton = moduleButtonRefs.current[currentView];
    if (!container || !activeButton) {
      return;
    }
    const containerRect = container.getBoundingClientRect();
    const buttonRect = activeButton.getBoundingClientRect();
    const margin = 8;
    if (buttonRect.top < containerRect.top + margin) {
      container.scrollTop -= (containerRect.top + margin) - buttonRect.top;
    } else if (buttonRect.bottom > containerRect.bottom - margin) {
      container.scrollTop += buttonRect.bottom - (containerRect.bottom - margin);
    }
  }, [currentView, orderedNavigationModules, draggingModuleId]);

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

  // Scroll affordance (round 232): the module list scrolls with a hidden scrollbar, so on a touchscreen
  // there is no visible hint that more icons exist above/below the fold (e.g. Παραγγελίες scrolled out of
  // view). Track whether the module-scroll region can scroll up/down and show small fade caps accordingly.
  // Updates on scroll and whenever the module list/order, available height, or current view changes --
  // each of those can change the scroll geometry.
  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) {
      return;
    }
    const updateScrollHints = () => {
      const { scrollTop, scrollHeight, clientHeight } = container;
      const threshold = 4;
      setCanScrollUp(scrollTop > threshold);
      setCanScrollDown(scrollTop + clientHeight < scrollHeight - threshold);
    };
    updateScrollHints();
    container.addEventListener('scroll', updateScrollHints, { passive: true });
    return () => container.removeEventListener('scroll', updateScrollHints);
  }, [currentView, orderedNavigationModules, availableHeight]);

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

  // EXCEPTION to the white/black/grey/yellow palette: navigation icons keep a
  // distinct per-module neon identity (supervisor-approved). Stable per module id
  // so colors don't shift when modules are added/removed.
  const getModuleColor = (moduleId: string, category: string): string => {
    const moduleColorMap: Record<string, string> = {
      dashboard: 'blue',
      orders: 'blue',
      menu: 'green',
      users: 'orange',
      subscription: 'purple',
      settings: 'green',
      tables: 'orange',
      reservations: 'purple',
      rooms: 'blue',
      housekeeping: 'green',
      guest_billing: 'purple',
      appointments: 'purple',
      staff_schedule: 'orange',
      service_catalog: 'green',
      drive_through: 'orange',
      kiosk: 'green',
      delivery_zones: 'purple',
      analytics: 'purple',
      reports: 'blue',
      customer_web: 'green',
      customer_app: 'blue',
      loyalty: 'purple',
      plugin_integrations: 'green',
      kitchen_display: 'orange',
    };

    if (moduleColorMap[moduleId]) {
      return moduleColorMap[moduleId];
    }
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
    setDraggingModuleId(session.moduleId);
    session.insertIndex = findModuleInsertIndex(session.moduleId, session.startY);
    setDragInsertIndex(session.insertIndex);
    setDragPosition({
      x: session.startX - session.offsetX,
      y: session.startY - session.offsetY,
    });
  };

  const scrollNavigationFromPointer = (session: NavigationDragSession, clientY: number) => {
    const scrollContainer = scrollContainerRef.current;
    if (!scrollContainer) {
      return false;
    }

    const deltaY = clientY - session.startY;
    const maxScrollTop = scrollContainer.scrollHeight - scrollContainer.clientHeight;
    scrollContainer.scrollTop = Math.max(0, Math.min(session.scrollStartTop - deltaY, maxScrollTop));
    return true;
  };

  const handleModulePointerDown = (moduleId: string) => (event: React.PointerEvent<HTMLButtonElement>) => {
    if (event.pointerType === 'mouse' && event.button !== 0) {
      return;
    }

    const rect = event.currentTarget.getBoundingClientRect();
    const session: NavigationDragSession = {
      pointerId: event.pointerId,
      pointerType: event.pointerType,
      moduleId,
      startX: event.clientX,
      startY: event.clientY,
      offsetX: event.clientX - rect.left,
      offsetY: event.clientY - rect.top,
      insertIndex: moduleOrderRef.current.indexOf(moduleId),
      holdTimer: null,
      isDragging: false,
      isScrolling: false,
      scrollStartTop: scrollContainerRef.current?.scrollTop ?? 0,
      originalOrder: moduleOrderRef.current,
    };

    session.holdTimer = window.setTimeout(() => {
      if (dragSessionRef.current === session && !session.isScrolling) {
        beginModuleDrag(session);
      }
    }, NAVIGATION_DRAG_HOLD_MS);

    dragSessionRef.current = session;
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const cancelPendingModuleDrag = (event: React.PointerEvent<HTMLButtonElement>) => {
    const session = dragSessionRef.current;
    if (!session || session.pointerId !== event.pointerId || session.isDragging) {
      return;
    }

    clearDragHoldTimer(session);
    dragSessionRef.current = null;

    try {
      event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {
      // Pointer capture may already be released by native scrolling.
    }
  };

  const handleModulePointerMove = (event: React.PointerEvent<HTMLButtonElement>) => {
    const session = dragSessionRef.current;
    if (!session || session.pointerId !== event.pointerId) {
      return;
    }

    if (session.isScrolling) {
      event.preventDefault();
      event.stopPropagation();
      scrollNavigationFromPointer(session, event.clientY);
      return;
    }

    if (!session.isDragging) {
      const deltaX = event.clientX - session.startX;
      const deltaY = event.clientY - session.startY;
      const movement = Math.hypot(deltaX, deltaY);

      if (movement > NAVIGATION_DRAG_SCROLL_CANCEL_THRESHOLD_PX) {
        clearDragHoldTimer(session);

        if (
          session.pointerType !== 'mouse' &&
          Math.abs(deltaY) >= Math.abs(deltaX) &&
          scrollNavigationFromPointer(session, event.clientY)
        ) {
          session.isScrolling = true;
          event.preventDefault();
          event.stopPropagation();
          return;
        }

        cancelPendingModuleDrag(event);
      }
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

    if (session.isScrolling) {
      event.preventDefault();
      event.stopPropagation();
      suppressClickRef.current = true;
      window.setTimeout(() => {
        suppressClickRef.current = false;
      }, 0);
    } else if (session.isDragging) {
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

  const handleClickCapture = (event: React.MouseEvent<HTMLDivElement>) => {
    if (!suppressClickRef.current) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    suppressClickRef.current = false;
  };



  // Active nav icon shows its distinct neon color (palette exception). Arbitrary hex
  // is used for blue/orange/purple so the global Tailwind palette remap (which folds
  // those families to grey/amber) does not neutralise the neon identity. Inactive
  // stays neutral — no hover dependency, tap/active feedback handled on the button.
  // Inactive icons are neutral: black in light theme, a dark-safe neutral zinc/grey in
  // dark theme. ONLY the active/selected route shows its distinct neon color + glow.
  // Arbitrary hex is used for blue/orange/purple so the global palette remap (blue→grey,
  // orange→amber, purple→grey) cannot neutralize the active neon; inactive stays
  // black/grey. No hover dependency — tap/active feedback is on the button (`active:scale-95`).
  const getNeonClass = (color: string, isActive: boolean, theme: string) => {
    if (!isActive) {
      // Inactive unlocked icons are quiet neutral: black in light, a dark-safe neutral grey in dark
      // (NOT white-neon, and NOT literal black which is invisible on the black rail). Only the
      // active/current route gets the per-module neon color + glow below.
      return theme === 'dark' ? 'text-zinc-400' : 'text-black';
    }
    switch (color) {
      case 'green':
        return 'text-green-500 drop-shadow-[0_0_10px_rgba(34,197,94,0.9)]';
      case 'purple':
        return 'text-[#a855f7] drop-shadow-[0_0_10px_rgba(168,85,247,0.9)]';
      case 'orange':
        return 'text-[#f97316] drop-shadow-[0_0_10px_rgba(251,146,60,0.9)]';
      case 'yellow':
        return 'text-yellow-500 drop-shadow-[0_0_10px_rgba(234,179,8,0.9)]';
      case 'blue':
      default:
        return 'text-[#3b82f6] drop-shadow-[0_0_10px_rgba(59,130,246,0.9)]';
    }
  };

  // Window-level modality tracking (capture phase): a keydown means keyboard navigation (show the ring); a
  // pointerdown anywhere -- including a tap on a modal's close X -- means pointer/touch (hide the ring), and
  // capture runs before the modal's onClose returns focus to the opener button, so the ring class is gone
  // before focus lands. The yellow ring is therefore attached only in keyboard modality; the native outline
  // reset stays on always.
  useEffect(() => {
    const onKeyDown = () => setKeyboardMode(true);
    const onPointerDown = () => setKeyboardMode(false);
    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('pointerdown', onPointerDown, true);
    return () => {
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('pointerdown', onPointerDown, true);
    };
  }, []);
  const sidebarFocusRing = keyboardMode ? SIDEBAR_FOCUS_RING_KEYBOARD : SIDEBAR_FOCUS_BASE;


  return (
    <div
      ref={railRef}
      className="pointer-events-none absolute left-0 top-4 z-50 h-[calc(100%-2rem)] transition-all duration-300 sm:top-6 sm:h-[calc(100%-3rem)] md:top-8 md:h-[calc(100%-4rem)] lg:top-12 lg:h-[calc(100%-6rem)]"
    >
      {/* Theme-aware Sidebar */}
      <div
        className="pointer-events-auto relative max-h-full"
        style={{ maxHeight: availableHeight ?? undefined, touchAction: 'pan-y' }}
        onClickCapture={handleClickCapture}
      >
        <div className={`${resolvedTheme === 'dark'
          ? 'bg-black backdrop-blur-xl rounded-r-3xl p-4 shadow-[0_8px_32px_0_rgba(255,221,0,0.6)] border-r border-amber-400/25'
          : 'bg-white/90 backdrop-blur-xl rounded-r-3xl p-4 shadow-[0_8px_32px_0_rgba(255,221,0,0.34)] border-r border-amber-200/70'} flex max-h-full flex-col overflow-hidden`}
          style={{
            maxHeight: availableHeight ?? undefined,
          }}>
          <nav className="flex min-h-0 flex-1 select-none flex-col gap-4">
            {/* Top persistent action area: Check In stays reachable without scrolling the module list. */}
            <div data-navigation-top-actions className="flex shrink-0 flex-col gap-4">
              {/* Divider */}
              <div className="w-8 h-px mx-auto bg-gradient-to-r from-transparent via-amber-400/60 to-transparent"></div>

              {/* Check In Button - Always shows staff list */}
              <button
                onClick={onStartShift}
                data-testid="check-in-btn"
                className={`w-12 h-12 flex items-center justify-center transition-transform active:scale-95 ${sidebarFocusRing} ${getNeonClass('yellow', false, resolvedTheme)}`}
                aria-label={t('navigation.checkIn')}
              >
                <Clock className="w-5 h-5" strokeWidth={2} />
              </button>

              {/* Divider */}
              <div className="w-8 h-px mx-auto bg-gradient-to-r from-transparent via-amber-400/60 to-transparent"></div>
            </div>

            {/* Module scroll region: ONLY the module list scrolls/drags; the utility actions below stay
                pinned. scrollContainerRef + the active-module auto-scroll target THIS region, not the rail.
                The relative affordance frame hosts the top/bottom scroll-hint caps (round 232; round 299
                dropped the standalone amber pill) -- a subtle neutral edge fade when there is more module
                list to scroll to, with no coloured dash that could read like an inactive nav item. */}
            <div data-navigation-scroll-affordance className="relative flex min-h-0 flex-1 flex-col">
              {/* Top scroll affordance: only when the module list can scroll up. Decorative only
                  (pointer-events-none + aria-hidden) so it never blocks taps or pollutes accessibility. */}
              {canScrollUp && (
                <div
                  aria-hidden="true"
                  data-navigation-scroll-hint-top
                  className={`pointer-events-none absolute inset-x-0 top-0 z-10 h-7 rounded-t-2xl bg-gradient-to-b ${resolvedTheme === 'dark' ? 'from-black via-black/75 to-transparent' : 'from-white via-white/75 to-transparent'}`}
                />
              )}
            <div
              data-navigation-module-scroll
              ref={scrollContainerRef}
              className="flex min-h-0 flex-1 select-none flex-col gap-4 overflow-y-auto overflow-x-hidden touch-pan-y scrollbar-hide"
              style={{
                scrollbarWidth: 'none',
                msOverflowStyle: 'none',
                WebkitOverflowScrolling: 'touch',
              }}
            >
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
                const moduleLabel = resolveNavigationLabel(t, module.id, module.name);

                // Accessible label for locked, coming soon, or unlocked modules. Used as aria-label
                // only - no native title tooltip, since the POS is touchscreen-first.
                let accessibleLabel: string;
                if (isComingSoon) {
                  accessibleLabel = t('modules.comingSoon', {
                    module: moduleLabel,
                    defaultValue: `${module.name} - Coming Soon`
                  });
                } else if (isLocked && requiredPlan) {
                  accessibleLabel = t('modules.lockedModule', {
                    module: moduleLabel,
                    plan: requiredPlan,
                    defaultValue: `${module.name} - Requires ${requiredPlan} plan`
                  });
                } else if (isActive) {
                  // Bake the current-page state into the accessible NAME: the Windows UIA tree did not
                  // surface aria-current as a state for these buttons, so the name itself announces it.
                  accessibleLabel = t('navigation.currentPage', {
                    label: moduleLabel,
                    defaultValue: '{{label}} — Current page',
                  });
                } else {
                  accessibleLabel = moduleLabel;
                }

                // Handle click for coming soon modules
                const handleClick = () => {
                  if (isComingSoon) {
                    // Coming soon modules are not clickable - they stay disabled with an
                    // accessible label (aria-label), no tooltip.
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
                    className={`relative w-12 h-12 flex items-center justify-center transition-transform duration-150 ease-out active:scale-95 ${sidebarFocusRing} ${isComingSoon
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
                    aria-label={accessibleLabel}
                    aria-current={isActive ? 'page' : undefined}
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
            </div>
              {/* Bottom scroll affordance: only when the module list can scroll down. Decorative only
                  (pointer-events-none + aria-hidden). */}
              {canScrollDown && (
                <div
                  aria-hidden="true"
                  data-navigation-scroll-hint-bottom
                  className={`pointer-events-none absolute inset-x-0 bottom-0 z-10 h-7 rounded-b-2xl bg-gradient-to-t ${resolvedTheme === 'dark' ? 'from-black via-black/75 to-transparent' : 'from-white via-white/75 to-transparent'}`}
                />
              )}
            </div>

            {/* Bottom persistent utility cluster: Z Report (global close-day/report utility), Settings,
                and Logout stay reachable without scrolling the module list. */}
            <div data-navigation-utility-actions className="flex shrink-0 flex-col gap-4">
          {/* Z Report Button */}
          <button
            onClick={handleOpenZ}
            className={`relative w-12 h-12 flex items-center justify-center transition-transform active:scale-95 ${sidebarFocusRing} ${getNeonClass('yellow', !!isZReportOpen, resolvedTheme)}`}
            aria-label={t('navigation.zReport')}
          >
            <span className="font-bold text-base">Z</span>
            {hasPendingLocalSubmit && (
              <span className="absolute -top-1 -right-1 h-3 w-3 rounded-full bg-amber-400 shadow-[0_0_10px_rgba(251,191,36,0.8)]" />
            )}
          </button>

          {/* Settings Button */}
          <button
            onClick={handleOpenSettings}
            className={`w-12 h-12 flex items-center justify-center transition-transform active:scale-95 ${sidebarFocusRing} ${getNeonClass('yellow', false, resolvedTheme)}`}
            aria-label={t('navigation.settings')}
          >
            <Settings className="w-5 h-5" />
          </button>

          {/* Divider */}
          <div className="w-8 h-px mx-auto bg-gradient-to-r from-transparent via-amber-400/60 to-transparent"></div>

          {/* Logout Button */}
          <button
            onClick={onLogout}
            className={`w-12 h-12 flex items-center justify-center border border-red-500/70 bg-transparent text-red-500 transition-transform active:scale-95 ${sidebarFocusRing}`}
            aria-label={t('navigation.logout')}>
            <LogOut className="w-5 h-5 text-red-500" strokeWidth={2} />
          </button>
            </div>

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
