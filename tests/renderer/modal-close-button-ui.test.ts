import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

// Founder 01/11/2026: «όλα τα Χ κουμπιά κλεισίματος να είναι ίδια σε όλα τα modal». Every window or panel close
// button is the shared .liquid-glass-modal-close: a 44 px round kit button with the same 20 px X.
const root = path.join(process.cwd(), 'src', 'renderer');
const css = readFileSync(path.join(root, 'styles', 'glassmorphism.css'), 'utf8');

// Icon-only X buttons that do something else than closing a window.
const NOT_A_WINDOW_CLOSE = [
  'components/AppWindowFrame.tsx', // the app window's own title-bar close
  'components/ui/ErrorAlert.tsx', // dismisses an inline alert
  'components/error/ErrorDisplay.tsx', // dismisses an inline error
  'pages/KitchenDisplayPage.tsx', // stops the external display
  'pages/CustomerDisplayPage.tsx', // stops the external display
];

const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return name === '__tests__' ? [] : walk(full);
    return full.endsWith('.tsx') ? [full] : [];
  });

test('the shared close button is a 44 px round raised kit button in both themes', () => {
  assert.match(
    css,
    /\.liquid-glass-modal-close \{[^}]*width: 44px;[^}]*height: 44px;[^}]*border-radius: 9999px;[^}]*background: var\(--pos-s-raised\);[^}]*box-shadow: var\(--pos-s-depth\);[^}]*color: var\(--pos-s-fg\);/,
  );
  assert.match(css, /\.liquid-glass-modal-close svg \{\s*width: 20px;\s*height: 20px;/);
  assert.doesNotMatch(css, /\.dark \.liquid-glass-modal-close \{/, 'the kit tokens switch with the theme; no dark override');
  // Founder 01/11: raised, not outlined — a transparent border keeps the size; pressed, it sinks.
  assert.match(css, /\.liquid-glass-modal-close \{[^}]*border: 1px solid transparent;/);
  assert.match(css, /:is\(\.pos-solid-btn, \.pos-icon-btn, \.pos-choice, \.pos-choice-card, \.liquid-glass-modal-button, \.liquid-glass-modal-close\):is\(:active, \[data-pressed\]\):not\(:disabled\) \{ box-shadow: var\(--pos-s-depth-press\); translate: 0 1px; \}/);
});

test('every window close button uses the shared close button', () => {
  const offenders: string[] = [];
  for (const file of walk(root)) {
    const rel = path.relative(root, file).split(path.sep).join('/');
    if (NOT_A_WINDOW_CLOSE.includes(rel)) continue;
    const source = readFileSync(file, 'utf8');
    for (const match of source.matchAll(/<button\b[\s\S]*?<\/button>/g)) {
      const button = match[0];
      if (button.length > 1400 || !/<X\b/.test(button)) continue;
      // A close: labelled «close» by a translation key.
      if (!/aria-label=\{t\(['"][\w.]*close['"]/i.test(button)) continue;
      // A backdrop that closes on tap is not a button anyone sees.
      if (/className="absolute inset-0/.test(button)) continue;
      if (!/liquid-glass-modal-close/.test(button)) {
        offenders.push(`${rel}:${source.slice(0, match.index).split('\n').length}`);
      }
    }
  }
  assert.deepEqual(offenders, [], `close buttons not using .liquid-glass-modal-close:\n${offenders.join('\n')}`);
});
