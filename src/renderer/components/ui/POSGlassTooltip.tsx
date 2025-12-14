
import React, { useState } from 'react';
import { cn } from '../../utils/cn';

interface POSGlassTooltipProps {
    content: React.ReactNode;
    children: React.ReactNode;
    position?: 'top' | 'bottom' | 'left' | 'right';
    className?: string;
    delay?: number;
}

export const POSGlassTooltip: React.FC<POSGlassTooltipProps> = ({
    content,
    children,
    position = 'top',
    className,
    delay = 200
}) => {
    const [isVisible, setIsVisible] = useState(false);
    const [timeoutId, setTimeoutId] = useState<NodeJS.Timeout | null>(null);

    const showTooltip = () => {
        const id = setTimeout(() => setIsVisible(true), delay);
        setTimeoutId(id);
    };

    const hideTooltip = () => {
        if (timeoutId) clearTimeout(timeoutId);
        setIsVisible(false);
    };

    const positionClasses = {
        top: 'bottom-full left-1/2 -translate-x-1/2 mb-2',
        bottom: 'top-full left-1/2 -translate-x-1/2 mt-2',
        left: 'right-full top-1/2 -translate-y-1/2 mr-2',
        right: 'left-full top-1/2 -translate-y-1/2 ml-2'
    };

    return (
        <div
            className="relative inline-block"
            onMouseEnter={showTooltip}
            onMouseLeave={hideTooltip}
            onFocus={showTooltip}
            onBlur={hideTooltip}
        >
            {children}
            {isVisible && (
                <div className={cn(
                    "absolute z-50 px-3 py-2 text-sm text-white bg-gray-900/90 rounded-lg shadow-lg backdrop-blur-sm whitespace-nowrap transition-opacity duration-200 border border-white/10",
                    positionClasses[position],
                    className
                )}>
                    {content}
                    {/* Arrow */}
                    <div className={cn(
                        "absolute w-2 h-2 bg-gray-900/90 rotate-45 border-r border-b border-white/10",
                        position === 'top' && "bottom-[-5px] left-1/2 -translate-x-1/2 border-t-0 border-l-0 border-r border-b transform rotate-45",
                        position === 'bottom' && "top-[-5px] left-1/2 -translate-x-1/2 border-t border-l border-r-0 border-b-0 transform rotate-45 bg-gray-900/90", // Fixed rotation for bottom arrow
                        // Simplified arrow logic for now to avoid complex transforms
                    )}></div>
                </div>
            )}
        </div>
    );
};
