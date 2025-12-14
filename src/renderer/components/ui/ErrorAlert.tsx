import React, { useState } from 'react';
import { AlertTriangle, Info, XCircle, CheckCircle, ChevronDown, ChevronUp, X } from 'lucide-react';
import { cn } from '../../utils/cn';
import { POSGlassButton } from './pos-glass-components';

export type ErrorSeverity = 'info' | 'warning' | 'error' | 'success';

export interface ErrorAction {
    label: string;
    onClick: () => void;
    variant?: 'primary' | 'secondary' | 'error' | 'info' | 'success';
}

interface ErrorAlertProps {
    title: string;
    message?: string;
    details?: string | React.ReactNode;
    severity?: ErrorSeverity;
    actions?: ErrorAction[];
    onClose?: () => void;
    className?: string;
}

export const ErrorAlert: React.FC<ErrorAlertProps> = ({
    title,
    message,
    details,
    severity = 'error',
    actions,
    onClose,
    className
}) => {
    const [isExpanded, setIsExpanded] = useState(false);

    // Styling configuration based on severity
    const config = {
        info: {
            icon: Info,
            color: 'text-blue-400',
            bg: 'bg-blue-500/10',
            border: 'border-blue-500/20',
            shadow: 'shadow-blue-500/5'
        },
        warning: {
            icon: AlertTriangle,
            color: 'text-yellow-400',
            bg: 'bg-yellow-500/10',
            border: 'border-yellow-500/20',
            shadow: 'shadow-yellow-500/5'
        },
        error: {
            icon: XCircle,
            color: 'text-red-400',
            bg: 'bg-red-500/10',
            border: 'border-red-500/20',
            shadow: 'shadow-red-500/5'
        },
        success: {
            icon: CheckCircle,
            color: 'text-emerald-400',
            bg: 'bg-emerald-500/10',
            border: 'border-emerald-500/20',
            shadow: 'shadow-emerald-500/5'
        }
    }[severity];

    const Icon = config.icon;

    return (
        <div className={cn(
            "relative overflow-hidden rounded-xl border backdrop-blur-md transition-all duration-300",
            config.bg, config.border, config.shadow,
            className
        )}
            role="alert"
            aria-live={severity === 'error' ? 'assertive' : 'polite'}
        >
            <div className="flex gap-4 p-4 items-start">
                <div className={cn("mt-0.5 shrink-0", config.color)}>
                    <Icon className="w-5 h-5" />
                </div>

                <div className="flex-1 min-w-0">
                    <h3 className={cn("text-sm font-semibold", config.color)}>
                        {title}
                    </h3>

                    {message && (
                        <p className="mt-1 text-sm text-white/80 leading-relaxed">
                            {message}
                        </p>
                    )}

                    {/* Actions Row */}
                    {actions && actions.length > 0 && (
                        <div className="flex flex-wrap gap-2 mt-3">
                            {actions.map((action, index) => (
                                <POSGlassButton
                                    key={index}
                                    onClick={action.onClick}
                                    variant={action.variant || 'secondary'}
                                    size="default"
                                    className="h-8 text-xs px-3"
                                >
                                    {action.label}
                                </POSGlassButton>
                            ))}
                        </div>
                    )}

                    {/* Collapsible Details */}
                    {details && (
                        <div className="mt-2">
                            <button
                                onClick={() => setIsExpanded(!isExpanded)}
                                className="flex items-center gap-1 text-xs text-white/50 hover:text-white/80 transition-colors"
                                aria-expanded={isExpanded}
                            >
                                {isExpanded ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
                                {isExpanded ? "Hide Details" : "Show Details"}
                            </button>

                            {isExpanded && (
                                <div className="mt-2 text-xs font-mono bg-black/30 p-2 rounded border border-white/5 overflow-x-auto text-white/70 whitespace-pre-wrap">
                                    {typeof details === 'string' ? details : details}
                                </div>
                            )}
                        </div>
                    )}
                </div>

                {onClose && (
                    <button
                        onClick={onClose}
                        className="shrink-0 p-1 text-white/40 hover:text-white hover:bg-white/10 rounded-full transition-colors"
                        aria-label="Close alert"
                    >
                        <X className="w-4 h-4" />
                    </button>
                )}
            </div>
        </div>
    );
};
