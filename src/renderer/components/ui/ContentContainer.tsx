import React, { memo } from 'react';
import { useTheme } from '../../contexts/theme-context';

interface ContentContainerProps {
  children: React.ReactNode;
  className?: string;
}

export const ContentContainer = memo<ContentContainerProps>(({ children, className = '' }) => {
  const { resolvedTheme } = useTheme();

  return (
    <div className="flex-1 p-4 sm:p-6 md:p-8 lg:p-12 overflow-hidden relative">
      {/* Background Container with solid colors and bold shadows */}
      <div className={`
        w-full max-w-none sm:max-w-6xl lg:max-w-7xl mx-auto h-full
        rounded-xl sm:rounded-2xl lg:rounded-3xl
        p-3 sm:p-4 md:p-6
        overflow-hidden
        relative
        transition-all duration-300
        ${resolvedTheme === 'light'
          ? 'bg-white shadow-lg border border-gray-200'
          : 'bg-black shadow-[0_0_80px_rgba(59,130,246,0.4),0_0_120px_rgba(59,130,246,0.2)] border border-blue-500/20'
        }
        ${className}
      `}>
        {/* Blue Backlight Glow Effect - positioned behind the container */}
        {resolvedTheme === 'dark' && (
          <div className="absolute -inset-4 -z-10 bg-blue-500/15 blur-2xl rounded-3xl"></div>
        )}
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