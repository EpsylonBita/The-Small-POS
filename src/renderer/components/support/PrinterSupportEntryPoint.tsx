import React, { useMemo, useState } from 'react';
import { LifeBuoy } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useI18n } from '../../contexts/i18n-context';
import type { PrinterSupportContext, SupportAction } from '../../support';
import { getPrinterSupportExplanation } from '../../support';
import { SupportExplanationPanel } from './SupportExplanationPanel';

interface PrinterSupportEntryPointProps {
  context: PrinterSupportContext;
  onRefreshDiagnostics?: () => Promise<void> | void;
  onOpenQuickSetup?: () => void;
  onEditPrinter?: () => void;
  onBackToPrinters?: () => void;
  showWhenFallback?: boolean;
  defaultOpen?: boolean;
}

export const PrinterSupportEntryPoint: React.FC<PrinterSupportEntryPointProps> = ({
  context,
  onRefreshDiagnostics,
  onOpenQuickSetup,
  onEditPrinter,
  onBackToPrinters,
  showWhenFallback = true,
  defaultOpen = false,
}) => {
  const { t } = useTranslation();
  const { language } = useI18n();
  const explanation = useMemo(
    () => getPrinterSupportExplanation(context, language),
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
      if (actionId === 'refresh_printer_diagnostics') {
        await onRefreshDiagnostics?.();
        return;
      }
      if (actionId === 'open_quick_setup') {
        onOpenQuickSetup?.();
        return;
      }
      if (actionId === 'edit_printer') {
        onEditPrinter?.();
        return;
      }
      if (actionId === 'back_to_printers') {
        onBackToPrinters?.();
      }
    } finally {
      setBusyActionId(null);
    }
  };

  return (
    <div className="space-y-2" data-testid={`printer-support-entrypoint-${context.view}`}>
      <button
        type="button"
        onClick={() => setOpen((current) => !current)}
        className="inline-flex items-center gap-2 rounded-lg border border-blue-500/20 bg-blue-500/10 px-3 py-1.5 text-xs font-semibold text-blue-700 transition-colors hover:bg-blue-500/20 dark:text-blue-300"
      >
        <LifeBuoy className="w-4 h-4" />
        {t('support.actions.troubleshoot')}
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
