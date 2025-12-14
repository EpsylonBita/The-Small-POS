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
            color: 'text-cyan-400',
            bgIcon: 'bg-cyan-500/20',
            confirmVariant: 'primary' as const
        },
        warning: {
            icon: AlertTriangle,
            color: 'text-yellow-400',
            bgIcon: 'bg-yellow-500/20',
            confirmVariant: 'primary' as const
        },
        error: {
            icon: XCircle,
            color: 'text-red-400',
            bgIcon: 'bg-red-500/20',
            confirmVariant: 'error' as const
        },
        success: {
            icon: CheckCircle,
            color: 'text-emerald-400',
            bgIcon: 'bg-emerald-500/20',
            confirmVariant: 'success' as const
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
            title=""
            size="sm"
            className="border-none"
        >
            <div className="flex flex-col gap-6">
                <div className="flex items-center gap-4">
                    <div className={cn("p-3 rounded-full shrink-0", config.bgIcon)}>
                        <Icon className={cn("w-6 h-6", config.color)} />
                    </div>
                    <div>
                        <h3 className="text-xl font-bold text-white mb-1">{title}</h3>
                        <p className="text-white/70 leading-relaxed">{message}</p>
                    </div>
                </div>

                {details && (
                    <div className="bg-black/20 rounded-lg p-4 text-sm text-white/80 border border-white/5">
                        {details}
                    </div>
                )}

                {typeToConfirm && (
                    <div className="space-y-2">
                        <label className="text-sm text-white/60 block">
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
                    <label className="flex items-center gap-3 p-3 bg-white/5 rounded-lg cursor-pointer border border-white/10 hover:bg-white/10 transition-colors">
                        <input
                            type="checkbox"
                            checked={isChecked}
                            onChange={(e) => setIsChecked(e.target.checked)}
                            disabled={isLoading}
                            className="w-5 h-5 rounded border-white/30 bg-black/40 text-cyan-500 focus:ring-cyan-500 focus:ring-offset-0"
                        />
                        <span className="text-sm text-white select-none">{requireCheckbox}</span>
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
