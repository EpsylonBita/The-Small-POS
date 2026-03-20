import { localeBundles } from '../../locales/bundles';
import { evaluateHealthSupportRules, evaluatePrinterSupportRules } from './rules';
import type {
  HealthSupportContext,
  PrinterSupportContext,
  SupportAction,
  SupportCopy,
  SupportExplanation,
  SupportIssueCode,
  SupportRuleResult,
  SupportSurface,
} from './types';

const LOCALE_BUNDLES = localeBundles;

type SupportedLocale = keyof typeof LOCALE_BUNDLES;

const SUPPORT_ACTION_LABEL_KEYS = {
  refresh_status: 'support.actions.refreshStatus',
  export_diagnostics: 'support.actions.exportDiagnostics',
  open_financial_panel: 'support.actions.openFinancialPanel',
  refresh_printer_diagnostics: 'support.actions.refreshPrinterDiagnostics',
  open_quick_setup: 'support.actions.openQuickSetup',
  edit_printer: 'support.actions.editPrinter',
  back_to_printers: 'support.actions.backToPrinters',
} as const;

function resolveLocale(language: string): {
  locale: SupportedLocale;
  usedEnglishLocaleFallback: boolean;
} {
  const lower = language.trim().toLowerCase();
  if (lower in LOCALE_BUNDLES) {
    return {
      locale: lower as SupportedLocale,
      usedEnglishLocaleFallback: false,
    };
  }

  const base = lower.split('-')[0];
  if (base in LOCALE_BUNDLES) {
    return {
      locale: base as SupportedLocale,
      usedEnglishLocaleFallback: false,
    };
  }

  return {
    locale: 'en',
    usedEnglishLocaleFallback: true,
  };
}

function getValue(source: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((current, key) => {
    if (!current || typeof current !== 'object' || Array.isArray(current)) {
      return undefined;
    }
    return (current as Record<string, unknown>)[key];
  }, source);
}

function isValidCopy(value: unknown): value is SupportCopy {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.title === 'string' &&
    typeof candidate.summary === 'string' &&
    typeof candidate.why === 'string' &&
    Array.isArray(candidate.steps) &&
    Array.isArray(candidate.whenToEscalate) &&
    candidate.ctaLabels !== null &&
    typeof candidate.ctaLabels === 'object'
  );
}

function resolveSupportCopy(
  surface: SupportSurface,
  issueCode: SupportIssueCode | null,
  language: string,
): { copy: SupportCopy; usedFallback: boolean } {
  const { locale, usedEnglishLocaleFallback } = resolveLocale(language);
  const bundle = LOCALE_BUNDLES[locale];
  const englishBundle = LOCALE_BUNDLES.en;
  const issuePath = issueCode ? `support.issues.${issueCode}` : null;
  const fallbackPath = `support.fallbacks.${surface}`;

  const localizedIssue = issuePath ? getValue(bundle, issuePath) : null;
  if (isValidCopy(localizedIssue)) {
    return { copy: localizedIssue, usedFallback: usedEnglishLocaleFallback };
  }

  const englishIssue = issuePath ? getValue(englishBundle, issuePath) : null;
  if (isValidCopy(englishIssue)) {
    return { copy: englishIssue, usedFallback: true };
  }

  const localizedFallback = getValue(bundle, fallbackPath);
  if (isValidCopy(localizedFallback)) {
    return { copy: localizedFallback, usedFallback: usedEnglishLocaleFallback };
  }

  const englishFallback = getValue(englishBundle, fallbackPath);
  if (isValidCopy(englishFallback)) {
    return { copy: englishFallback, usedFallback: true };
  }

  return {
    copy: {
      title: surface === 'health' ? 'System guidance' : 'Printer guidance',
      summary: 'No detailed guidance is available for this state yet.',
      why: 'The support content for this state is missing from the current locale bundle.',
      steps: ['Refresh the current screen.', 'Export diagnostics if the issue continues.'],
      whenToEscalate: ['Escalate if the problem blocks service or printing.'],
      ctaLabels: {},
    },
    usedFallback: true,
  };
}

function resolveActionLabel(
  actionId: SupportAction['id'],
  copy: SupportCopy,
  language: string,
): string {
  const { locale } = resolveLocale(language);
  const bundle = LOCALE_BUNDLES[locale];
  const englishBundle = LOCALE_BUNDLES.en;
  const issueLabel = copy.ctaLabels[actionId];
  if (typeof issueLabel === 'string' && issueLabel.trim()) {
    return issueLabel;
  }

  const globalKey = SUPPORT_ACTION_LABEL_KEYS[actionId];
  const localizedGlobal = getValue(bundle, globalKey);
  if (typeof localizedGlobal === 'string' && localizedGlobal.trim()) {
    return localizedGlobal;
  }

  const englishGlobal = getValue(englishBundle, globalKey);
  if (typeof englishGlobal === 'string' && englishGlobal.trim()) {
    return englishGlobal;
  }

  return actionId;
}

function buildExplanation(
  rule: SupportRuleResult | null,
  surface: SupportSurface,
  language: string,
): SupportExplanation {
  const { copy, usedFallback } = resolveSupportCopy(
    surface,
    rule?.issueCode ?? null,
    language,
  );

  return {
    surface,
    issueCode: rule?.issueCode ?? null,
    severity: rule?.severity ?? 'info',
    title: copy.title,
    summary: copy.summary,
    why: copy.why,
    steps: copy.steps,
    whenToEscalate: copy.whenToEscalate,
    evidence: rule?.evidence ?? [],
    actions:
      rule?.actions.map((action): SupportAction => ({
        id: action.id,
        label: resolveActionLabel(action.id, copy, language),
        variant: action.variant,
      })) ?? [],
    usedFallback,
  };
}

export function getHealthSupportExplanation(
  context: HealthSupportContext,
  language: string,
): SupportExplanation {
  return buildExplanation(evaluateHealthSupportRules(context), 'health', language);
}

export function getPrinterSupportExplanation(
  context: PrinterSupportContext,
  language: string,
): SupportExplanation {
  return buildExplanation(
    evaluatePrinterSupportRules(context),
    'printer',
    language,
  );
}
