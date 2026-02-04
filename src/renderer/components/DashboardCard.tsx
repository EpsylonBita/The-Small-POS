import React, { memo } from 'react';
import { useTheme } from '../contexts/theme-context';
import * as LucideIcons from 'lucide-react';

/**
 * Color variants for dashboard cards
 * Consistent with the design system
 */
export type DashboardCardColor = 'blue' | 'brown' | 'green' | 'red' | 'purple' | 'amber';

/**
 * Props for the DashboardCard component
 */
export interface DashboardCardProps {
  /** Icon name from lucide-react or emoji string */
  icon: string;
  /** Card title */
  title: string;
  /** Main value to display */
  value: string | number;
  /** Color theme for the card */
  color: DashboardCardColor;
  /** Click handler for navigation */
  onClick?: () => void;
  /** Optional subtitle text */
  subtitle?: string;
  /** Whether the card is in loading state */
  isLoading?: boolean;
  /** Whether the card is disabled */
  disabled?: boolean;
  /** Additional CSS classes */
  className?: string;
}

/**
 * Color mappings for dashboard card themes
 */
const CARD_COLORS: Record<DashboardCardColor, {
  bg: { light: string; dark: string };
  icon: { light: string; dark: string };
  text: { light: string; dark: string };
}> = {
  blue: {
    bg: { light: 'bg-blue-50', dark: 'bg-blue-900/40' },
    icon: { light: 'text-blue-600', dark: 'text-blue-400' },
    text: { light: 'text-blue-700', dark: 'text-blue-300' },
  },
  brown: {
    bg: { light: 'bg-amber-50', dark: 'bg-amber-900/40' },
    icon: { light: 'text-amber-700', dark: 'text-amber-400' },
    text: { light: 'text-amber-800', dark: 'text-amber-300' },
  },
  green: {
    bg: { light: 'bg-green-50', dark: 'bg-green-900/40' },
    icon: { light: 'text-green-600', dark: 'text-green-400' },
    text: { light: 'text-green-700', dark: 'text-green-300' },
  },
  red: {
    bg: { light: 'bg-red-50', dark: 'bg-red-900/40' },
    icon: { light: 'text-red-600', dark: 'text-red-400' },
    text: { light: 'text-red-700', dark: 'text-red-300' },
  },
  purple: {
    bg: { light: 'bg-purple-50', dark: 'bg-purple-900/40' },
    icon: { light: 'text-purple-600', dark: 'text-purple-400' },
    text: { light: 'text-purple-700', dark: 'text-purple-300' },
  },
  amber: {
    bg: { light: 'bg-amber-50', dark: 'bg-amber-900/40' },
    icon: { light: 'text-amber-600', dark: 'text-amber-400' },
    text: { light: 'text-amber-700', dark: 'text-amber-300' },
  },
};

/**
 * Check if the icon is an emoji
 */
const isEmoji = (icon: string): boolean => {
  const emojiRegex = /[\u{1F300}-\u{1F9FF}]|[\u{2600}-\u{26FF}]|[\u{2700}-\u{27BF}]/u;
  return emojiRegex.test(icon);
};

/**
 * Render the icon - either as emoji or Lucide icon
 */
const IconRenderer: React.FC<{ icon: string; className?: string }> = ({ icon, className }) => {
  if (isEmoji(icon)) {
    return <span className="text-4xl">{icon}</span>;
  }

  // Try to get the Lucide icon component
  // Cast through unknown to handle Lucide's complex type definitions
  const IconComponent = (LucideIcons as unknown as Record<string, React.ComponentType<{ className?: string; size?: number }>>)[icon];

  if (IconComponent) {
    return <IconComponent className={className} size={32} />;
  }

  // Fallback to showing the icon name
  return <span className="text-2xl">{icon}</span>;
};

/**
 * DashboardCard Component
 *
 * A reusable card component for displaying metrics on business category dashboards.
 * Supports multiple color themes, icons (emoji or Lucide), and click navigation.
 *
 * Used by:
 * - FoodDashboard
 * - ServiceDashboard
 * - ProductDashboard
 */
export const DashboardCard = memo<DashboardCardProps>(({
  icon,
  title,
  value,
  color,
  onClick,
  subtitle,
  isLoading = false,
  disabled = false,
  className = '',
}) => {
  const { resolvedTheme } = useTheme();
  const isDark = resolvedTheme === 'dark';

  const colors = CARD_COLORS[color];
  const bgClass = isDark ? colors.bg.dark : colors.bg.light;
  const iconClass = isDark ? colors.icon.dark : colors.icon.light;
  const textClass = isDark ? colors.text.dark : colors.text.light;

  const handleClick = () => {
    if (!disabled && onClick) {
      onClick();
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if ((e.key === 'Enter' || e.key === ' ') && !disabled && onClick) {
      e.preventDefault();
      onClick();
    }
  };

  return (
    <div
      role={onClick ? 'button' : undefined}
      tabIndex={onClick && !disabled ? 0 : undefined}
      aria-label={`${title}: ${value}${subtitle ? `. ${subtitle}` : ''}`}
      aria-disabled={disabled}
      data-testid="dashboard-card"
      data-card-id={title.toLowerCase().replace(/\s+/g, '-')}
      className={`
        dashboard-card
        ${bgClass}
        rounded-xl border p-6
        shadow-sm
        ${isDark ? 'border-gray-700/50' : 'border-gray-200'}
        ${onClick && !disabled ? 'cursor-pointer hover:opacity-90 transition-all hover:scale-[1.02] active:scale-[0.98] focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500' : ''}
        ${disabled ? 'opacity-50 cursor-not-allowed' : ''}
        ${className}
      `}
      onClick={handleClick}
      onKeyDown={handleKeyDown}
    >
      {/* Icon */}
      <div className={`mb-3 ${iconClass}`}>
        <IconRenderer icon={icon} className={iconClass} />
      </div>

      {/* Title */}
      <div className={`text-sm font-medium mb-2 ${isDark ? 'text-gray-400' : 'text-gray-600'}`}>
        {title}
      </div>

      {/* Value */}
      {isLoading ? (
        <div className={`h-12 ${isDark ? 'bg-gray-700' : 'bg-gray-200'} rounded animate-pulse`} />
      ) : (
        <div className={`text-4xl md:text-5xl font-bold ${textClass}`}>
          {value}
        </div>
      )}

      {/* Optional Subtitle */}
      {subtitle && (
        <div className={`text-xs mt-2 ${isDark ? 'text-gray-500' : 'text-gray-500'}`}>
          {subtitle}
        </div>
      )}
    </div>
  );
});

DashboardCard.displayName = 'DashboardCard';

export default DashboardCard;
