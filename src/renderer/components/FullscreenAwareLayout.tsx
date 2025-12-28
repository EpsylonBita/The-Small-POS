import React from 'react';
import { useWindowState } from '../hooks/useWindowState';
import CustomTitleBar from './CustomTitleBar';

interface FullscreenAwareLayoutProps {
  children: React.ReactNode;
  updateAvailable?: boolean;
  onCheckForUpdates?: () => void;
  className?: string;
}

/**
 * Layout component that handles fullscreen mode properly.
 * When in fullscreen, the title bar is hidden and no top padding is applied.
 * When not in fullscreen, the title bar is shown with appropriate padding.
 */
export const FullscreenAwareLayout: React.FC<FullscreenAwareLayoutProps> = ({
  children,
  updateAvailable = false,
  onCheckForUpdates,
  className = '',
}) => {
  const { isFullScreen } = useWindowState();

  return (
    <div className={`flex flex-col min-h-screen ${className}`}>
      {/* Custom Title Bar - Hidden in fullscreen mode */}
      <CustomTitleBar
        updateAvailable={updateAvailable}
        onCheckForUpdates={onCheckForUpdates}
      />
      {/* Content area - No padding in fullscreen mode */}
      <div className={`flex-1 flex flex-col ${isFullScreen ? '' : 'pt-8'}`}>
        {children}
      </div>
    </div>
  );
};

export default FullscreenAwareLayout;
