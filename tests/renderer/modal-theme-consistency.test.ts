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

test('shared liquid-glass modals use one translucent, contrast-safe light and dark surface contract', () => {
  assert.match(glassStyles, /--modal-surface:\s*rgba\(248,\s*250,\s*252,\s*0\.72\)/);
  assert.match(glassStyles, /--modal-surface-elevated:\s*rgba\(255,\s*255,\s*255,\s*0\.64\)/);
  assert.match(glassStyles, /--modal-surface-subtle:\s*rgba\(241,\s*245,\s*249,\s*0\.56\)/);
  assert.match(glassStyles, /--modal-border:\s*rgba\(15,\s*23,\s*42,\s*0\.14\)/);
  assert.match(glassStyles, /\.dark\s*\{[\s\S]*?--modal-surface:\s*rgba\(9,\s*9,\s*11,\s*0\.72\)/);
  assert.match(
    glassStyles,
    /\.liquid-glass-modal-shell\s*\{[\s\S]*?background:\s*var\(--modal-surface\)[\s\S]*?border:\s*1px solid var\(--modal-border\)/,
  );
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
  assert.match(menuItemModal, /className="liquid-glass-modal-input w-full pl-9 pr-8/);
  assert.match(menuItemModal, /className="liquid-glass-modal-footer flex-shrink-0/);
  assert.match(menuItemModal, /className="liquid-glass-modal-inset rounded-xl/);
  assert.match(menuItemModal, /className="liquid-glass-modal-icon-button flex h-9 w-9/);
  assert.match(menuItemModal, /className="liquid-glass-modal-inset rounded-3xl p-5/);
  assert.doesNotMatch(menuItemModal, /className="bg-black\/40 backdrop-blur-2xl border border-white\/20 rounded-3xl/);
});

test('plugin setup modal explicitly protects its heading, close control and form labels in light mode', () => {
  assert.match(integrationsPage, /className="plugin-setup-modal !max-w-(?:lg|2xl)"/);
  assert.match(
    glassStyles,
    /html:not\(\.dark\) \.plugin-setup-modal \.liquid-glass-modal-title\s*\{[\s\S]*?color:\s*#18181b !important/,
  );
  assert.match(
    glassStyles,
    /html:not\(\.dark\) \.plugin-setup-modal \.liquid-glass-modal-close\s*\{[\s\S]*?color:\s*#3f3f46/,
  );
  assert.match(
    glassStyles,
    /html:not\(\.dark\) \.plugin-setup-modal label\s*\{[\s\S]*?color:\s*#3f3f46/,
  );
});

test('Z report has distinct light and dark text, panel and control tokens', () => {
  assert.match(
    zReportModal,
    /\? 'z-report-glass-content !overflow-hidden !p-4 text-white'\s*:\s*'z-report-glass-content !overflow-hidden !p-4 text-slate-950'/,
  );
  assert.match(zReportModal, /const strongTextClass = isDarkTheme \? 'text-white' : 'text-slate-950'/);
  assert.match(zReportModal, /const modalInsetClassName = isDarkTheme[\s\S]*?: 'border-yellow-500\/25 bg-white\/70/);
  assert.match(
    glassStyles,
    /\.liquid-glass-modal-shell\.z-report-glass-shell\s*\{[\s\S]*?background:\s*rgba\(248,\s*250,\s*252,\s*0\.74\) !important/,
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
  assert.match(callerIdSection, /liquid-glass-modal-input/);
  assert.match(callerIdSection, /liquid-glass-modal-inset/);
  assert.match(callerIdSection, /liquid-glass-modal-footer/);

  assert.doesNotMatch(callerIdSection, /(?:text|bg|border|placeholder)-zinc-(?:[1-9]00|950)/);
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
