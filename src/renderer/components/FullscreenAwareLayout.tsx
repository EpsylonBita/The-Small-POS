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
  return (
    <div className={`relative flex h-screen min-h-0 flex-col overflow-hidden ${className}`}>
      <AppWindowFrame
        update={update}
        windowState={windowState}
      />
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">{children}</div>
    </div>
  );
};

export default FullscreenAwareLayout;
