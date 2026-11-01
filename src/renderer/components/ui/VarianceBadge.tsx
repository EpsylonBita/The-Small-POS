import React from 'react';
import { useTranslation } from 'react-i18next';
import { AlertCircle, CheckCircle } from 'lucide-react';
import { formatCurrency } from '../../utils/format';

interface VarianceBadgeProps {
    variance: number;
    currency?: string | null;
    size?: 'sm' | 'md' | 'lg';
    className?: string;
    showIcon?: boolean;
    /** Show the status sentence (balanced / surplus / missing) under the badge. Default: large badges. */
    showStatus?: boolean;
}

export const VarianceBadge: React.FC<VarianceBadgeProps> = ({
    variance,
    size = 'md',
    className = '',
    showIcon = true,
    showStatus = size === 'lg',
    currency
}) => {
    const { t } = useTranslation();

    // Determine status and styles based on variance
    // We treat variance close to 0 (within epsilon) as balanced
    const isBalanced = Math.abs(variance) < 0.01;
    const isPositive = variance > 0;

    const variant = isBalanced ? 'balanced' : isPositive ? 'positive' : 'negative';

    // Size classes
    const sizeClasses = {
        sm: 'px-2 py-0.5 text-xs',
        md: 'px-3 py-1 text-sm',
        lg: 'px-4 py-2 text-base'
    };

    // Color classes using existing glass design variables or fallback tailwind colors
    // Using specific colors that meet WCAG 2.1 AA contrast requirements
    // UI audit wave 6: measured on the light modal glass, the -700 amounts read 3.0-4.3:1, so
    // light uses -800. The shortage no longer pulses forever (a loop on a till, and the fade
    // dropped its contrast); the status sentence under a large badge says it in words.
    const colorClasses = {
        balanced: 'bg-(--pos-s-surface-2) text-green-800 dark:text-green-300 border-green-600', // #166534 / #86efac
        positive: 'bg-(--pos-s-surface-2) text-emerald-800 dark:text-emerald-300 border-emerald-600', // #065f46 / #6ee7b7
        negative: 'bg-(--pos-s-surface-2) text-red-800 dark:text-red-300 border-red-600' // #991b1b / #fca5a5
    };

    const formattedAmount = `${variance < 0 ? '-' : (variance > 0 ? '+' : '')}${formatCurrency(Math.abs(variance), currency)}`;

    const statusLabel = isBalanced
        ? t('modals.staffShift.varianceBalanced')
        : isPositive
            ? t('modals.staffShift.variancePositive')
            : t('modals.staffShift.varianceNegative');

    // The status used to live only in a title tooltip, which a touch till never shows (UI audit wave 6).
    const statusTextClasses = {
        balanced: 'text-green-700 dark:text-green-300',
        positive: 'text-emerald-700 dark:text-emerald-300',
        negative: 'text-red-700 dark:text-red-300'
    };

    const badge = (
        <div
            className={`
        inline-flex items-center gap-2 rounded-full border font-mono font-bold transition-all duration-300
        ${sizeClasses[size]}
        ${colorClasses[variant]}
        ${className}
      `}
            role="status"
            aria-label={t('modals.staffShift.varianceLabel', { amount: formattedAmount, status: statusLabel })}
            title={`${statusLabel}: ${formattedAmount}`}
        >
            {showIcon && (
                <span className="shrink-0">
                    {isBalanced ? <CheckCircle size={size === 'sm' ? 12 : size === 'md' ? 14 : 16} /> :
                        isPositive ? <CheckCircle size={size === 'sm' ? 12 : size === 'md' ? 14 : 16} /> :
                            <AlertCircle size={size === 'sm' ? 12 : size === 'md' ? 14 : 16} />}
                </span>
            )}
            <span>{formattedAmount}</span>
        </div>
    );

    if (!showStatus) return badge;

    return (
        <div className="inline-flex flex-col items-center gap-1">
            {badge}
            <p data-variance-status className={`text-sm font-semibold text-center ${statusTextClasses[variant]}`}>
                {statusLabel}
            </p>
        </div>
    );
};
