import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
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
    
  const reduceMotion = useReducedMotion();
  const revealMotion = {
    initial: reduceMotion ? false as const : { opacity: 0, height: 0, y: 12, overflow: 'hidden' },
    animate: { opacity: 1, height: 'auto', y: 0, overflow: 'visible' },
    exit: reduceMotion ? { opacity: 0 } : { opacity: 0, height: 0, overflow: 'hidden', transition: { overflow: { delay: 0, duration: 0 } } },
    transition: { duration: reduceMotion ? 0 : 0.24, ease: [0.2, 0.8, 0.2, 1] as const, overflow: { delay: reduceMotion ? 0 : 0.24, duration: 0 } },
  };

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
            checkboxColor: 'text-yellow-600 focus:ring-yellow-500 dark:text-yellow-400',
        },
        warning: {
            icon: AlertTriangle,
            color: 'text-yellow-700 dark:text-yellow-300',
            confirmVariant: 'primary' as const,
            detailsColor: 'liquid-glass-modal-text-muted',
            checkboxColor: 'text-yellow-600 focus:ring-yellow-500 dark:text-yellow-400',
        },
        error: {
            icon: XCircle,
            color: 'text-red-600 dark:text-red-400',
            confirmVariant: 'error' as const,
            detailsColor: 'text-red-700 dark:text-red-300',
            checkboxColor: 'text-red-600 focus:ring-red-500 dark:text-red-400',
        },
        success: {
            icon: CheckCircle,
            color: 'text-emerald-700 dark:text-emerald-400',
            confirmVariant: 'success' as const,
            detailsColor: 'text-emerald-700 dark:text-emerald-300',
            checkboxColor: 'text-emerald-600 focus:ring-emerald-500 dark:text-emerald-400',
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
            className="max-w-md! border-none [&_.liquid-glass-modal-header]:border-b-0!"
            ariaLabel={title}
        >
            <div className="flex flex-col gap-3">
                <div className="pos-glass-form-card flex items-center gap-4">
                    <Icon className={cn("h-7 w-7 shrink-0", config.color)} />
                    <div>
                        <h3 className="liquid-glass-modal-text text-xl font-bold mb-1">{title}</h3>
                        <p className="liquid-glass-modal-text-muted leading-relaxed">{message}</p>
                    </div>
                </div>

                <AnimatePresence initial={false}>{details && (
                    <motion.div {...revealMotion} className="pos-glass-form-card text-sm">
                        <div className={config.detailsColor}>{details}</div>
                    </motion.div>
                )}</AnimatePresence>

                <AnimatePresence initial={false}>{typeToConfirm && (
                    <motion.div {...revealMotion} className="pos-glass-form-card space-y-2">
                        <label className="liquid-glass-modal-text-muted text-xs font-semibold block">
                            {t('common.actions.typeToConfirm', { value: typeToConfirm })}
                        </label>
                        <POSGlassInput
                            value={typedValue}
                            onChange={(e) => setTypedValue(e.target.value)}
                            placeholder={typeToConfirm}
                            className="pos-glass-field min-h-touch w-full font-mono text-center"
                            disabled={isLoading}
                        />
                    </motion.div>
                )}</AnimatePresence>

                <AnimatePresence initial={false}>{requireCheckbox && (
                    <motion.div {...revealMotion}><label className="pos-glass-tap-card flex min-h-[52px] cursor-pointer items-center gap-3 rounded-2xl p-3">
                        <input
                            type="checkbox"
                            checked={isChecked}
                            onChange={(e) => setIsChecked(e.target.checked)}
                            disabled={isLoading}
                            className={cn(
                                'h-5 w-5 rounded-xl border-(--field-glass-border) bg-(--field-glass) focus:ring-2 focus:ring-offset-0',
                                config.checkboxColor,
                            )}
                        />
                        <span className="liquid-glass-modal-text text-sm select-none">{requireCheckbox}</span>
                    </label></motion.div>
                )}</AnimatePresence>

                <div className="flex justify-end gap-3 px-6 pb-5 pt-2">
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
