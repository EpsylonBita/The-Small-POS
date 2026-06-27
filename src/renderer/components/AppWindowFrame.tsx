import React, { useCallback, useEffect, useMemo, useRef } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import {
  AlertTriangle,
  CheckCircle2,
  Download,
  Maximize,
  Minimize,
  Minus,
  RefreshCw,
  X,
} from 'lucide-react';
import { getBridge } from '../../lib';
import { useI18n } from '../contexts/i18n-context';
import { useTheme } from '../contexts/theme-context';
import logoDark from '../assets/logo-black.png';
import logoLight from '../assets/logo-white.png';

export type AppFrameUpdateStatus =
  | 'checking'
  | 'available'
  | 'not-available'
  | 'downloading'
  | 'downloaded'
  | 'error'
  | 'install-pending'
  | 'installing';

export interface AppFrameUpdate {
  status: AppFrameUpdateStatus;
  label: string;
  detail?: string | null;
  busy?: boolean;
  onOpen: () => void;
}

export interface AppFrameWindowState {
  isMaximized?: boolean;
  isFullScreen?: boolean;
}

interface AppWindowFrameProps {
  update?: AppFrameUpdate;
  windowState?: AppFrameWindowState;
  className?: string;
}

interface WindowDragSession {
  pointerId: number;
  startScreenX: number;
  startScreenY: number;
  currentScreenX: number;
  currentScreenY: number;
  windowX: number;
  windowY: number;
  ready: boolean;
  animationFrame: number | null;
}

const statusIcon = {
  checking: RefreshCw,
  available: Download,
  'not-available': CheckCircle2,
  downloading: Download,
  downloaded: CheckCircle2,
  error: AlertTriangle,
  'install-pending': CheckCircle2,
  installing: RefreshCw,
} satisfies Record<AppFrameUpdateStatus, React.ComponentType<{ className?: string }>>;

function updateTone(status: AppFrameUpdateStatus, isDark: boolean): string {
  switch (status) {
    case 'available':
    case 'checking':
    case 'downloading':
      return isDark
        ? 'border-amber-400/45 bg-amber-400/14 text-amber-100 shadow-[0_0_24px_rgba(251,191,36,0.16)]'
        : 'border-amber-500/45 bg-amber-200/70 text-zinc-950 shadow-[0_12px_28px_rgba(245,158,11,0.14)]';
    case 'downloaded':
    case 'install-pending':
      return isDark
        ? 'border-emerald-400/45 bg-emerald-400/14 text-emerald-100 shadow-[0_0_24px_rgba(16,185,129,0.16)]'
        : 'border-emerald-500/45 bg-emerald-100/80 text-emerald-950 shadow-[0_12px_28px_rgba(16,185,129,0.14)]';
    case 'installing':
      return isDark
        ? 'border-zinc-300/35 bg-zinc-100/10 text-zinc-100'
        : 'border-zinc-900/20 bg-white/70 text-zinc-950';
    case 'error':
      return isDark
        ? 'border-red-400/45 bg-red-500/14 text-red-100 shadow-[0_0_24px_rgba(239,68,68,0.16)]'
        : 'border-red-500/40 bg-red-100/85 text-red-950 shadow-[0_12px_28px_rgba(239,68,68,0.14)]';
    case 'not-available':
    default:
      return isDark
        ? 'border-white/10 bg-white/[0.05] text-zinc-300'
        : 'border-zinc-900/10 bg-white/58 text-zinc-700';
  }
}

export const AppWindowFrame: React.FC<AppWindowFrameProps> = ({
  update,
  windowState,
  className = '',
}) => {
  const { t } = useI18n();
  const { resolvedTheme } = useTheme();
  const isDark = resolvedTheme === 'dark';
  const bridge = useMemo(() => getBridge(), []);
  const dragSessionRef = useRef<WindowDragSession | null>(null);
  const dragListenerCleanupRef = useRef<(() => void) | null>(null);

  const cleanupWindowDragListeners = useCallback(() => {
    dragListenerCleanupRef.current?.();
    dragListenerCleanupRef.current = null;
  }, []);

  useEffect(() => cleanupWindowDragListeners, [cleanupWindowDragListeners]);

  const runWindowCommand = useCallback(
    (command: 'minimize' | 'maximize' | 'close') => {
      cleanupWindowDragListeners();
      dragSessionRef.current = null;

      const run = async () => {
        try {
          const appWindow = getCurrentWindow();
          switch (command) {
            case 'minimize':
              await appWindow.minimize();
              return;
            case 'maximize':
              await appWindow.toggleMaximize();
              return;
            case 'close':
              await appWindow.close();
              return;
          }
        } catch (nativeError: unknown) {
          console.warn(`[AppWindowFrame] native window.${command} failed`, nativeError);
        }

        await bridge.window[command]();
      };

      void run().catch((error: unknown) => {
        console.warn(`[AppWindowFrame] window.${command} failed`, error);
      });
    },
    [bridge, cleanupWindowDragListeners],
  );

  const stopWindowControlPointer = useCallback(
    (event: React.PointerEvent<HTMLElement>) => {
      event.stopPropagation();
      cleanupWindowDragListeners();
      dragSessionRef.current = null;
    },
    [cleanupWindowDragListeners],
  );

  const stopWindowControlMouse = useCallback((event: React.MouseEvent<HTMLElement>) => {
    event.stopPropagation();
  }, []);

  const startNativeWindowDrag = useCallback(() => {
    if (windowState?.isFullScreen) {
      return;
    }

    const startFallbackDrag = () => {
      void bridge.window.startDrag().catch((dragError: unknown) => {
        console.warn('[AppWindowFrame] window.startDrag failed', dragError);
      });
    };

    try {
      const appWindow = getCurrentWindow();
      void appWindow.startDragging().catch((nativeError: unknown) => {
        console.warn('[AppWindowFrame] native window.startDragging failed', nativeError);
        startFallbackDrag();
      });
      return;
    } catch (nativeError: unknown) {
      console.warn('[AppWindowFrame] native window.startDragging failed', nativeError);
    }

    startFallbackDrag();
  }, [bridge, windowState?.isFullScreen]);

  const scheduleWindowMove = useCallback(
    (session: WindowDragSession) => {
      if (!session.ready || session.animationFrame !== null) {
        return;
      }

      session.animationFrame = window.requestAnimationFrame(() => {
        if (dragSessionRef.current !== session) {
          return;
        }

        session.animationFrame = null;
        const x = Math.round(session.windowX + session.currentScreenX - session.startScreenX);
        const y = Math.round(session.windowY + session.currentScreenY - session.startScreenY);
        void bridge.window.setPosition({ x, y }).catch((error: unknown) => {
          console.warn('[AppWindowFrame] window.setPosition failed', error);
        });
      });
    },
    [bridge],
  );

  const startWindowDrag = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if ((event.pointerType === 'mouse' && event.button !== 0) || !event.isPrimary) {
        return;
      }
      if (windowState?.isFullScreen) {
        return;
      }

      const target = event.target instanceof HTMLElement ? event.target : null;
      if (target?.closest('[data-app-window-no-drag], button, a, input, select, textarea')) {
        return;
      }

      event.preventDefault();
      cleanupWindowDragListeners();

      const session: WindowDragSession = {
        pointerId: event.pointerId,
        startScreenX: event.screenX,
        startScreenY: event.screenY,
        currentScreenX: event.screenX,
        currentScreenY: event.screenY,
        windowX: 0,
        windowY: 0,
        ready: false,
        animationFrame: null,
      };

      const finishDragAt = (screenX: number, screenY: number) => {
        cleanupWindowDragListeners();
        if (session.animationFrame !== null) {
          window.cancelAnimationFrame(session.animationFrame);
          session.animationFrame = null;
        }
        if (dragSessionRef.current === session && session.ready) {
          const x = Math.round(session.windowX + screenX - session.startScreenX);
          const y = Math.round(session.windowY + screenY - session.startScreenY);
          void bridge.window.setPosition({ x, y }).catch((error: unknown) => {
            console.warn('[AppWindowFrame] window.setPosition failed', error);
          });
        }
        if (dragSessionRef.current === session) {
          dragSessionRef.current = null;
        }
      };

      const handleGlobalMove = (moveEvent: PointerEvent) => {
        if (dragSessionRef.current !== session || moveEvent.pointerId !== session.pointerId) {
          return;
        }

        session.currentScreenX = moveEvent.screenX;
        session.currentScreenY = moveEvent.screenY;
        moveEvent.preventDefault();
        scheduleWindowMove(session);
      };

      const handleGlobalStop = (stopEvent: PointerEvent) => {
        if (dragSessionRef.current !== session || stopEvent.pointerId !== session.pointerId) {
          return;
        }

        stopEvent.preventDefault();
        finishDragAt(stopEvent.screenX, stopEvent.screenY);
      };

      window.addEventListener('pointermove', handleGlobalMove, true);
      window.addEventListener('pointerup', handleGlobalStop, true);
      window.addEventListener('pointercancel', handleGlobalStop, true);
      dragListenerCleanupRef.current = () => {
        window.removeEventListener('pointermove', handleGlobalMove, true);
        window.removeEventListener('pointerup', handleGlobalStop, true);
        window.removeEventListener('pointercancel', handleGlobalStop, true);
      };

      dragSessionRef.current = session;
      try {
        event.currentTarget.setPointerCapture?.(event.pointerId);
      } catch {
        // Pointer capture can fail on some touch drivers; the window-level
        // listeners above still keep the drag alive.
      }

      const prepareManualDrag = async () => {
        if (windowState?.isMaximized) {
          await bridge.window.maximize().catch((error: unknown) => {
            console.warn('[AppWindowFrame] window.maximize restore failed', error);
          });
        }

        return bridge.window.getPosition();
      };

      void prepareManualDrag().then((position) => {
        if (dragSessionRef.current !== session) {
          return;
        }

        session.windowX = position.x;
        session.windowY = position.y;
        session.ready = true;
        scheduleWindowMove(session);
      }).catch((error: unknown) => {
        console.warn('[AppWindowFrame] window.getPosition failed', error);
        cleanupWindowDragListeners();
        dragSessionRef.current = null;
        startNativeWindowDrag();
      });
    },
    [bridge, cleanupWindowDragListeners, scheduleWindowMove, startNativeWindowDrag, windowState?.isFullScreen, windowState?.isMaximized],
  );

  const startWindowMouseDrag = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      if (event.button !== 0) {
        return;
      }
      if (dragSessionRef.current) {
        return;
      }

      const target = event.target instanceof HTMLElement ? event.target : null;
      if (target?.closest('[data-app-window-no-drag], button, a, input, select, textarea')) {
        return;
      }
      event.preventDefault();
      startNativeWindowDrag();
    },
    [startNativeWindowDrag],
  );

  const moveWindowDrag = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const session = dragSessionRef.current;
      if (!session || session.pointerId !== event.pointerId) {
        return;
      }

      session.currentScreenX = event.screenX;
      session.currentScreenY = event.screenY;
      event.preventDefault();
      scheduleWindowMove(session);
    },
    [scheduleWindowMove],
  );

  const stopWindowDrag = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const session = dragSessionRef.current;
      if (!session || session.pointerId !== event.pointerId) {
        return;
      }

      cleanupWindowDragListeners();
      try {
        event.currentTarget.releasePointerCapture?.(event.pointerId);
      } catch {
        // Ignore stale pointer-capture handles after native window dragging.
      }
      if (session.animationFrame !== null) {
        window.cancelAnimationFrame(session.animationFrame);
        session.animationFrame = null;
      }
      if (session.ready) {
        const x = Math.round(session.windowX + event.screenX - session.startScreenX);
        const y = Math.round(session.windowY + event.screenY - session.startScreenY);
        void bridge.window.setPosition({ x, y }).catch((error: unknown) => {
          console.warn('[AppWindowFrame] window.setPosition failed', error);
        });
      }
      dragSessionRef.current = null;
    },
    [bridge, cleanupWindowDragListeners],
  );

  const UpdateIcon = update ? statusIcon[update.status] : null;
  const updateLabel = update?.detail
    ? `${update.label} - ${update.detail}`
    : update?.label;
  const logoSource = isDark ? logoDark : logoLight;
  const controlBase = `inline-flex h-[60px] min-h-[60px] w-[64px] min-w-[64px] shrink-0 touch-manipulation items-center justify-center bg-transparent p-0 leading-none transition-colors duration-75 active:bg-yellow-400/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-300/80 ${
    isDark ? 'text-zinc-100' : 'text-zinc-900'
  }`;

  return (
    <div
      data-app-window-frame
      onPointerDown={startWindowDrag}
      onMouseDown={startWindowMouseDrag}
      onPointerMove={moveWindowDrag}
      onPointerUp={stopWindowDrag}
      onPointerCancel={stopWindowDrag}
      onLostPointerCapture={stopWindowDrag}
      style={{ zIndex: 2147483600, pointerEvents: 'auto' }}
      className={`fixed inset-x-0 top-0 h-16 shrink-0 touch-none select-none bg-transparent px-2 ${className}`}
    >
      <div
        data-app-window-drag-zone
        data-tauri-drag-region
        aria-hidden="true"
        className="pointer-events-auto absolute inset-x-0 inset-y-0 z-20 touch-none cursor-grab bg-transparent active:cursor-grabbing"
      />

      <div
        className="absolute left-3 top-1/2 z-30 flex -translate-y-1/2 items-center"
      >
        <img
          src={logoSource}
          alt="The Small"
          draggable={false}
          className="h-8 w-8 object-contain"
        />
      </div>

      {update && UpdateIcon && (
        <button
          type="button"
          data-app-frame-update
          data-app-window-no-drag
          data-update-status={update.status}
          onClick={update.onOpen}
          aria-label={updateLabel}
          className={`absolute left-1/2 top-1/2 z-30 inline-flex h-8 max-w-[420px] -translate-x-1/2 -translate-y-1/2 items-center justify-center gap-2 rounded-xl border px-3 text-xs font-semibold transition-transform duration-150 active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-300/80 ${updateTone(update.status, isDark)}`}
        >
          <UpdateIcon className={`h-4 w-4 shrink-0 ${update.busy ? 'animate-spin' : ''}`} />
          <span className="truncate">{update.label}</span>
          {update.detail && (
            <span className={`hidden max-w-[130px] truncate sm:inline ${isDark ? 'text-white/62' : 'text-zinc-900/60'}`}>
              {update.detail}
            </span>
          )}
        </button>
      )}

      <div
        className="absolute right-0 top-0 z-30 flex h-16 items-start gap-0"
        data-app-window-controls
        data-app-window-no-drag
        onPointerDown={stopWindowControlPointer}
        onMouseDown={stopWindowControlMouse}
      >
        <button
          type="button"
          data-app-window-control="minimize"
          data-app-window-no-drag
          aria-label={t('app.window.minimize', 'Minimize')}
          onClick={() => runWindowCommand('minimize')}
          className={controlBase}
        >
          <Minus className="block h-5 w-5 translate-y-[2px]" />
        </button>
        <button
          type="button"
          data-app-window-control="fullscreen"
          data-app-window-no-drag
          aria-label={
            windowState?.isMaximized
              ? t('app.window.restore', 'Restore')
              : t('app.window.maximize', 'Maximize')
          }
          onClick={() => runWindowCommand('maximize')}
          className={controlBase}
        >
          {windowState?.isMaximized ? (
            <Minimize className="block h-5 w-5" />
          ) : (
            <Maximize className="block h-5 w-5" />
          )}
        </button>
        <button
          type="button"
          data-app-window-control="close"
          data-app-window-no-drag
          aria-label={t('common.actions.close', 'Close')}
          onClick={() => runWindowCommand('close')}
          className="inline-flex h-[60px] min-h-[60px] w-[64px] min-w-[64px] shrink-0 touch-manipulation items-center justify-center bg-transparent p-0 leading-none text-red-500 transition-colors duration-75 active:bg-red-500/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-300/80"
        >
          <X className="block h-5 w-5" />
        </button>
      </div>
    </div>
  );
};

export default AppWindowFrame;
