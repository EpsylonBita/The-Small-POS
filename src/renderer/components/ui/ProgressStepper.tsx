import React from 'react';
import { Check, X, Loader2, Circle } from 'lucide-react';
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

export const ProgressStepper: React.FC<ProgressStepperProps> = ({
    steps,
    className,
    orientation = 'horizontal'
}) => {
    return (
        <div className={cn(
            "flex w-full",
            orientation === 'vertical' ? "flex-col gap-4" : "flex-row justify-between items-start gap-2",
            className
        )}>
            {steps.map((step, index) => {
                const isLast = index === steps.length - 1;

                // Icon selection based on status
                let Icon = Circle;
                let iconColor = "text-white/40";
                let bgColor = "bg-white/5";
                let borderColor = "border-white/10";

                switch (step.status) {
                    case 'active':
                        Icon = Loader2;
                        iconColor = "text-cyan-400";
                        bgColor = "bg-cyan-500/10";
                        borderColor = "border-cyan-500/50";
                        break;
                    case 'complete':
                        Icon = Check;
                        iconColor = "text-emerald-400";
                        bgColor = "bg-emerald-500/10";
                        borderColor = "border-emerald-500/50";
                        break;
                    case 'error':
                        Icon = X;
                        iconColor = "text-red-400";
                        bgColor = "bg-red-500/10";
                        borderColor = "border-red-500/50";
                        break;
                    case 'pending':
                    default:
                        Icon = Circle;
                        iconColor = "text-white/40";
                        bgColor = "bg-white/5";
                        borderColor = "border-white/10";
                        break;
                }

                return (
                    <div key={step.id} className={cn(
                        "flex flex-1",
                        orientation === 'horizontal' ? "flex-col items-center text-center relative" : "flex-row items-center gap-4"
                    )}>
                        {/* Connector Line (Horizontal) */}
                        {!isLast && orientation === 'horizontal' && (
                            <div className="absolute top-4 left-[50%] right-[-50%] h-[2px] bg-white/10 -z-10">
                                <div
                                    className={cn(
                                        "h-full transition-all duration-500 ease-in-out",
                                        step.status === 'complete' ? "bg-emerald-500/50" : "bg-transparent"
                                    )}
                                />
                            </div>
                        )}

                        <div className={cn(
                            "w-8 h-8 rounded-full border backdrop-blur-sm flex items-center justify-center transition-all duration-300",
                            bgColor, borderColor
                        )}>
                            <Icon className={cn(
                                "w-4 h-4",
                                iconColor,
                                step.status === 'active' && "animate-spin"
                            )} />
                        </div>

                        <div className={cn(
                            "mt-2 transition-all duration-300",
                            orientation === 'vertical' && "mt-0"
                        )}>
                            <div className={cn(
                                "text-sm font-medium",
                                step.status === 'active' ? "text-white" : "text-white/60"
                            )}>
                                {step.label}
                            </div>
                            {step.description && (
                                <div className="text-xs text-white/40 mt-0.5">{step.description}</div>
                            )}
                        </div>
                    </div>
                );
            })}
        </div>
    );
};
