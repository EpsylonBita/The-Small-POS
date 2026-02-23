import { useState, useEffect, useRef } from 'react';
import { getBridge, isBrowser, offEvent, onEvent } from '../../lib';

interface WindowState {
  isMaximized: boolean;
  isFullScreen: boolean;
}

/**
 * Hook to track window state (maximized, fullscreen)
 * Uses backend window-state events and native window signals.
 */
export function useWindowState(): WindowState {
  const bridge = getBridge();
  const [state, setState] = useState<WindowState>({
    isMaximized: false,
    isFullScreen: false,
  });
  
  // Use ref to track previous state and avoid unnecessary re-renders
  const prevStateRef = useRef<WindowState>({ isMaximized: false, isFullScreen: false });

  useEffect(() => {
    let disposed = false;

    const applyState = (windowState: any) => {
      const newState = {
        isMaximized: windowState?.isMaximized ?? false,
        isFullScreen: windowState?.isFullScreen ?? false,
      };

      if (
        newState.isMaximized !== prevStateRef.current.isMaximized ||
        newState.isFullScreen !== prevStateRef.current.isFullScreen
      ) {
        prevStateRef.current = newState;
        setState(newState);
      }
    };

    const checkWindowState = async () => {
      if (isBrowser()) return;
      try {
        const windowState = await bridge.window.getState();
        if (!disposed) {
          applyState(windowState);
        }
      } catch (_error) {
        // Silently ignore errors to avoid log spam
      }
    };

    const handleWindowStateChanged = (payload: any) => {
      if (disposed) return;
      applyState(payload);
    };

    const handleNativeWindowSignal = () => {
      void checkWindowState();
    };

    void checkWindowState();
    onEvent('window-state-changed', handleWindowStateChanged);
    window.addEventListener('resize', handleNativeWindowSignal);
    window.addEventListener('fullscreenchange', handleNativeWindowSignal);

    return () => {
      disposed = true;
      offEvent('window-state-changed', handleWindowStateChanged);
      window.removeEventListener('resize', handleNativeWindowSignal);
      window.removeEventListener('fullscreenchange', handleNativeWindowSignal);
    };
  }, [bridge]);

  return state;
}

export default useWindowState;
