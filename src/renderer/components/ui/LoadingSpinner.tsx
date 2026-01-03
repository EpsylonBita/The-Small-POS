import React, { memo } from 'react';
import { useTheme } from '../../contexts/theme-context';

interface LoadingSpinnerProps {
  size?: 'sm' | 'md' | 'lg' | 'xl';
  className?: string;
  text?: string;
  variant?: 'primary' | 'secondary' | 'accent';
}

export const LoadingSpinner = memo<LoadingSpinnerProps>(({
  size = 'md',
  className = '',
  text,
  variant = 'primary'
}) => {
  const { resolvedTheme } = useTheme();

  const getSizeClasses = () => {
    switch (size) {
      case 'sm':
        return 'w-4 h-4';
      case 'md':
        return 'w-6 h-6';
      case 'lg':
        return 'w-8 h-8';
      case 'xl':
        return 'w-12 h-12';
      default:
        return 'w-6 h-6';
    }
  };

  const getColorClasses = () => {
    const isDark = resolvedTheme === 'dark';
    
    switch (variant) {
      case 'primary':
        return isDark 
          ? 'border-blue-400 border-t-transparent'
          : 'border-blue-600 border-t-transparent';
      case 'secondary':
        return isDark
          ? 'border-gray-400 border-t-transparent'
          : 'border-gray-600 border-t-transparent';
      case 'accent':
        return isDark
          ? 'border-green-400 border-t-transparent'
          : 'border-green-600 border-t-transparent';
      default:
        return isDark
          ? 'border-blue-400 border-t-transparent'
          : 'border-blue-600 border-t-transparent';
    }
  };

  const getTextColor = () => {
    return resolvedTheme === 'dark' ? 'text-white/70' : 'text-gray-600';
  };

  return (
    <div className={`flex flex-col items-center justify-center ${className}`}>
      <div
        className={`
          ${getSizeClasses()}
          border-2 rounded-full animate-spin
          ${getColorClasses()}
        `}
      />
      {text && (
        <span className={`mt-3 text-sm font-medium ${getTextColor()}`}>
          {text}
        </span>
      )}
    </div>
  );
});

LoadingSpinner.displayName = 'LoadingSpinner';

export default LoadingSpinner;