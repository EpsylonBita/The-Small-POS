import React from 'react';
import { Check, X } from 'lucide-react';
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

/**
 * Founder 01/11 («δεν έχουμε διορθώσει αυτά τα modals»): the check-in steps in the kit. A small numbered
 * circle per step: the current one is the kit selection (yellow, dark number), a finished one a tick in an
 * outline, a later one a plain outline (no fill on the glass); the line between two steps is solid once the first is done.
 * No colour stands for success (no green), no pulsing halo.
 */
const STEP_TONES: Record<StepStatus, { circle: string; label: string }> = {
    pending: {
        // No white disc on the glass (founder 01/11/2026: «βγαλε το ασπρο μεσα απο τους αριθμους»): outline only.
        circle: 'border-(--pos-s-control) bg-transparent text-(--pos-s-muted)',
        label: 'text-(--pos-s-muted)',
    },
    active: {
        circle: 'border-(--pos-s-sel-bg) bg-(--pos-s-sel-bg) text-(--pos-s-sel-fg)',
        label: 'font-semibold text-(--pos-s-fg)',
    },
    complete: {
        circle: 'border-(--pos-s-fg) bg-transparent text-(--pos-s-fg)',
        label: 'text-(--pos-s-fg)',
    },
    error: {
        circle: 'border-(--pos-s-bad) bg-(--pos-s-bad-bg) text-(--pos-s-bad)',
        label: 'text-(--pos-s-bad)',
    },
};

function StepMark({ status, index }: { status: StepStatus; index: number }) {
    if (status === 'complete') return <Check className="h-4 w-4" strokeWidth={2.6} />;
    if (status === 'error') return <X className="h-4 w-4" strokeWidth={2.6} />;
    return <span className="text-sm font-semibold leading-none">{index + 1}</span>;
}

export const ProgressStepper: React.FC<ProgressStepperProps> = ({
    steps,
    className,
    orientation = 'horizontal'
}) => {
    const vertical = orientation === 'vertical';

    return (
        <ol
            data-testid="progress-stepper"
            className={cn(
                'flex w-full',
                vertical ? 'flex-col gap-3' : 'flex-row items-start',
                className
            )}
        >
            {steps.map((step, index) => {
                const isLast = index === steps.length - 1;
                const tones = STEP_TONES[step.status];
                const lineDone = step.status === 'complete';

                return (
                    <li
                        key={step.id}
                        aria-current={step.status === 'active' ? 'step' : undefined}
                        className={cn(
                            'relative flex min-w-0 flex-1',
                            vertical ? 'flex-row items-center gap-3' : 'flex-col items-center text-center'
                        )}
                    >
                        {!isLast && !vertical && (
                            <span
                                aria-hidden="true"
                                className={cn(
                                    'absolute left-[calc(50%+1.25rem)] right-[calc(-50%+1.25rem)] top-[0.9rem] h-[2px] rounded-full',
                                    lineDone ? 'bg-(--pos-s-fg)' : 'bg-(--pos-s-border)'
                                )}
                            />
                        )}

                        <span
                            className={cn(
                                'relative z-10 flex h-7 w-7 shrink-0 items-center justify-center rounded-full border-2',
                                tones.circle
                            )}
                        >
                            <StepMark status={step.status} index={index} />
                        </span>

                        <span className={cn('min-w-0', vertical ? '' : 'mt-1.5')}>
                            <span className={cn('block max-w-36 text-sm leading-5', tones.label)}>
                                {step.label}
                            </span>
                            {step.description && (
                                <span className="mt-0.5 block max-w-36 text-xs leading-tight text-(--pos-s-muted)">
                                    {step.description}
                                </span>
                            )}
                        </span>
                    </li>
                );
            })}
        </ol>
    );
};
