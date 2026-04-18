import React from 'react';
import { cn } from '../../utils/cn';
import { Plus } from 'lucide-react';

interface FloatingActionButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  className?: string;
  icon?: React.ReactNode;
  effect?: 'animated' | 'static';
}

const gradientLayers: Array<React.CSSProperties> = [
  { animationDelay: '0s', animationDuration: '10s' },
  { animationDelay: '0.15s', animationDuration: '7.2s' },
  { animationDelay: '0.53s', animationDuration: '11.5s' },
  { animationDelay: '0.45s', animationDuration: '8.1s' },
  { animationDelay: '1.6s', animationDuration: '9s' },
  { animationDelay: '1.6s', animationDuration: '12.8s' },
  { animationDelay: '1.6s', animationDuration: '8.6s' },
];

const FloatingActionButton = React.forwardRef<HTMLButtonElement, FloatingActionButtonProps>(
  ({ className, effect = 'animated', icon, style, disabled, ...props }, ref) => {
    const positioningStyle: React.CSSProperties = {
      right: '1.5rem',
      bottom: 'calc(1.5rem + env(safe-area-inset-bottom))',
    };
    const iconNode = icon || <Plus size={32} className="sm:w-9 sm:h-9" />;

    return (
      <div
        className={cn(
          'fixed z-50',
          'w-[4.75rem] h-[4.75rem] sm:w-[5.25rem] sm:h-[5.25rem] rounded-full',
          'pos-fab-halo',
          effect === 'animated' ? 'pos-fab-halo--animated' : 'pos-fab-halo--static',
          disabled && 'pos-fab-halo--disabled',
          className
        )}
        style={{ ...positioningStyle, ...style }}
      >
        <button
          ref={ref}
          disabled={disabled}
          className={cn(
            'w-full h-full rounded-full',
            'flex items-center justify-center isolate',
            'focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-300/55 focus-visible:ring-offset-0',
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
          <span aria-hidden="true" className="pos-fab__button-layer">
            {iconNode}
          </span>
          <span aria-hidden="true" className="pos-fab__overlay">
            {iconNode}
          </span>
        </button>
      </div>
    );
  }
);

FloatingActionButton.displayName = 'FloatingActionButton';

export { FloatingActionButton }; 
