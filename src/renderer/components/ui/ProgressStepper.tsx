import React from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { Check, Circle, X } from 'lucide-react';
import { cn } from '../../utils/cn';

export type StepStatus = 'pending' | 'active' | 'complete' | 'error';

export interface Step {
    id: string;
    label: string;
    status: StepStatus;
    description?: string;
}

interface ProgressStepperProps {
    steps: Step[];
    className?: string;
    orientation?: 'horizontal' | 'vertical';
}

const MOTION_EASE: [number, number, number, number] = [0.22, 1, 0.36, 1];

const STEP_TONES: Record<StepStatus, {
    shell: string;
    border: string;
    icon: string;
    halo: string;
    label: string;
}> = {
    pending: {
        shell: 'bg-transparent dark:bg-transparent',
        border: 'border-slate-200/90 dark:border-white/10',
        icon: 'text-slate-400 dark:text-slate-500',
        halo: 'bg-slate-400/10 dark:bg-white/10',
        label: 'text-slate-500 dark:text-slate-300/75',
    },
    active: {
        shell: 'bg-cyan-500/[0.08] dark:bg-cyan-500/10',
        border: 'border-cyan-300/80 dark:border-cyan-400/40',
        icon: 'text-cyan-600 dark:text-cyan-200',
        halo: 'bg-cyan-400/18 dark:bg-cyan-300/14',
        label: 'text-slate-900 dark:text-white',
    },
    complete: {
        shell: 'bg-emerald-500/[0.08] dark:bg-emerald-500/10',
        border: 'border-emerald-300/80 dark:border-emerald-400/40',
        icon: 'text-emerald-600 dark:text-emerald-200',
        halo: 'bg-emerald-400/18 dark:bg-emerald-300/12',
        label: 'text-slate-800 dark:text-slate-100',
    },
    error: {
        shell: 'bg-rose-500/[0.08] dark:bg-rose-500/10',
        border: 'border-rose-300/80 dark:border-rose-400/40',
        icon: 'text-rose-600 dark:text-rose-200',
        halo: 'bg-rose-400/18 dark:bg-rose-300/12',
        label: 'text-slate-800 dark:text-slate-100',
    },
};

const connectorFillVariants = {
    hidden: { opacity: 0, scaleX: 0, scaleY: 0 },
    visible: { opacity: 1, scaleX: 1, scaleY: 1 },
};

function StepIcon({ status }: { status: StepStatus }) {
    switch (status) {
        case 'complete':
            return <Check className="h-4 w-4" strokeWidth={2.3} />;
        case 'error':
            return <X className="h-4 w-4" strokeWidth={2.3} />;
        case 'active':
            return <div className="h-2.5 w-2.5 rounded-full bg-current shadow-[0_0_18px_currentColor]" />;
        case 'pending':
        default:
            return <Circle className="h-4 w-4" strokeWidth={1.9} />;
    }
}

export const ProgressStepper: React.FC<ProgressStepperProps> = ({
    steps,
    className,
    orientation = 'horizontal'
}) => {
    const prefersReducedMotion = useReducedMotion();

    return (
        <div
            className={cn(
                'flex w-full',
                orientation === 'vertical'
                    ? 'flex-col gap-4'
                    : 'flex-row justify-between items-start gap-3 sm:gap-4',
                className
            )}
        >
            {steps.map((step, index) => {
                const isLast = index === steps.length - 1;
                const tones = STEP_TONES[step.status];
                const connectorFilled = step.status === 'complete';

                return (
                    <div
                        key={step.id}
                        className={cn(
                            'relative flex min-w-0 flex-1',
                            orientation === 'horizontal'
                                ? 'flex-col items-center text-center'
                                : 'flex-row items-start gap-4'
                        )}
                    >
                        {!isLast && orientation === 'horizontal' && (
                            <div className="absolute left-[calc(50%+1.7rem)] right-[calc(-50%+1.7rem)] top-[1.35rem] h-[2px] rounded-full bg-slate-200/90 dark:bg-white/10">
                                <motion.div
                                    className="h-full origin-left rounded-full bg-gradient-to-r from-emerald-400 via-emerald-400 to-cyan-400/90"
                                    initial={false}
                                    animate={connectorFilled ? 'visible' : 'hidden'}
                                    variants={connectorFillVariants}
                                    transition={
                                        prefersReducedMotion
                                            ? { duration: 0.16, ease: 'linear' }
                                            : { duration: 0.42, ease: MOTION_EASE }
                                    }
                                />
                            </div>
                        )}

                        {!isLast && orientation === 'vertical' && (
                            <div className="absolute bottom-[-1rem] left-[1.35rem] top-[3rem] w-[2px] rounded-full bg-slate-200/90 dark:bg-white/10">
                                <motion.div
                                    className="w-full origin-top rounded-full bg-gradient-to-b from-emerald-400 via-emerald-400 to-cyan-400/90"
                                    initial={false}
                                    animate={connectorFilled ? 'visible' : 'hidden'}
                                    variants={connectorFillVariants}
                                    transition={
                                        prefersReducedMotion
                                            ? { duration: 0.16, ease: 'linear' }
                                            : { duration: 0.42, ease: MOTION_EASE }
                                    }
                                />
                            </div>
                        )}

                        <div className="relative flex h-11 w-11 shrink-0 items-center justify-center">
                            {step.status === 'active' && (
                                <motion.span
                                    className={cn('absolute inset-0 rounded-full blur-[1px]', tones.halo)}
                                    initial={false}
                                    animate={
                                        prefersReducedMotion
                                            ? { opacity: 0.42 }
                                            : { opacity: [0.24, 0.5, 0.24], scale: [1, 1.08, 1] }
                                    }
                                    transition={
                                        prefersReducedMotion
                                            ? { duration: 0.16, ease: 'linear' }
                                            : { duration: 2.3, ease: 'easeInOut', repeat: Infinity }
                                    }
                                />
                            )}

                            <motion.div
                                className={cn(
                                    'relative z-10 flex h-10 w-10 items-center justify-center rounded-full border shadow-[0_10px_24px_rgba(15,23,42,0.08)] backdrop-blur-sm dark:shadow-none',
                                    tones.shell,
                                    tones.border
                                )}
                                initial={false}
                                animate={
                                    prefersReducedMotion
                                        ? { opacity: 1 }
                                        : {
                                            scale: step.status === 'active' ? 1.04 : 1,
                                            y: step.status === 'active' ? -1 : 0,
                                        }
                                }
                                transition={{ duration: 0.24, ease: MOTION_EASE }}
                            >
                                <AnimatePresence mode="wait" initial={false}>
                                    <motion.span
                                        key={`${step.id}-${step.status}`}
                                        className={cn('flex items-center justify-center', tones.icon)}
                                        initial={{ opacity: 0, scale: prefersReducedMotion ? 1 : 0.84 }}
                                        animate={{ opacity: 1, scale: 1 }}
                                        exit={{ opacity: 0, scale: prefersReducedMotion ? 1 : 0.9 }}
                                        transition={{ duration: 0.18, ease: MOTION_EASE }}
                                    >
                                        <StepIcon status={step.status} />
                                    </motion.span>
                                </AnimatePresence>
                            </motion.div>
                        </div>

                        <motion.div
                            className={cn('min-w-0', orientation === 'horizontal' ? 'mt-3' : 'pt-1')}
                            initial={false}
                            animate={
                                prefersReducedMotion
                                    ? { opacity: 1 }
                                    : { opacity: 1, y: step.status === 'active' ? -1 : 0 }
                            }
                            transition={{ duration: 0.22, ease: MOTION_EASE }}
                        >
                            <div
                                className={cn(
                                    'max-w-[8rem] text-center text-xs font-semibold leading-tight sm:max-w-[9rem] sm:text-sm',
                                    tones.label
                                )}
                            >
                                {step.label}
                            </div>
                            {step.description && (
                                <motion.div
                                    className="mt-1 max-w-[9rem] text-[11px] leading-tight text-slate-500 dark:text-slate-400"
                                    initial={false}
                                    animate={{ opacity: 1 }}
                                    transition={{ duration: 0.18, ease: MOTION_EASE }}
                                >
                                    {step.description}
                                </motion.div>
                            )}
                        </motion.div>
                    </div>
                );
            })}
        </div>
    );
};
