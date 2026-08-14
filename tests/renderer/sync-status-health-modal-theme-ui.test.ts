import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { liquidGlassModalTone } from '../../src/renderer/styles/designSystem';

const baselineRef = process.env.SYNC_STATUS_THEME_SOURCE_REF;
const source = baselineRef
  ? execFileSync(
      'git',
      [
        'show',
        `${baselineRef}:pos-tauri/src/renderer/components/SyncStatusIndicator.tsx`,
      ],
      { cwd: path.resolve(process.cwd(), '..'), encoding: 'utf8' },
    )
  : readFileSync(
      path.join(process.cwd(), 'src', 'renderer', 'components', 'SyncStatusIndicator.tsx'),
      'utf8',
    );

const renderStart = source.indexOf('const renderDetailModal = () => {');
assert.notEqual(renderStart, -1, 'renderDetailModal must remain available');

const renderEnd = source.indexOf(
  '// =========================================================================',
  renderStart,
);
assert.notEqual(renderEnd, -1, 'renderDetailModal must end before the component render block');

const healthModal = source.slice(renderStart, renderEnd);
const shellStart = healthModal.indexOf('max-w-4xl');
assert.notEqual(shellStart, -1, 'Health Status modal shell must remain identifiable');

// Ignore the intentionally theme-independent page dimmer. Everything from the
// modal shell inward must carry a real light palette and an explicit dark override.
const modalContent = healthModal.slice(shellStart);

const LIGHT_SURFACE =
  /(?:^|\s)bg-(?:white(?:\/(?:[8-9]\d))?|(?:slate|zinc|neutral)-(?:50|100)(?:\/\d+)?|(?:red|rose|amber|yellow|emerald|green)-(?:50|100)(?:\/\d+)?)(?=\s|$)/;
const LIGHT_TEXT =
  /(?:^|\s)text-(?:(?:slate|zinc|neutral)-(?:700|800|900|950)|(?:red|rose|amber|yellow|emerald|green)-(?:700|800|900)|black)(?=\s|$)/;
const DARK_SURFACE = /(?:^|\s)dark:bg-\S+/;
const DARK_TEXT = /(?:^|\s)dark:text-\S+/;
const DARK_BORDER = /(?:^|\s)dark:border-\S+/;

const describeMissingThemePairs = (classes: string, label: string): string[] => {
  const failures: string[] = [];
  if (!LIGHT_SURFACE.test(classes)) failures.push(`${label}: missing readable light background`);
  if (!LIGHT_TEXT.test(classes)) failures.push(`${label}: missing readable light text`);
  if (!DARK_SURFACE.test(classes)) failures.push(`${label}: missing dark background override`);
  if (!DARK_TEXT.test(classes)) failures.push(`${label}: missing dark text override`);
  if (!DARK_BORDER.test(classes)) failures.push(`${label}: missing dark border override`);
  return failures;
};

test('shared Health Status state and section tones are readable in light and dark themes', () => {
  const failures = (['neutral', 'success', 'warning', 'danger'] as const).flatMap(
    (tone) => describeMissingThemePairs(liquidGlassModalTone(tone), `${tone} tone`),
  );

  assert.deepEqual(failures, [], failures.join('\n'));
});

test('Health Status modal shell, state cards, and sections opt into light-first theme contracts', () => {
  const failures: string[] = [];

  const mainShell = healthModal.match(/className="([^"]*max-w-4xl[^"]*)"/)?.[1];
  assert.ok(mainShell, 'main Health Status modal shell class must be present');
  failures.push(...describeMissingThemePairs(mainShell, 'main shell'));

  assert.match(
    healthModal,
    /healthy:\s*\{[\s\S]*?shell:\s*liquidGlassModalTone\('success'\)/,
    'healthy state card must use the shared success tone',
  );
  assert.match(
    healthModal,
    /attention:\s*\{[\s\S]*?shell:\s*liquidGlassModalTone\('warning'\)/,
    'attention state card must use the shared warning tone',
  );
  assert.match(
    healthModal,
    /support_needed:\s*\{[\s\S]*?shell:\s*liquidGlassModalTone\('danger'\)/,
    'support-needed state card must use the shared danger tone',
  );

  const neutralSectionCount =
    healthModal.match(/<section\b[\s\S]*?liquidGlassModalTone\('neutral'\)/g)?.length ?? 0;
  assert.ok(
    neutralSectionCount >= 3,
    'recommended actions, explanation, support actions, and advanced details must use the shared neutral tone',
  );

  assert.deepEqual(failures, [], failures.join('\n'));
});

test('Health Status modal neutral controls have light bases and dark overrides', () => {
  const buttonClasses = [
    ...modalContent.matchAll(/<button\b[^>]*className="([^"]+)"[^>]*>/gs),
  ].map((match) => match[1]);

  // Yellow/red/green opaque buttons intentionally use the same high-contrast
  // semantic palette in both themes. Neutral chrome must adapt explicitly.
  const neutralControls = buttonClasses.filter(
    (classes) =>
      !/\bbg-(?:yellow|red|rose|emerald|green)-(?:400|500|600|700|800|900)\b/.test(
        classes,
      ),
  );
  assert.ok(neutralControls.length >= 3, 'close, diagnostics, and advanced controls must be covered');

  const failures = neutralControls.flatMap((classes, index) => {
    const label = `neutral control ${index + 1}`;
    const result: string[] = [];
    if (!LIGHT_SURFACE.test(classes)) result.push(`${label}: missing readable light background`);
    if (!LIGHT_TEXT.test(classes)) result.push(`${label}: missing readable light text`);
    if (!DARK_SURFACE.test(classes)) result.push(`${label}: missing dark background override`);
    if (!DARK_TEXT.test(classes)) result.push(`${label}: missing dark text override`);
    return result;
  });

  assert.deepEqual(failures, [], failures.join('\n'));
});

test('Health Status guidance icons use readable foreground colors in light theme', () => {
  const guidanceStart = modalContent.indexOf('{summary.canContinueOrders ? (');
  const guidanceEnd = modalContent.indexOf(
    '{localizedHealthSummary.guidance}',
    guidanceStart,
  );
  assert.notEqual(guidanceStart, -1, 'guidance status icons must remain identifiable');
  assert.notEqual(guidanceEnd, -1, 'guidance text must remain identifiable');

  const guidanceMarkup = modalContent.slice(guidanceStart, guidanceEnd);
  const iconClasses = [
    ...guidanceMarkup.matchAll(
      /<(?:CheckCircle2|AlertTriangle|Clock)\b[^>]*className="([^"]+)"[^>]*\/>/g,
    ),
  ].map((match) => match[1]);
  assert.equal(iconClasses.length, 3, 'all three guidance-state icons must be covered');

  const readableLightForeground =
    /(?:^|\s)text-(?:(?:slate|zinc|neutral|emerald|green)-(?:600|700|800|900|950)|(?:red|rose)-(?:500|600|700|800|900)|(?:amber|yellow)-(?:700|800|900))(?=\s|$)/;
  const failures = iconClasses
    .map((classes, index) =>
      readableLightForeground.test(classes)
        ? null
        : `guidance icon ${index + 1}: light foreground is too pale (${classes})`,
    )
    .filter((failure): failure is string => failure !== null);

  assert.deepEqual(failures, [], failures.join('\n'));
});

test('Health Status modal render contains no unscoped dark-only surface or text utilities', () => {
  const classFragments = [
    ...modalContent.matchAll(
      /(?:className\s*=\s*"([^"]+)"|(?:shell|iconBox):\s*'([^']+)'|cn\(\s*'([^']+)')/g,
    ),
  ].map((match) => match[1] ?? match[2] ?? match[3]);

  const opaqueSemanticSurface =
    /(?:^|\s)bg-(?:red|rose|emerald|green)-(?:600|700|800|900)(?=\s|$)/;
  const darkOnlySurface =
    /^(?:bg-\[#(?:050505|0c0c0c|101008|1a1212|1d0e0e)\](?:\/\d+)?|bg-black(?:\/\d+)?|bg-white\/(?:5|7|8|10|12|\[0\.0\d+\]|\[0\.1[0-5]\])|border-white\/\S+)$/;
  const darkOnlyText =
    /^text-(?:white(?:\/\S+)?|(?:yellow|amber|red|slate)-(?:50|100|200|300))$/;

  const offenders = classFragments.flatMap((classes) => {
    const allowWhiteOnOpaqueSemanticColor = opaqueSemanticSurface.test(classes);
    const iconOnly = /(?:^|\s)h-\d+(?:\.5)?(?:\s|$)/.test(classes) &&
      /(?:^|\s)w-\d+(?:\.5)?(?:\s|$)/.test(classes) &&
      !/(?:^|\s)(?:text-(?:xs|sm|base|lg|xl|\d)|font-|leading-)/.test(classes);
    return classes
      .split(/\s+/)
      .filter((token) => !token.startsWith('dark:'))
      .filter(
        (token) =>
          darkOnlySurface.test(token) ||
          (darkOnlyText.test(token) && !allowWhiteOnOpaqueSemanticColor && !iconOnly),
      )
      .map((token) => `${token} in "${classes}"`);
  });

  assert.deepEqual(
    offenders,
    [],
    `dark-only modal utilities must be dark:-scoped and paired with light defaults:\n${offenders.join('\n')}`,
  );
});
