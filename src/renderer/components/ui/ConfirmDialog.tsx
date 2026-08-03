import React, { useState, useEffect } from 'react';
import { AlertTriangle, Info, XCircle, CheckCircle } from 'lucide-react';
import { LiquidGlassModal, POSGlassButton, POSGlassInput } from './pos-glass-components';
import { cn } from '../../utils/cn';
import { useTranslation } from 'react-i18next';

export type ConfirmVariant = 'info' | 'warning' | 'error' | 'success';

interface ConfirmDialogProps {
    isOpen: boolean;
    onClose: () => void;
    onConfirm: () => void;
    title: string;
    message: string;
    variant?: ConfirmVariant;
    confirmText?: string;
    cancelText?: string;
    typeToConfirm?: string; // If provided, user must type this string to enable confirm
    requireCheckbox?: string; // If provided, user must check this box to enable confirm
    details?: React.ReactNode;
    isLoading?: boolean;
}

export const ConfirmDialog: React.FC<ConfirmDialogProps> = ({
    isOpen,
    onClose,
    onConfirm,
    title,
    message,
    variant = 'info',
    confirmText,
    cancelText,
    typeToConfirm,
    requireCheckbox,
    details,
    isLoading = false
}) => {
    const { t } = useTranslation();
    const [typedValue, setTypedValue] = useState('');
    const [isChecked, setIsChecked] = useState(false);

    // Reset state on open
    useEffect(() => {
        if (isOpen) {
            setTypedValue('');
            setIsChecked(false);
        }
    }, [isOpen]);

    const config = {
        info: {
            icon: Info,
            color: 'text-yellow-700 dark:text-yellow-300',
            confirmVariant: 'primary' as const,
            detailsColor: 'liquid-glass-modal-text-muted',
            checkboxColor: 'text-yellow-600 focus:ring-yellow-500/70 dark:text-yellow-400',
        },
        warning: {
            icon: AlertTriangle,
            color: 'text-yellow-700 dark:text-yellow-300',
            confirmVariant: 'primary' as const,
            detailsColor: 'liquid-glass-modal-text-muted',
            checkboxColor: 'text-yellow-600 focus:ring-yellow-500/70 dark:text-yellow-400',
        },
        error: {
            icon: XCircle,
            color: 'text-red-600 dark:text-red-400',
            confirmVariant: 'error' as const,
            detailsColor: 'text-red-700 dark:text-red-300',
            checkboxColor: 'text-red-600 focus:ring-red-500/70 dark:text-red-400',
        },
        success: {
            icon: CheckCircle,
            color: 'text-emerald-700 dark:text-emerald-400',
            confirmVariant: 'success' as const,
            detailsColor: 'text-emerald-700 dark:text-emerald-300',
            checkboxColor: 'text-emerald-600 focus:ring-emerald-500/70 dark:text-emerald-400',
        }
    }[variant];

    const Icon = config.icon;

    const isConfirmEnabled =
        (!typeToConfirm || typedValue === typeToConfirm) &&
        (!requireCheckbox || isChecked) &&
        !isLoading;

    return (
        <LiquidGlassModal
            isOpen={isOpen}
            onClose={onClose}
            size="sm"
            className="!max-w-md border-none"
            ariaLabel={title}
        >
            <div className="flex flex-col gap-6">
                <div className="flex items-center gap-4">
                    <Icon className={cn("h-7 w-7 shrink-0", config.color)} />
                    <div>
                        <h3 className="liquid-glass-modal-text text-xl font-bold mb-1">{title}</h3>
                        <p className="liquid-glass-modal-text-muted leading-relaxed">{message}</p>
                    </div>
                </div>

                {details && (
                    <div className="liquid-glass-modal-inset rounded-2xl p-4 text-sm">
                        <div className={config.detailsColor}>{details}</div>
                    </div>
                )}

                {typeToConfirm && (
                    <div className="space-y-2">
                        <label className="liquid-glass-modal-text-muted text-sm block">
                            {t('common.actions.typeToConfirm', { value: typeToConfirm })}
                        </label>
                        <POSGlassInput
                            value={typedValue}
                            onChange={(e) => setTypedValue(e.target.value)}
                            placeholder={typeToConfirm}
                            className="w-full font-mono text-center"
                            disabled={isLoading}
                        />
                    </div>
                )}

                {requireCheckbox && (
                    <label className="liquid-glass-modal-inset flex min-h-[52px] cursor-pointer items-center gap-3 rounded-2xl p-3 transition-transform active:scale-[0.99]">
                        <input
                            type="checkbox"
                            checked={isChecked}
                            onChange={(e) => setIsChecked(e.target.checked)}
                            disabled={isLoading}
                            className={cn(
                                'h-5 w-5 rounded-xl border-slate-400 bg-white focus:ring-2 focus:ring-offset-0 dark:border-white/30 dark:bg-black/40',
                                config.checkboxColor,
                            )}
                        />
                        <span className="liquid-glass-modal-text text-sm select-none">{requireCheckbox}</span>
                    </label>
                )}

                <div className="flex justify-end gap-3 mt-2">
                    <POSGlassButton
                        variant="secondary"
                        onClick={onClose}
                        disabled={isLoading}
                    >
                        {cancelText || t('common.actions.cancel')}
                    </POSGlassButton>
                    <POSGlassButton
                        variant={config.confirmVariant}
                        onClick={onConfirm}
                        disabled={!isConfirmEnabled}
                        loading={isLoading}
                    >
                        {confirmText || t('common.actions.confirm')}
                    </POSGlassButton>
                </div>
            </div>
        </LiquidGlassModal>
    );
};
