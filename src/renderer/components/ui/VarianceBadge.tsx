import React from 'react';
import { useTranslation } from 'react-i18next';
import { AlertCircle, CheckCircle } from 'lucide-react';

interface VarianceBadgeProps {
    variance: number;
    size?: 'sm' | 'md' | 'lg';
    className?: string;
    showIcon?: boolean;
}

export const VarianceBadge: React.FC<VarianceBadgeProps> = ({
    variance,
    size = 'md',
    className = '',
    showIcon = true
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
    const colorClasses = {
        balanced: 'bg-green-500/20 text-green-700 dark:text-green-300 border-green-500/50', // #15803d / #86efac
        positive: 'bg-emerald-500/20 text-emerald-700 dark:text-emerald-300 border-emerald-500/50', // #047857 / #6ee7b7
        negative: 'bg-red-500/20 text-red-700 dark:text-red-300 border-red-500/50 animate-pulse' // #b91c1c / #fca5a5
    };

    const formattedAmount = `${variance < 0 ? '-' : (variance > 0 ? '+' : '')}$${Math.abs(variance).toFixed(2)}`;

    const statusLabel = isBalanced
        ? t('modals.staffShift.varianceBalanced')
        : isPositive
            ? t('modals.staffShift.variancePositive')
            : t('modals.staffShift.varianceNegative');

    return (
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
};
