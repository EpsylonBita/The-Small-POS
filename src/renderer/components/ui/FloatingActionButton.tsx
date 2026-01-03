import React from 'react';
import { cn } from '../../utils/cn';
import { Plus } from 'lucide-react';

interface FloatingActionButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  className?: string;
  icon?: React.ReactNode;
}

const FloatingActionButton = React.forwardRef<HTMLButtonElement, FloatingActionButtonProps>(
  ({ className, icon, ...props }, ref) => {
    return (
      <button
        ref={ref}
        className={cn(
          'fixed bottom-4 sm:bottom-6 right-4 sm:right-6 z-50',
          'w-14 h-14 sm:w-16 sm:h-16 rounded-full',
          'bg-pos-primary text-white',
          'flex items-center justify-center',
          'shadow-lg hover:shadow-xl',
          'transform transition-all duration-300 ease-in-out',
          'hover:scale-110 hover:bg-blue-600',
          'active:scale-95',
          'focus:outline-none focus:ring-4 focus:ring-blue-300',
          'touch-action-manipulation',
          'safe-area-bottom',
          className
        )}
        style={{ marginBottom: 'env(safe-area-inset-bottom)' }}
        {...props}
      >
        {icon || <Plus size={28} className="sm:w-8 sm:h-8" />}
      </button>
    );
  }
);

FloatingActionButton.displayName = 'FloatingActionButton';

export { FloatingActionButton }; 