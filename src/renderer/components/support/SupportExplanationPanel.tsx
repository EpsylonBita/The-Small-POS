import React from 'react';
import { AlertTriangle, Info, ShieldAlert, Wrench } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type {
  SupportAction,
  SupportExplanation,
  SupportSeverity,
} from '../../support';

interface SupportExplanationPanelProps {
  explanation: SupportExplanation;
  busyActionId?: SupportAction['id'] | null;
  onAction: (actionId: SupportAction['id']) => void;
  onClose?: () => void;
}

const severityMeta: Record<
  SupportSeverity,
  {
    icon: React.ComponentType<{ className?: string }>;
    badgeClassName: string;
    borderClassName: string;
  }
> = {
  info: {
    icon: Info,
    badgeClassName: 'bg-sky-500/15 text-sky-700 dark:text-sky-300 border-sky-500/30',
    borderClassName: 'border-sky-500/20',
  },
  warning: {
    icon: AlertTriangle,
    badgeClassName:
      'bg-amber-500/15 text-amber-700 dark:text-amber-300 border-amber-500/30',
    borderClassName: 'border-amber-500/25',
  },
  high: {
    icon: Wrench,
    badgeClassName:
      'bg-orange-500/15 text-orange-700 dark:text-orange-300 border-orange-500/30',
    borderClassName: 'border-orange-500/25',
  },
  critical: {
    icon: ShieldAlert,
    badgeClassName: 'bg-red-500/15 text-red-700 dark:text-red-300 border-red-500/30',
    borderClassName: 'border-red-500/30',
  },
};

export const SupportExplanationPanel: React.FC<SupportExplanationPanelProps> = ({
  explanation,
  busyActionId = null,
  onAction,
  onClose,
}) => {
  const { t } = useTranslation();
  const meta = severityMeta[explanation.severity];
  const SeverityIcon = meta.icon;

  return (
    <div
      className={`liquid-glass-modal-card rounded-xl border p-3 space-y-3 ${meta.borderClassName}`}
      data-testid={`support-panel-${explanation.surface}`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <span
              className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${meta.badgeClassName}`}
            >
              <SeverityIcon className="w-3 h-3" />
              {t(`support.severity.${explanation.severity}`)}
            </span>
            {explanation.usedFallback && (
              <span className="text-[10px] font-medium text-slate-500 dark:text-slate-400">
                {t('support.panel.englishFallback')}
              </span>
            )}
          </div>
          <h4 className="text-sm font-bold text-black dark:text-white">
            {explanation.title}
          </h4>
          <p className="text-xs text-slate-700 dark:text-slate-300">
            {explanation.summary}
          </p>
        </div>
        {onClose ? (
          <button
            type="button"
            onClick={onClose}
            className="text-xs font-semibold text-slate-500 hover:text-slate-200"
          >
            {t('common.actions.close')}
          </button>
        ) : null}
      </div>

      <div className="space-y-1">
        <div className="text-[11px] font-bold uppercase tracking-wide text-black dark:text-white">
          {t('support.panel.why')}
        </div>
        <p className="text-xs text-slate-700 dark:text-slate-300">{explanation.why}</p>
      </div>

      {explanation.evidence.length > 0 && (
        <div className="space-y-2">
          <div className="text-[11px] font-bold uppercase tracking-wide text-black dark:text-white">
            {t('support.panel.evidence')}
          </div>
          <div className="grid gap-2 sm:grid-cols-2">
            {explanation.evidence.map((item) => (
              <div
                key={item.id}
                className="rounded-lg border border-white/10 bg-white/5 px-2.5 py-2"
              >
                <div className="text-[10px] font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
                  {t(item.labelKey, { defaultValue: item.fallbackLabel })}
                </div>
                <div className="mt-1 text-xs font-medium text-black dark:text-white break-words">
                  {item.value}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="space-y-2">
        <div className="text-[11px] font-bold uppercase tracking-wide text-black dark:text-white">
          {t('support.panel.nextSteps')}
        </div>
        <ul className="list-disc pl-5 space-y-1 text-xs text-slate-700 dark:text-slate-300">
          {explanation.steps.map((step, index) => (
            <li key={`${explanation.surface}-step-${index}`}>{step}</li>
          ))}
        </ul>
      </div>

      <div className="space-y-2">
        <div className="text-[11px] font-bold uppercase tracking-wide text-black dark:text-white">
          {t('support.panel.whenToEscalate')}
        </div>
        <ul className="list-disc pl-5 space-y-1 text-xs text-slate-700 dark:text-slate-300">
          {explanation.whenToEscalate.map((step, index) => (
            <li key={`${explanation.surface}-escalate-${index}`}>{step}</li>
          ))}
        </ul>
      </div>

      {explanation.actions.length > 0 && (
        <div className="flex flex-wrap gap-2 pt-1">
          {explanation.actions.map((action) => (
            <button
              key={action.id}
              type="button"
              onClick={() => onAction(action.id)}
              disabled={busyActionId === action.id}
              className={`rounded-lg px-3 py-1.5 text-xs font-semibold transition-all disabled:opacity-60 ${
                action.variant === 'primary'
                  ? 'bg-blue-500/20 hover:bg-blue-500/30 text-blue-700 dark:text-blue-300'
                  : 'bg-white/8 hover:bg-white/12 text-slate-700 dark:text-slate-200 border border-white/10'
              }`}
            >
              {busyActionId === action.id ? t('support.actions.running') : action.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
};
