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
          ? 'bg-[#fdfaf5] shadow-[0_0_64px_rgba(255,221,0,0.34),0_10px_36px_rgba(15,23,42,0.08)] border border-amber-200/70'
          : 'bg-black shadow-[0_0_80px_rgba(255,221,0,0.58),0_0_120px_rgba(255,238,88,0.36)] border border-amber-400/25'
        }
        ${className}
      `}>
        {/* Yellow Backlight Glow Effect - positioned behind the container */}
        <div
          className={`absolute -inset-4 -z-10 blur-2xl rounded-3xl ${
            resolvedTheme === 'dark' ? 'bg-yellow-300/30' : 'bg-yellow-300/35'
          }`}
        />
        {/* Content */}
        <div className="relative h-full overflow-y-auto scrollbar-hide">
          {children}
        </div>
      </div>
    </div>
  );
});

ContentContainer.displayName = 'ContentContainer';

export default ContentContainer;
