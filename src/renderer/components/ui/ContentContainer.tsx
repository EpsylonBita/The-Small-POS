import React, { memo } from 'react';
import { useTheme } from '../../contexts/theme-context';

interface ContentContainerProps {
  children: React.ReactNode;
  className?: string;
}

export const ContentContainer = memo<ContentContainerProps>(({ children, className = '' }) => {
  const { resolvedTheme } = useTheme();

  return (
    <div className="flex-1 p-4 sm:p-6 md:p-8 lg:p-12 overflow-hidden">
      {/* Background Container with solid colors and bold shadows */}
      <div className={`
        w-full max-w-none sm:max-w-4xl mx-auto h-full
        rounded-xl sm:rounded-2xl lg:rounded-3xl 
        p-3 sm:p-4 md:p-6
        overflow-hidden
        relative
        transition-all duration-300
        ${resolvedTheme === 'light' 
          ? 'bg-white shadow-lg border border-gray-200' 
          : 'bg-gray-800 shadow-lg border border-gray-600'
        }
        ${className}
      `}>
        {/* Content */}
        <div className="relative h-full overflow-hidden">
          {children}
        </div>
      </div>
    </div>
  );
});

ContentContainer.displayName = 'ContentContainer';

export default ContentContainer; 