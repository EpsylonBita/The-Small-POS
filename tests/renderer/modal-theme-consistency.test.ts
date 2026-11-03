import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import * as themeContext from '../../src/renderer/contexts/theme-context';

const readRendererFile = (...parts: string[]) =>
  readFileSync(path.join(process.cwd(), 'src', 'renderer', ...parts), 'utf8');

const glassStyles = readRendererFile('styles', 'glassmorphism.css');
const globalStyles = readRendererFile('styles', 'globals.css');
const menuItemModal = readRendererFile('components', 'menu', 'MenuItemModal.tsx');
const integrationsPage = readRendererFile('pages', 'IntegrationsPage.tsx');
const zReportModal = readRendererFile('components', 'modals', 'ZReportModal.tsx');
const updateDialog = readRendererFile('components', 'UpdateDialog.tsx');
const confirmDialog = readRendererFile('components', 'ui', 'ConfirmDialog.tsx');
const callerIdSection = readRendererFile('components', 'peripherals', 'CallerIdSection.tsx');
const printerSettingsModal = readRendererFile('components', 'modals', 'PrinterSettingsModal.tsx');

test('light theme clears a stale dark class from html and body portal roots', () => {
  const applyThemeToDocument = (
    themeContext as typeof themeContext & {
      applyThemeToDocument?: (
        document: Document,
        resolvedTheme: 'light' | 'dark',
        theme: 'light' | 'dark' | 'auto',
      ) => void;
    }
  ).applyThemeToDocument;

  assert.equal(
    typeof applyThemeToDocument,
    'function',
    'theme application must expose the DOM synchronization used by ThemeProvider',
  );

  const createElement = (initialClasses: string[]) => {
    const classes = new Set(initialClasses);
    const attributes = new Map<string, string>();
    return {
      classList: {
        toggle: (name: string, force?: boolean) => {
          const shouldAdd = force ?? !classes.has(name);
          if (shouldAdd) classes.add(name);
          else classes.delete(name);
          return shouldAdd;
        },
        contains: (name: string) => classes.has(name),
      },
      setAttribute: (name: string, value: string) => attributes.set(name, value),
      getAttribute: (name: string) => attributes.get(name) ?? null,
    };
  };

  const documentElement = createElement([]);
  const body = createElement(['dark']);
  const fakeDocument = { documentElement, body } as unknown as Document;

  applyThemeToDocument!(fakeDocument, 'light', 'light');

  assert.equal(documentElement.classList.contains('dark'), false);
  assert.equal(body.classList.contains('dark'), false);
  assert.equal(documentElement.getAttribute('data-theme'), 'light');
  assert.equal(body.getAttribute('data-theme'), 'light');
});

// UI audit wave 7 (founder-approved 30/10/2026): the shared modal surface is solid, not translucent.
test('shared liquid-glass modals use one neutral glass shell over opaque, contrast-safe controls', () => {
  // Founder 30/10 («γυαλί σε όλα»): the «Νέο ραντεβού» glass for every shared modal.
  assert.match(glassStyles, /--modal-glass:\s*rgba\(255, 255, 255, 0\.18\);/);
  assert.match(glassStyles, /\.dark\s*\{[\s\S]*?--modal-glass:\s*rgba\(9, 9, 11, 0\.55\);/);
  assert.match(
    glassStyles,
    /\.liquid-glass-modal-shell\s*\{[\s\S]*?background:\s*var\(--modal-glass\)[\s\S]*?border:\s*1px solid var\(--modal-glass-border\)[\s\S]*?backdrop-filter:\s*blur\(40px\)/,
  );
  // Controls stay opaque so text and fields read the same over any page.
  assert.match(glassStyles, /--modal-surface:\s*#ffffff;/);
  assert.match(glassStyles, /--modal-border:\s*#d4d4d8;/);
  assert.match(glassStyles, /\.dark\s*\{[\s\S]*?--modal-surface:\s*#18181b;/);
  assert.match(
    globalStyles,
    /\.liquid-glass-modal-input\s*\{[\s\S]*?background:\s*var\(--modal-control-bg\)[\s\S]*?border:\s*1px solid var\(--modal-border\)/,
  );
});

test('ingredient styling is scoped to the menu customizer instead of leaking into every modal', () => {
  assert.doesNotMatch(glassStyles, /\.liquid-glass-modal-shell \.font-medium/);
  assert.doesNotMatch(glassStyles, /\.liquid-glass-modal-shell \.text-green-500/);
  assert.match(glassStyles, /\.menu-item-customizer-modal \.ingredient-text-crisp/);
  assert.match(menuItemModal, /className="menu-item-customizer-modal max-w-5xl max-h-\[98vh\]"/);
});

test('menu item customizer uses theme-aware shared search, footer, controls and notes surfaces', () => {
  assert.match(menuItemModal, /className="liquid-glass-modal-input w-full h-11 pl-9 pr-8/);
  assert.match(menuItemModal, /className="liquid-glass-modal-footer shrink-0/);
  assert.match(menuItemModal, /className="liquid-glass-modal-inset rounded-xl/);
  // Founder 01/11/2026 («οχι ολα τα κουμπια εχουν βαθος»): the quantity steppers are the kit's raised round buttons.
  assert.match(menuItemModal, /className="pos-raised flex h-11 w-11 items-center justify-center rounded-full/);
  assert.match(menuItemModal, /className="liquid-glass-modal-inset rounded-3xl p-5/);
  assert.doesNotMatch(menuItemModal, /className="bg-black\/40 backdrop-blur-2xl border border-white\/20 rounded-3xl/);
});

test('plugin setup modal explicitly protects its heading, close control and form labels in light mode', () => {
  assert.match(integrationsPage, /className="plugin-setup-modal max-w-(?:lg|2xl)!"/);
  assert.match(
    glassStyles,
    /html:not\(\.dark\) \.plugin-setup-modal \.liquid-glass-modal-title\s*\{[\s\S]*?color:\s*#18181b !important/,
  );
  // Founder 01/11: one close button everywhere — the kit surface and words in both themes, no per-window override.
  assert.doesNotMatch(glassStyles, /\.plugin-setup-modal \.liquid-glass-modal-close\s*\{/);
  assert.match(
    glassStyles,
    /\.liquid-glass-modal-close \{[^}]*width: 44px;[^}]*border-radius: 9999px;[^}]*background: var\(--pos-s-raised\);[^}]*box-shadow: var\(--pos-s-depth\);[^}]*color: var\(--pos-s-fg\);/,
  );
  assert.match(
    glassStyles,
    /html:not\(\.dark\) \.plugin-setup-modal label\s*\{[\s\S]*?color:\s*#3f3f46/,
  );
});

test('Z report has distinct light and dark text, panel and control tokens', () => {
  assert.match(
    zReportModal,
    /\? 'z-report-glass-content overflow-hidden! p-4! text-white'\s*:\s*'z-report-glass-content overflow-hidden! p-4! text-slate-950'/,
  );
  assert.match(zReportModal, /const strongTextClass = isDarkTheme \? 'text-white' : 'text-slate-950'/);
  // Founder 31/10 («όχι μόνο το γυαλί»): the Z is glass like every modal -- the shared frost shell and
  // frost cards on it, from the modal tokens (which follow the theme), never white panels piled up.
  assert.match(zReportModal, /const modalInsetClassName = 'border-\(--modal-glass-card-border\) bg-\(--modal-glass-card\)';/);
  assert.match(
    glassStyles,
    /\.liquid-glass-modal-shell\.z-report-glass-shell\s*\{[\s\S]*?background:\s*var\(--modal-glass\) !important/,
  );
});

test('generic confirmation and update dialogs use semantic modal text and inset surfaces', () => {
  assert.match(confirmDialog, /liquid-glass-modal-text/);
  assert.match(confirmDialog, /liquid-glass-modal-text-muted/);
  assert.match(confirmDialog, /liquid-glass-modal-inset/);
  assert.match(updateDialog, /liquid-glass-modal-text/);
  assert.match(updateDialog, /liquid-glass-modal-text-muted/);
  assert.match(updateDialog, /liquid-glass-modal-inset/);
});

test('Caller ID settings use the shared light and dark modal theme contract', () => {
  assert.match(callerIdSection, /liquid-glass-modal-text/);
  assert.match(callerIdSection, /liquid-glass-modal-text-muted/);
  assert.match(callerIdSection, /liquid-glass-modal-inset/);
  assert.match(callerIdSection, /liquid-glass-modal-footer/);
  assert.match(callerIdSection, /liquid-glass-modal-button/);

  assert.doesNotMatch(callerIdSection, /(?:text|bg|border|placeholder)-zinc-(?:[1-9]00|950)/);
});

test('printer list verification, role, row and transport surfaces use shared semantic tones', () => {
  assert.match(
    printerSettingsModal,
    /const verificationTone[\s\S]*?liquidGlassModalTone\('success'\)[\s\S]*?liquidGlassModalTone\('warning'\)[\s\S]*?liquidGlassModalTone\('neutral'\)/,
  );
  assert.match(
    printerSettingsModal,
    /rolePrinters\.length > 0[\s\S]*?liquidGlassModalTone\('success'\)[\s\S]*?liquidGlassModalTone\('warning'\)[\s\S]*?liquidGlassModalTone\('neutral'\)/,
  );
  // UI audit wave 7Γ: each printer is a kit row with one status line and a neutral default badge.
  assert.match(printerSettingsModal, /data-printer-card className="pos-row"/);
  assert.match(printerSettingsModal, /<span className="pos-badge ms-2">\{t\('settings\.printer\.default'\)\}<\/span>/);
  // Audit 30/10: the card states readiness in plain words with a shared tone; transport, resolved
  // address and "transport unreachable" moved to Diagnostics.
  assert.match(printerSettingsModal, /<StatusLine tone=\{toneOf\(plain\.tone\)\}>\{plain\.label\}<\/StatusLine>/);

  const listStart = printerSettingsModal.indexOf('// Render printer list view');
  const listEnd = printerSettingsModal.indexOf('// Render add/edit form', listStart);
  const printerList = printerSettingsModal.slice(listStart, listEnd);
  assert.doesNotMatch(printerList, /transportLabel|getResolvedAddress|transportUnreachable/);
  assert.doesNotMatch(printerList, /className="p-3 rounded-lg bg-white\/5 border border-white\/10 flex items-center justify-between"/);
  assert.doesNotMatch(printerList, /className="px-2 py-0\.5 rounded-sm border border-white\/10 liquid-glass-modal-text-muted"/);
  assert.doesNotMatch(printerList, /className="px-2 py-0\.5 rounded-sm border border-amber-500\/30 text-amber-200"/);
});

test('printer setup selector and onboarding surfaces use shared light and dark tones', () => {
  // Audit 30/10: one clear way in. The list opens with "Add printer" (the guided setup) and a
  // secondary manual entry; no Quick/Expert segment and no technical warning box above the list.
  const selectorStart = printerSettingsModal.indexOf('const renderListView', printerSettingsModal.indexOf('// Render printer list view'));
  // UI audit wave 7Γ: "Add printer" is the yellow primary; manual entry sits under technicians.
  const selectorEnd = printerSettingsModal.indexOf('// Automatic printing: grouped by moment of the day', selectorStart);
  const selectorAndHint = printerSettingsModal.slice(selectorStart, selectorEnd);
  assert.match(selectorAndHint, /solidButton\('primary', 'md'\)[\s\S]*?settings\.printer\.addPrinter'/);
  assert.match(selectorAndHint, /settings\.printer\.addPrinterManually/);
  assert.doesNotMatch(selectorAndHint, /verificationFirstHint|setupMode === 'quick' \?|bg-white\/5|border-white\/10|text-amber-100/);

  // Discovery lives in the guided setup only; the separate discovery list is gone.
  assert.doesNotMatch(printerSettingsModal, /const renderDiscoverView|discoveredOnlyHint/);

  // Manual entry explains itself in one neutral line with a way back to the guided setup.
  const manualStart = printerSettingsModal.indexOf("t('settings.printer.manualEntryHint");
  assert.ok(manualStart > 0, 'manual entry hint must exist');
  const manualCard = printerSettingsModal.slice(printerSettingsModal.lastIndexOf('<div className={`', manualStart), manualStart);
  assert.match(manualCard, /liquidGlassModalTone\('neutral'\)/);
  assert.doesNotMatch(printerSettingsModal, /quickSetupFirstTitle|(?<!dark:)text-amber-100/);
});

test('printer wizard save busy state gates every modal-owned dismissal path', () => {
  assert.match(printerSettingsModal, /const \[wizardBusy, setWizardBusy\] = useState\(false\)/);
  assert.match(printerSettingsModal, /const wizardBusyRef = useRef\(false\)/);
  assert.match(printerSettingsModal, /const handleWizardBusyChange = useCallback\(\(busy: boolean\) => \{[\s\S]*?wizardBusyRef\.current = busy[\s\S]*?setWizardBusy\(busy\)[\s\S]*?\}, \[\]\)/);
  assert.match(printerSettingsModal, /onBusyChange=\{handleWizardBusyChange\}/);
  assert.match(printerSettingsModal, /if \(!wizardBusyRef\.current\) onClose\(\)/);
  assert.match(printerSettingsModal, /onClose=\{handleModalClose\}/);
  assert.match(printerSettingsModal, /closeOnBackdrop=\{!wizardBusy\}/);
  assert.match(printerSettingsModal, /closeOnEscape=\{!wizardBusy\}/);
});

test('modal inventory has no unthemed dark-only content outside the intentional order-type palette', () => {
  const rendererRoot = path.join(process.cwd(), 'src', 'renderer');
  const visit = (directory: string): string[] =>
    readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
      const absolutePath = path.join(directory, entry.name);
      if (entry.isDirectory()) return visit(absolutePath);
      return entry.name.endsWith('.tsx') ? [absolutePath] : [];
    });

  const offenders = visit(rendererRoot)
    .filter((file) => file !== path.join(rendererRoot, 'components', 'OrderFlow.tsx'))
    .filter((file) => {
      const source = readFileSync(file, 'utf8');
      if (!/<LiquidGlassModal|className="liquid-glass-modal-shell/.test(source)) return false;
      const hasHardDarkContent = /(?<!dark:)text-white|(?<!dark:)bg-black/.test(source);
      const hasThemeContract = /useTheme|resolvedTheme|isDark|dark:|liquid-glass-modal-text/.test(source);
      return hasHardDarkContent && !hasThemeContract;
    })
    .map((file) => path.relative(rendererRoot, file));

  assert.deepEqual(
    offenders,
    [],
    `modal sources with dark-only content and no theme contract: ${offenders.join(', ')}`,
  );
});
