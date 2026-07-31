import React from 'react';
import AppWindowFrame, {
  type AppFrameUpdate,
  type AppFrameWindowState,
} from './AppWindowFrame';

interface FullscreenAwareLayoutProps {
  children: React.ReactNode;
  className?: string;
  update?: AppFrameUpdate;
  windowState?: AppFrameWindowState;
}

/**
 * Top-level layout wrapper for the touchscreen-first POS shell.
 *
 * The Tauri window is borderless (`decorations: false`), so the app owns a slim
 * touch-first frame for update status and window controls. This intentionally is
 * not the old desktop-style File/Edit/View/Window/Help menu row.
 */
export const FullscreenAwareLayout: React.FC<FullscreenAwareLayoutProps> = ({
  children,
  className = '',
  update,
  windowState,
}) => {
  const showFrame = !windowState?.isFullScreen;

  React.useLayoutEffect(() => {
    if (typeof document === 'undefined') {
      return;
    }

    const root = document.documentElement;
    const previousFrameHeight = root.style.getPropertyValue('--app-window-frame-height');
    root.style.setProperty('--app-window-frame-height', showFrame ? '2rem' : '0rem');

    return () => {
      if (previousFrameHeight) {
        root.style.setProperty('--app-window-frame-height', previousFrameHeight);
      } else {
        root.style.removeProperty('--app-window-frame-height');
      }
    };
  }, [showFrame]);

  return (
    <div className={`relative flex h-screen min-h-0 flex-col overflow-hidden ${className}`}>
      {showFrame && (
        <AppWindowFrame
          update={update}
          windowState={windowState}
        />
      )}
      <div
        data-app-window-content
        className="relative flex min-h-0 flex-1 transform-gpu flex-col overflow-hidden"
      >
        {children}
      </div>
    </div>
  );
};

export default FullscreenAwareLayout;
