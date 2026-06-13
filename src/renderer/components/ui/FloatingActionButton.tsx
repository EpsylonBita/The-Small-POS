import React from 'react';
import { createPortal } from 'react-dom';
import { cn } from '../../utils/cn';

interface FloatingActionButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  className?: string;
  icon?: React.ReactNode;
  effect?: 'animated' | 'static';
  movable?: boolean;
  positionStorageKey?: string;
}

const gradientLayers: Array<React.CSSProperties> = [
  { animationDelay: '0s', animationDuration: '4.8s' },
  { animationDelay: '-0.9s', animationDuration: '3.9s' },
  { animationDelay: '-1.4s', animationDuration: '5.7s' },
  { animationDelay: '-0.4s', animationDuration: '4.2s' },
  { animationDelay: '-2.1s', animationDuration: '6.4s' },
  { animationDelay: '-1.7s', animationDuration: '5.2s' },
  { animationDelay: '-0.6s', animationDuration: '3.6s' },
];

type FabPosition = {
  left: number;
  top: number;
};

type DragState = {
  pointerId: number;
  startX: number;
  startY: number;
  originLeft: number;
  originTop: number;
  width: number;
  height: number;
  hasMoved: boolean;
  lastPosition: FabPosition | null;
};

type StoredFabPosition = {
  xRatio: number;
  yRatio: number;
};

const DEFAULT_POSITION_STORAGE_KEY = 'pos-floating-action-button-position';
const DRAG_MARGIN = 12;
const DRAG_THRESHOLD = 6;
const FALLBACK_BUTTON_SIZE = 92;
const MIN_MEASURED_BUTTON_SIZE = 48;

const clampRatio = (ratio: number): number => Math.min(Math.max(0, ratio), 1);

const getMeasuredButtonSize = (rect: DOMRect): { width: number; height: number } => ({
  width: rect.width >= MIN_MEASURED_BUTTON_SIZE ? rect.width : FALLBACK_BUTTON_SIZE,
  height: rect.height >= MIN_MEASURED_BUTTON_SIZE ? rect.height : FALLBACK_BUTTON_SIZE,
});

const clampPosition = (position: FabPosition, width: number, height: number): FabPosition => {
  if (typeof window === 'undefined') {
    return position;
  }

  const maxLeft = Math.max(DRAG_MARGIN, window.innerWidth - width - DRAG_MARGIN);
  const maxTop = Math.max(DRAG_MARGIN, window.innerHeight - height - DRAG_MARGIN);

  return {
    left: Math.min(Math.max(DRAG_MARGIN, position.left), maxLeft),
    top: Math.min(Math.max(DRAG_MARGIN, position.top), maxTop),
  };
};

const positionToStoredRatio = (position: FabPosition, width: number, height: number): StoredFabPosition | null => {
  if (typeof window === 'undefined') {
    return null;
  }

  const availableWidth = Math.max(1, window.innerWidth - width - DRAG_MARGIN * 2);
  const availableHeight = Math.max(1, window.innerHeight - height - DRAG_MARGIN * 2);

  return {
    xRatio: clampRatio((position.left - DRAG_MARGIN) / availableWidth),
    yRatio: clampRatio((position.top - DRAG_MARGIN) / availableHeight),
  };
};

const storedRatioToPosition = (storedPosition: StoredFabPosition, width: number, height: number): FabPosition => {
  if (typeof window === 'undefined') {
    return { left: DRAG_MARGIN, top: DRAG_MARGIN };
  }

  const availableWidth = Math.max(1, window.innerWidth - width - DRAG_MARGIN * 2);
  const availableHeight = Math.max(1, window.innerHeight - height - DRAG_MARGIN * 2);

  return clampPosition(
    {
      left: DRAG_MARGIN + clampRatio(storedPosition.xRatio) * availableWidth,
      top: DRAG_MARGIN + clampRatio(storedPosition.yRatio) * availableHeight,
    },
    width,
    height
  );
};

const readStoredPosition = (storageKey: string, width: number, height: number): StoredFabPosition | null => {
  if (typeof window === 'undefined') {
    return null;
  }

  try {
    const rawPosition = window.localStorage.getItem(storageKey);
    if (!rawPosition) {
      return null;
    }

    const parsed = JSON.parse(rawPosition) as Partial<FabPosition & StoredFabPosition>;
    const xRatio = parsed.xRatio;
    const yRatio = parsed.yRatio;
    if (typeof xRatio === 'number' && typeof yRatio === 'number' && Number.isFinite(xRatio) && Number.isFinite(yRatio)) {
      return { xRatio: clampRatio(xRatio), yRatio: clampRatio(yRatio) };
    }

    const left = parsed.left;
    const top = parsed.top;
    if (typeof left !== 'number' || typeof top !== 'number' || !Number.isFinite(left) || !Number.isFinite(top)) {
      return null;
    }

    return positionToStoredRatio(clampPosition({ left, top }, width, height), width, height);
  } catch {
    return null;
  }
};

const FloatingActionButton = React.forwardRef<HTMLButtonElement, FloatingActionButtonProps>(
  ({ className, effect = 'animated', icon, style, disabled, movable = false, positionStorageKey, onClick, ...props }, ref) => {
    const wrapperRef = React.useRef<HTMLDivElement | null>(null);
    const dragStateRef = React.useRef<DragState | null>(null);
    const storedPositionRef = React.useRef<StoredFabPosition | null>(null);
    const suppressClickRef = React.useRef(false);
    const [dragPosition, setDragPosition] = React.useState<FabPosition | null>(null);
    const [isDragging, setIsDragging] = React.useState(false);
    const storageKey = positionStorageKey ?? DEFAULT_POSITION_STORAGE_KEY;

    const persistPosition = React.useCallback(
      (position: FabPosition) => {
        if (!movable || typeof window === 'undefined') {
          return;
        }

        const node = wrapperRef.current;
        const rect = node?.getBoundingClientRect();
        if (!rect) {
          return;
        }
        const { width, height } = getMeasuredButtonSize(rect);

        const storedPosition = positionToStoredRatio(position, width, height);
        if (!storedPosition) {
          return;
        }

        try {
          storedPositionRef.current = storedPosition;
          window.localStorage.setItem(storageKey, JSON.stringify(storedPosition));
        } catch {
          // localStorage can be unavailable in restricted webviews.
        }
      },
      [movable, storageKey]
    );

    React.useLayoutEffect(() => {
      if (!movable) {
        setDragPosition(null);
        return;
      }

      const node = wrapperRef.current;
      if (!node) {
        return;
      }

      const restorePosition = () => {
        const rect = node.getBoundingClientRect();
        const { width, height } = getMeasuredButtonSize(rect);
        const storedPosition = readStoredPosition(storageKey, width, height);
        storedPositionRef.current = storedPosition;
        setDragPosition(storedPosition ? storedRatioToPosition(storedPosition, width, height) : null);
      };

      restorePosition();
      const frameId = window.requestAnimationFrame(restorePosition);
      return () => window.cancelAnimationFrame(frameId);
    }, [movable, storageKey]);

    React.useEffect(() => {
      if (!movable || typeof window === 'undefined') {
        return;
      }

      const handleResize = () => {
        const node = wrapperRef.current;
        if (!node) {
          return;
        }

        const rect = node.getBoundingClientRect();
        const { width, height } = getMeasuredButtonSize(rect);
        const storedPosition = storedPositionRef.current;
        setDragPosition(storedPosition ? storedRatioToPosition(storedPosition, width, height) : null);
      };

      window.addEventListener('resize', handleResize);
      return () => window.removeEventListener('resize', handleResize);
    }, [movable]);

    const handlePointerDown = React.useCallback(
      (event: React.PointerEvent<HTMLDivElement>) => {
        if (!movable || disabled || event.button !== 0) {
          return;
        }

        const node = wrapperRef.current;
        if (!node) {
          return;
        }

        const rect = node.getBoundingClientRect();
        dragStateRef.current = {
          pointerId: event.pointerId,
          startX: event.clientX,
          startY: event.clientY,
          originLeft: rect.left,
          originTop: rect.top,
          width: rect.width,
          height: rect.height,
          hasMoved: false,
          lastPosition: dragPosition ?? { left: rect.left, top: rect.top },
        };

        try {
          event.currentTarget.setPointerCapture(event.pointerId);
        } catch {
          // Pointer capture can fail if the browser has already canceled the pointer.
        }
      },
      [disabled, dragPosition, movable]
    );

    const handlePointerMove = React.useCallback((event: React.PointerEvent<HTMLDivElement>) => {
      const dragState = dragStateRef.current;
      if (!dragState || event.pointerId !== dragState.pointerId) {
        return;
      }

      const deltaX = event.clientX - dragState.startX;
      const deltaY = event.clientY - dragState.startY;
      if (!dragState.hasMoved && Math.hypot(deltaX, deltaY) < DRAG_THRESHOLD) {
        return;
      }

      event.preventDefault();
      dragState.hasMoved = true;
      suppressClickRef.current = true;
      setIsDragging(true);

      const nextPosition = clampPosition(
        {
          left: dragState.originLeft + deltaX,
          top: dragState.originTop + deltaY,
        },
        dragState.width,
        dragState.height
      );

      dragState.lastPosition = nextPosition;
      setDragPosition(nextPosition);
    }, []);

    const finishDrag = React.useCallback(
      (event: React.PointerEvent<HTMLDivElement>) => {
        const dragState = dragStateRef.current;
        if (!dragState || event.pointerId !== dragState.pointerId) {
          return;
        }

        if (dragState.hasMoved && dragState.lastPosition) {
          event.preventDefault();
          persistPosition(dragState.lastPosition);
        }

        try {
          event.currentTarget.releasePointerCapture(event.pointerId);
        } catch {
          // The pointer may already be released by the browser.
        }

        dragStateRef.current = null;
        setIsDragging(false);
        window.setTimeout(() => {
          suppressClickRef.current = false;
        }, 150);
      },
      [persistPosition]
    );

    const handleButtonClick = React.useCallback(
      (event: React.MouseEvent<HTMLButtonElement>) => {
        if (suppressClickRef.current) {
          event.preventDefault();
          event.stopPropagation();
          suppressClickRef.current = false;
          return;
        }

        onClick?.(event);
      },
      [onClick]
    );

    const handleWrapperClick = React.useCallback(
      (event: React.MouseEvent<HTMLDivElement>) => {
        if (!movable || disabled || event.target !== event.currentTarget) {
          return;
        }

        if (suppressClickRef.current) {
          event.preventDefault();
          event.stopPropagation();
          suppressClickRef.current = false;
          return;
        }

        onClick?.(event as unknown as React.MouseEvent<HTMLButtonElement>);
      },
      [disabled, movable, onClick]
    );

    const defaultPositioningStyle: React.CSSProperties = dragPosition
      ? {
          left: `${dragPosition.left}px`,
          top: `${dragPosition.top}px`,
          right: 'auto',
          bottom: 'auto',
        }
      : {
          right: '1.25rem',
          bottom: 'calc(1.25rem + env(safe-area-inset-bottom))',
        };

    const wrapperStyle = dragPosition
      ? { ...style, ...defaultPositioningStyle }
      : { ...defaultPositioningStyle, ...style };

    const floatingButton = (
      <div
        ref={wrapperRef}
        data-page-motion-skip="true"
        className={cn(
          'fixed z-[900]',
          'w-[5.25rem] h-[5.25rem] sm:w-[5.75rem] sm:h-[5.75rem] rounded-full',
          'pos-fab-halo',
          effect === 'animated' ? 'pos-fab-halo--animated' : 'pos-fab-halo--static',
          movable && 'pos-fab-halo--movable',
          isDragging && 'pos-fab-halo--dragging',
          disabled && 'pos-fab-halo--disabled',
          className
        )}
        style={wrapperStyle}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={finishDrag}
        onPointerCancel={finishDrag}
        onClick={handleWrapperClick}
      >
        <button
          ref={ref}
          disabled={disabled}
          onClick={handleButtonClick}
          className={cn(
            'w-full h-full rounded-full',
            'flex items-center justify-center isolate',
            'focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-300/55 focus-visible:ring-offset-0',
            'touch-action-manipulation',
            'text-white',
            'pos-fab',
            effect === 'animated' ? 'pos-fab--animated' : 'pos-fab--static',
            disabled && 'pos-fab--disabled',
          )}
          {...props}
        >
          <span aria-hidden="true" className="pos-fab__light" />
          {gradientLayers.map((layerStyle, index) => (
            <span key={`pos-fab-gradient-${index}`} aria-hidden="true" className="pos-fab__gradient-layer" style={layerStyle} />
          ))}
          <span aria-hidden="true" className="pos-fab__button-layer" />
          {icon ? (
            <span aria-hidden="true" className="pos-fab__overlay">
              {icon}
            </span>
          ) : null}
        </button>
      </div>
    );

    return typeof document !== 'undefined' && document.body
      ? createPortal(floatingButton, document.body)
      : floatingButton;
  }
);

FloatingActionButton.displayName = 'FloatingActionButton';

export { FloatingActionButton }; 
