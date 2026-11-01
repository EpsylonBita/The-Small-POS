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
        // Wave ΣΤ1: the kit's notice tints (solid, AA in both themes) instead of translucent washes.
        info: {
            icon: Info,
            color: 'text-(--pos-s-fg)',
            bg: 'bg-(--pos-s-surface-2)',
            border: 'border-(--pos-s-border)',
            shadow: ''
        },
        warning: {
            icon: AlertTriangle,
            color: 'text-(--pos-s-warn)',
            bg: 'bg-(--pos-s-warn-bg)',
            border: 'border-(--pos-s-warn)',
            shadow: ''
        },
        error: {
            icon: XCircle,
            color: 'text-(--pos-s-bad)',
            bg: 'bg-(--pos-s-bad-bg)',
            border: 'border-(--pos-s-bad)',
            shadow: ''
        },
        success: {
            icon: CheckCircle,
            color: 'text-(--pos-s-ok)',
            bg: 'bg-(--pos-s-ok-bg)',
            border: 'border-(--pos-s-ok)',
            shadow: ''
        }
    }[severity];

    const Icon = config.icon;

    return (
        <div className={cn(
            "relative overflow-hidden rounded-xl border transition-all duration-300",
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
                        <p className="mt-1 text-sm text-(--pos-s-fg) leading-relaxed">
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
                                    className="min-h-11 text-sm px-3"
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
                                className="flex min-h-11 items-center gap-1 rounded-xl px-2 text-sm font-semibold text-(--pos-s-muted) transition-transform active:scale-[0.98] active:bg-(--pos-s-surface-2)"
                                aria-expanded={isExpanded}
                            >
                                {isExpanded ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
                                {isExpanded ? "Hide Details" : "Show Details"}
                            </button>

                            {isExpanded && (
                                <div className="mt-2 text-xs font-mono bg-(--pos-s-surface) p-2 rounded-lg border border-(--pos-s-border) overflow-x-auto text-(--pos-s-fg) whitespace-pre-wrap">
                                    {typeof details === 'string' ? details : details}
                                </div>
                            )}
                        </div>
                    )}
                </div>

                {onClose && (
                    <button
                        onClick={onClose}
                        className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-(--pos-s-muted) transition-transform active:scale-95 active:bg-(--pos-s-surface-2)"
                        aria-label="Close alert"
                    >
                        <X className="w-4 h-4" />
                    </button>
                )}
            </div>
        </div>
    );
};
