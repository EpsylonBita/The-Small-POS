import type { ModuleId, ModuleMetadata } from '../types/modules';

const iconMap: Record<string, string> = {
  dashboard: 'LayoutDashboard',
  settings: 'Settings',
  orders: 'ClipboardList',
  menu: 'BookOpen',
  users: 'Users',
  analytics: 'BarChart3',
  reports: 'FileText',
  inventory: 'Package',
  tables: 'LayoutGrid',
  reservations: 'Calendar',
  kitchen_display: 'ChefHat',
  kiosk: 'Monitor',
  delivery: 'Truck',
  loyalty: 'Gift',
  staff_schedule: 'UserCog',
};

function formatModuleName(moduleId: string): string {
  return moduleId
    .split(/[_-]+/)
    .filter(Boolean)
    .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
    .join(' ');
}

export function getFallbackModuleMetadata(moduleId: ModuleId): ModuleMetadata {
  const normalizedId = String(moduleId);

  return {
    id: moduleId,
    name: formatModuleName(normalizedId),
    description: '',
    category: 'addon',
    isCore: normalizedId === 'dashboard' || normalizedId === 'settings',
    showInNavigation: true,
    sortOrder: 0,
    requiredFeatures: [],
    compatibleBusinessTypes: [],
    route: `/${normalizedId.replace(/_/g, '-')}`,
    icon: iconMap[normalizedId] || 'Package',
  };
}
