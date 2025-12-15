import React, { useState } from "react";
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
} from 'lucide-react';
import UpgradePromptModal from './modals/UpgradePromptModal';

interface NavigationSidebarProps {
  currentView: string;
  onViewChange: (view: string) => void;
  onLogout: () => void;
  onEndShift?: () => void;
  onStartShift?: () => void;
  onOpenZReport?: () => void;
  isZReportOpen?: boolean;
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
  onOpenSettings
}) => {
  const { t } = useTranslation();
  const { resolvedTheme } = useTheme();
  const { isShiftActive } = useShift();
  const { navigationModules, isLoading } = useModules();
  
  // State for upgrade modal
  const [showUpgradeModal, setShowUpgradeModal] = useState(false);
  const [selectedLockedModule, setSelectedLockedModule] = useState<{ moduleId: string; requiredPlan: string } | null>(null);

  const handleNavClick = (id: string, isLocked: boolean, requiredPlan?: string) => {
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
      branches: 'purple',
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
      quick_pos: 'green',
      delivery_zones: 'purple',

      // Analytics & reporting - professional colors
      analytics: 'purple',
      reports: 'blue',

      // Customer-facing - friendly colors
      customer_web: 'green',
      customer_app: 'blue',
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
    if (!isShiftActive) {
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
    <div className="fixed left-0 top-1/2 transform -translate-y-1/2 z-50 transition-all duration-300 max-h-[90vh]">
      {/* Theme-aware Sidebar */}
      <div className={`${resolvedTheme === 'dark'
        ? 'bg-gray-900/95 backdrop-blur-xl rounded-r-3xl p-4 shadow-[0_8px_32px_0_rgba(59,130,246,0.4)] border-r border-gray-700/50'
        : 'bg-white/90 backdrop-blur-xl rounded-r-3xl p-4 shadow-[0_8px_32px_0_rgba(59,130,246,0.15)] border-r border-gray-200'} max-h-[85vh] overflow-y-auto overflow-x-hidden touch-pan-y scrollbar-hide`}
        style={{ scrollbarWidth: 'none', msOverflowStyle: 'none', WebkitOverflowScrolling: 'touch' }}>
        <nav className="flex flex-col space-y-4">
          {/* Divider */}
          <div className="w-8 h-px mx-auto bg-gradient-to-r from-transparent via-blue-500/50 to-transparent"></div>

          {/* Check In Button - Always shows staff list */}
          <button
            onClick={onStartShift}
            data-testid="check-in-btn"
            className={`w-12 h-12 flex items-center justify-center transition-colors ${resolvedTheme==='dark' ? 'text-white hover:text-blue-300' : 'text-black hover:text-blue-600'}`}
            title={t('navigation.checkIn')}
          >
            <Clock className="w-5 h-5" strokeWidth={2} />
          </button>

          {/* Divider */}
          <div className="w-8 h-px mx-auto bg-gradient-to-r from-transparent via-blue-500/50 to-transparent"></div>

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
              {navigationModules.map((navModule) => {
                const { module, isEnabled, isLocked, requiredPlan } = navModule;
                const isActive = currentView === module.id;
                const color = getModuleColor(module.id, module.category || 'other');
                const isComingSoon = isModuleComingSoon(module.id);
                
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
                  <button
                    key={module.id}
                    onClick={handleClick}
                    disabled={isComingSoon}
                    className={`relative w-12 h-12 flex items-center justify-center transition-colors ${
                      isComingSoon
                        ? `opacity-40 cursor-not-allowed ${resolvedTheme === 'dark' ? 'text-gray-600' : 'text-gray-300'}`
                        : isLocked 
                          ? `opacity-60 ${resolvedTheme === 'dark' ? 'text-gray-500' : 'text-gray-400'}`
                          : getNeonClass(color, isActive, resolvedTheme)
                    }`}
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
                );
              })}
            </>
          )}

          {/* Z Report Button */}
          <button
            onClick={handleOpenZ}
            className={`w-12 h-12 flex items-center justify-center transition-colors ${getNeonClass('blue', !!isZReportOpen, resolvedTheme)}`}
            title={t('navigation.zReport')}
          >
            <span className="font-bold text-base">Z</span>
          </button>

          {/* Settings Button */}
          <button
            onClick={handleOpenSettings}
            className={`w-12 h-12 flex items-center justify-center transition-colors ${getNeonClass('green', false, resolvedTheme)}`}
            title={t('navigation.settings')}
          >
            <Settings className={`w-5 h-5 ${resolvedTheme==='dark' ? 'text-white' : 'text-black'}`} />
          </button>

          {/* Divider */}
          <div className="w-8 h-px mx-auto bg-gradient-to-r from-transparent via-blue-500/50 to-transparent"></div>

          {/* Logout Button */}
          <button
            onClick={onLogout}
            className={`${resolvedTheme==='dark'
              ? 'w-12 h-12 rounded-lg flex items-center justify-center transition-all duration-300 transform hover:scale-110 active:scale-95 bg-gray-800/40 border border-gray-700/50 text-gray-500 hover:bg-red-900/40 hover:border-red-700/50 hover:text-red-400 shadow-[0_2px_8px_0_rgba(59,130,246,0.15)] hover:shadow-[0_4px_16px_0_rgba(239,68,68,0.4)]'
              : 'w-12 h-12 rounded-lg flex items-center justify-center transition-all duration-200 bg-transparent text-black/60 hover:text-red-500'}`}
            title={t('navigation.logout')}>
            <LogOut className={`w-5 h-5 ${resolvedTheme==='dark' ? '' : 'text-black'}`} strokeWidth={2} />
          </button>




        </nav>
      </div>
      
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