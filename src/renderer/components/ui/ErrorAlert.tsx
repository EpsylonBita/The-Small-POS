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
            color: 'text-amber-300',
            bg: 'bg-amber-500/10',
            border: 'border-amber-500/20',
            shadow: 'shadow-amber-500/5'
        },
        warning: {
            icon: AlertTriangle,
            color: 'text-amber-300',
            bg: 'bg-amber-500/10',
            border: 'border-amber-500/20',
            shadow: 'shadow-amber-500/5'
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
                                className="flex min-h-8 items-center gap-1 rounded-xl px-2 text-xs font-semibold text-white/55 transition-transform active:scale-[0.98] active:bg-white/10 active:text-white/85"
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
                        className="shrink-0 rounded-xl p-1.5 text-white/45 transition-transform active:scale-95 active:bg-white/10 active:text-white"
                        aria-label="Close alert"
                    >
                        <X className="w-4 h-4" />
                    </button>
                )}
            </div>
        </div>
    );
};
