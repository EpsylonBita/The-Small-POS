import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
} from 'react';
import { createPortal } from 'react-dom';
import { GripVertical, Maximize2, X } from 'lucide-react';

export interface CallerIdMinimizedPanelProps {
  title: string;
  phone: string;
  onRestore: () => void;
  onClose: () => void;
  ariaLabel?: string;
  moveLabel?: string;
  restoreLabel?: string;
  closeLabel?: string;
}

interface PanelPosition {
  x: number;
  y: number;
}

interface DragState {
  pointerId: number;
  offsetX: number;
  offsetY: number;
}

const VIEWPORT_MARGIN = 12;
const DEFAULT_PANEL_WIDTH = 360;
const DEFAULT_PANEL_HEIGHT = 112;
const DEFAULT_TOP = 88;
const KEYBOARD_STEP = 12;
const KEYBOARD_LARGE_STEP = 32;

function measuredPanelSize(panel: HTMLElement | null) {
  const rect = panel?.getBoundingClientRect();
  const viewportWidth = typeof window === 'undefined' ? DEFAULT_PANEL_WIDTH : window.innerWidth;

  return {
    width: rect && rect.width > 0
      ? rect.width
      : Math.min(DEFAULT_PANEL_WIDTH, Math.max(0, viewportWidth - (VIEWPORT_MARGIN * 2))),
    height: rect && rect.height > 0 ? rect.height : DEFAULT_PANEL_HEIGHT,
  };
}

function clampToViewport(
  position: PanelPosition,
  panel: HTMLElement | null,
): PanelPosition {
  if (typeof window === 'undefined') return position;

  const { width, height } = measuredPanelSize(panel);
  const maxX = Math.max(VIEWPORT_MARGIN, window.innerWidth - width - VIEWPORT_MARGIN);
  const maxY = Math.max(VIEWPORT_MARGIN, window.innerHeight - height - VIEWPORT_MARGIN);

  return {
    x: Math.min(Math.max(VIEWPORT_MARGIN, position.x), maxX),
    y: Math.min(Math.max(VIEWPORT_MARGIN, position.y), maxY),
  };
}

function initialPosition(): PanelPosition {
  if (typeof window === 'undefined') {
    return { x: VIEWPORT_MARGIN, y: DEFAULT_TOP };
  }

  return clampToViewport({
    x: window.innerWidth - DEFAULT_PANEL_WIDTH - VIEWPORT_MARGIN,
    y: DEFAULT_TOP,
  }, null);
}

/**
 * A non-modal Caller ID surface that stays available while the cashier keeps
 * working. Its position exists only in component memory and is never persisted.
 */
export function CallerIdMinimizedPanel({
  title,
  phone,
  onRestore,
  onClose,
  ariaLabel = 'Caller ID',
  moveLabel = 'Move Caller ID panel',
  restoreLabel = 'Restore Caller ID',
  closeLabel = 'Close Caller ID',
}: CallerIdMinimizedPanelProps) {
  const panelRef = useRef<HTMLElement | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const [position, setPosition] = useState<PanelPosition>(initialPosition);

  const moveTo = useCallback((nextPosition: PanelPosition) => {
    setPosition(clampToViewport(nextPosition, panelRef.current));
  }, []);

  useLayoutEffect(() => {
    setPosition((current) => clampToViewport(current, panelRef.current));
  }, []);

  useEffect(() => {
    const keepPanelVisible = () => {
      setPosition((current) => clampToViewport(current, panelRef.current));
    };

    window.addEventListener('resize', keepPanelVisible);
    return () => window.removeEventListener('resize', keepPanelVisible);
  }, []);

  const handlePointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || (event.target as HTMLElement).closest('button')) return;

    dragRef.current = {
      pointerId: event.pointerId,
      offsetX: event.clientX - position.x,
      offsetY: event.clientY - position.y,
    };

    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // Pointer capture can fail when the OS has already canceled the gesture.
    }
  };

  const handlePointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;

    event.preventDefault();
    moveTo({
      x: event.clientX - drag.offsetX,
      y: event.clientY - drag.offsetY,
    });
  };

  const finishPointerDrag = (event: PointerEvent<HTMLDivElement>) => {
    if (dragRef.current?.pointerId !== event.pointerId) return;
    dragRef.current = null;

    try {
      event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {
      // The browser may have released capture before pointercancel/pointerup.
    }
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget) return;

    const step = event.shiftKey ? KEYBOARD_LARGE_STEP : KEYBOARD_STEP;
    const delta = {
      ArrowLeft: { x: -step, y: 0 },
      ArrowRight: { x: step, y: 0 },
      ArrowUp: { x: 0, y: -step },
      ArrowDown: { x: 0, y: step },
    }[event.key];

    if (!delta) return;
    event.preventDefault();
    moveTo({ x: position.x + delta.x, y: position.y + delta.y });
  };

  if (typeof document === 'undefined' || !document.body) return null;

  return createPortal(
    <section
      ref={panelRef}
      data-caller-id-minimized-panel
      aria-label={ariaLabel}
      className="fixed z-[10050] w-[min(360px,calc(100vw-24px))] overflow-hidden rounded-2xl border border-amber-400/50 bg-white/95 text-slate-900 shadow-2xl backdrop-blur-xl dark:border-amber-300/35 dark:bg-[#111318]/95 dark:text-white"
      style={{ left: position.x, top: position.y }}
    >
      <div
        className="flex touch-none select-none items-center gap-3 px-3 py-3 cursor-move"
        tabIndex={0}
        aria-label={moveLabel}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={finishPointerDrag}
        onPointerCancel={finishPointerDrag}
        onKeyDown={handleKeyDown}
      >
        <GripVertical className="h-5 w-5 shrink-0 text-slate-400 dark:text-white/45" aria-hidden="true" />

        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold">{title}</p>
          <p className="truncate text-xs text-slate-500 dark:text-white/65" aria-live="polite">
            {phone}
          </p>
        </div>

        <button
          type="button"
          onClick={onRestore}
          className="rounded-xl border border-amber-400/45 bg-amber-400/15 p-2 text-amber-700 transition-transform focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400 active:scale-95 dark:text-amber-300"
          aria-label={restoreLabel}
        >
          <Maximize2 className="h-5 w-5" aria-hidden="true" />
        </button>

        <button
          type="button"
          onClick={onClose}
          className="rounded-xl border border-slate-300/60 p-2 text-slate-500 transition-transform focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400 active:scale-95 dark:border-white/15 dark:text-white/70"
          aria-label={closeLabel}
        >
          <X className="h-5 w-5" aria-hidden="true" />
        </button>
      </div>
    </section>,
    document.body,
  );
}
