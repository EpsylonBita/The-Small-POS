import React, { memo } from 'react';

interface PulseAnimationProps {
  children: React.ReactNode;
  className?: string;
  pulseColor?: string;
  duration?: string;
  enabled?: boolean;
}

export const PulseAnimation = memo<PulseAnimationProps>(({
  children,
  className = '',
  pulseColor = 'bg-blue-400',
  duration = 'duration-1000',
  enabled = true
}) => {
  if (!enabled) {
    return <>{children}</>;
  }

  return (
    <div className={`relative ${className}`}>
      {/* Pulse rings */}
      <div className="absolute inset-0 rounded-full">
        <div 
          className={`
            absolute inset-0 rounded-full ${pulseColor} opacity-20 
            animate-ping animation-delay-0 ${duration}
          `} 
        />
        <div 
          className={`
            absolute inset-0 rounded-full ${pulseColor} opacity-15 
            animate-ping animation-delay-300 ${duration}
          `} 
        />
        <div 
          className={`
            absolute inset-0 rounded-full ${pulseColor} opacity-10 
            animate-ping animation-delay-600 ${duration}
          `} 
        />
      </div>
      
      {/* Content */}
      <div className="relative z-10">
        {children}
      </div>
    </div>
  );
});

PulseAnimation.displayName = 'PulseAnimation';

export default PulseAnimation;