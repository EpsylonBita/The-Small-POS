import React, { memo } from 'react';
import { useTheme } from '../../contexts/theme-context';

interface SkeletonLoaderProps {
  className?: string;
  width?: string;
  height?: string;
  variant?: 'rectangular' | 'circular' | 'text';
  lines?: number;
}

export const SkeletonLoader = memo<SkeletonLoaderProps>(({
  className = '',
  width = 'w-full',
  height = 'h-4',
  variant = 'rectangular',
  lines = 1
}) => {
  const { resolvedTheme } = useTheme();

  const baseClasses = `animate-pulse ${
    resolvedTheme === 'light'
      ? 'bg-gray-200'
      : 'bg-gray-700'
  }`;

  const getVariantClasses = () => {
    switch (variant) {
      case 'circular':
        return 'rounded-full';
      case 'text':
        return 'rounded';
      case 'rectangular':
      default:
        return 'rounded-lg';
    }
  };

  if (variant === 'text' && lines > 1) {
    return (
      <div className={`space-y-2 ${className}`}>
        {Array.from({ length: lines }, (_, index) => (
          <div
            key={index}
            className={`${baseClasses} ${getVariantClasses()} ${width} ${height}`}
            style={{
              width: index === lines - 1 ? '75%' : '100%'
            }}
          />
        ))}
      </div>
    );
  }

  return (
    <div className={`${baseClasses} ${getVariantClasses()} ${width} ${height} ${className}`} />
  );
});

SkeletonLoader.displayName = 'SkeletonLoader';

export default SkeletonLoader;