import React, { memo } from 'react';
import { useTheme } from '../../contexts/theme-context';

interface ContentContainerProps {
  children: React.ReactNode;
  className?: string;
  contentClassName?: string;
}

export const ContentContainer = memo<ContentContainerProps>(({
  children,
  className = '',
  contentClassName,
}) => {
  const { resolvedTheme } = useTheme();

  return (
    // Founder 31/10: this clipping box reaches the window edges, so the panel's glow is not cut in a
    // strip beside each rail. The side padding is the rails' room (64 / 80px) plus the old gutter.
    <div className="flex-1 py-4 sm:py-6 md:py-8 lg:py-12 px-20 sm:px-26 md:px-28 lg:px-32 overflow-hidden relative">
      {/* Background Container with solid colors and bold shadows */}
      <div className={`
        w-full max-w-none sm:max-w-6xl lg:max-w-7xl mx-auto h-full
        rounded-xl sm:rounded-2xl lg:rounded-3xl
        p-3 sm:p-4 md:p-6
        overflow-hidden
        relative
        transition-all duration-300
        ${resolvedTheme === 'light'
          ? 'pos-shell-glow-panel bg-[#fdfaf5] border border-(--pos-s-border)'
          : 'pos-shell-glow-panel bg-black border border-(--pos-s-border)'
        }
        ${className}
      `}>
        {/* Wave ΣΤ1: no backlight glow behind the content (no coloured glows). */}
        {/* Content */}
        <div className={`relative h-full min-h-0 ${contentClassName ?? 'overflow-y-auto scrollbar-hide'}`}>
          {children}
        </div>
      </div>
    </div>
  );
});

ContentContainer.displayName = 'ContentContainer';

export default ContentContainer;
