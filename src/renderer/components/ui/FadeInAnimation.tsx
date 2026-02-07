import React, { memo, useEffect, useState } from 'react';

interface FadeInAnimationProps {
  children: React.ReactNode;
  className?: string;
  delay?: number;
  duration?: number;
  direction?: 'up' | 'down' | 'left' | 'right' | 'none';
  distance?: number;
}

export const FadeInAnimation = memo<FadeInAnimationProps>(({
  children,
  className = '',
  delay = 0,
  duration = 500,
  direction = 'up',
  distance = 20
}) => {
  const [isVisible, setIsVisible] = useState(false);

  useEffect(() => {
    const timer = setTimeout(() => {
      setIsVisible(true);
    }, delay);

    return () => clearTimeout(timer);
  }, [delay]);

  const getTransformClasses = () => {
    if (isVisible) return 'translate-x-0 translate-y-0';
    
    switch (direction) {
      case 'up':
        return `translate-y-${distance}`;
      case 'down':
        return `-translate-y-${distance}`;
      case 'left':
        return `translate-x-${distance}`;
      case 'right':
        return `-translate-x-${distance}`;
      case 'none':
      default:
        return 'translate-x-0 translate-y-0';
    }
  };

  return (
    <div
      className={`
        transform transition-all ease-out
        ${isVisible ? 'opacity-100' : 'opacity-0'}
        ${getTransformClasses()}
        ${className}
      `}
      style={{
        transitionDuration: `${duration}ms`
      }}
    >
      {children}
    </div>
  );
});

FadeInAnimation.displayName = 'FadeInAnimation';

export default FadeInAnimation;