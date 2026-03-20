import React, { useMemo, useState } from 'react';
import { HelpCircle } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useI18n } from '../../contexts/i18n-context';
import type { HealthSupportContext, SupportAction } from '../../support';
import { getHealthSupportExplanation } from '../../support';
import { SupportExplanationPanel } from './SupportExplanationPanel';

interface HealthSupportEntryPointProps {
  context: HealthSupportContext;
  onExportDiagnostics: () => Promise<void> | void;
  onRefreshStatus: () => Promise<void> | void;
  onOpenFinancialPanel?: () => void;
  showWhenFallback?: boolean;
  defaultOpen?: boolean;
}

export const HealthSupportEntryPoint: React.FC<HealthSupportEntryPointProps> = ({
  context,
  onExportDiagnostics,
  onRefreshStatus,
  onOpenFinancialPanel,
  showWhenFallback = true,
  defaultOpen = false,
}) => {
  const { t } = useTranslation();
  const { language } = useI18n();
  const explanation = useMemo(
    () => getHealthSupportExplanation(context, language),
    [context, language],
  );
  const [open, setOpen] = useState(defaultOpen);
  const [busyActionId, setBusyActionId] = useState<SupportAction['id'] | null>(null);

  if (!showWhenFallback && !explanation.issueCode) {
    return null;
  }

  const handleAction = async (actionId: SupportAction['id']) => {
    setBusyActionId(actionId);
    try {
      if (actionId === 'export_diagnostics') {
        await onExportDiagnostics();
        return;
      }
      if (actionId === 'refresh_status') {
        await onRefreshStatus();
        return;
      }
      if (actionId === 'open_financial_panel') {
        onOpenFinancialPanel?.();
      }
    } finally {
      setBusyActionId(null);
    }
  };

  return (
    <div className="space-y-2" data-testid="health-support-entrypoint">
      <button
        type="button"
        onClick={() => setOpen((current) => !current)}
        className="inline-flex items-center gap-2 rounded-lg border border-blue-500/20 bg-blue-500/10 px-3 py-1.5 text-xs font-semibold text-blue-700 transition-colors hover:bg-blue-500/20 dark:text-blue-300"
      >
        <HelpCircle className="w-4 h-4" />
        {t('support.actions.explain')}
      </button>

      {open && (
        <SupportExplanationPanel
          explanation={explanation}
          busyActionId={busyActionId}
          onAction={handleAction}
          onClose={() => setOpen(false)}
        />
      )}
    </div>
  );
};
