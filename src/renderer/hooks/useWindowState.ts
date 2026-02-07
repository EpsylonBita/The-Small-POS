import { useState, useEffect, useRef } from 'react';

interface WindowState {
  isMaximized: boolean;
  isFullScreen: boolean;
}

/**
 * Hook to track window state (maximized, fullscreen)
 * Polls the main process for state changes
 */
export function useWindowState(): WindowState {
  const [state, setState] = useState<WindowState>({
    isMaximized: false,
    isFullScreen: false,
  });
  
  // Use ref to track previous state and avoid unnecessary re-renders
  const prevStateRef = useRef<WindowState>({ isMaximized: false, isFullScreen: false });

  useEffect(() => {
    const checkWindowState = async () => {
      if ((window as any).electronAPI?.ipcRenderer) {
        try {
          const windowState = await (window as any).electronAPI.ipcRenderer.invoke('window-get-state');
          const newState = {
            isMaximized: windowState.isMaximized ?? false,
            isFullScreen: windowState.isFullScreen ?? false,
          };
          
          // Only update state if it actually changed
          if (newState.isMaximized !== prevStateRef.current.isMaximized ||
              newState.isFullScreen !== prevStateRef.current.isFullScreen) {
            prevStateRef.current = newState;
            setState(newState);
          }
        } catch (error) {
          // Silently ignore errors to avoid log spam
        }
      }
    };

    // Check initial state
    checkWindowState();

    // Poll for state changes every 500ms
    const interval = setInterval(checkWindowState, 500);

    return () => clearInterval(interval);
  }, []);

  return state;
}

export default useWindowState;
