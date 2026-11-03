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
// Wave ΣΤ1: the kit tokens (--pos-s-*) switch with the theme, so they count as a light value and
// a dark override at once.
const KIT_SURFACE = /(?:^|\s)bg-\(--pos-s-(?:surface|surface-2|warn-bg|bad-bg|ok-bg)\)(?=\s|$)/;
const KIT_TEXT = /(?:^|\s)text-\(--pos-s-(?:fg|muted|warn|bad|ok)\)(?=\s|$)/;
const KIT_BORDER = /(?:^|\s)border-\(--pos-s-(?:border|warn|bad|ok)\)(?=\s|$)/;
const DARK_SURFACE = /(?:^|\s)dark:bg-\S+/;
const DARK_TEXT = /(?:^|\s)dark:text-\S+/;
const DARK_BORDER = /(?:^|\s)dark:border-\S+/;

// Founder 01/11: a raised button (.pos-raised, glassmorphism.css) takes the kit's raised surface and depth from the
// theme tokens, with no outline colour of its own.
const RAISED = /(?:^|\s)pos-raised(?=\s|$)/;

const describeMissingThemePairs = (classes: string, label: string): string[] => {
  const failures: string[] = [];
  if (RAISED.test(classes)) {
    if (!LIGHT_TEXT.test(classes) && !KIT_TEXT.test(classes)) failures.push(`${label}: missing readable light text`);
    return failures;
  }
  if (!LIGHT_SURFACE.test(classes) && !KIT_SURFACE.test(classes)) failures.push(`${label}: missing readable light background`);
  if (!LIGHT_TEXT.test(classes) && !KIT_TEXT.test(classes)) failures.push(`${label}: missing readable light text`);
  if (!DARK_SURFACE.test(classes) && !KIT_SURFACE.test(classes)) failures.push(`${label}: missing dark background override`);
  if (!DARK_TEXT.test(classes) && !KIT_TEXT.test(classes)) failures.push(`${label}: missing dark text override`);
  if (!DARK_BORDER.test(classes) && !KIT_BORDER.test(classes)) failures.push(`${label}: missing dark border override`);
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
  // Founder 31/10 («αυτό δεν έχει κάτι σε glass»): the shell is the shared glass shell, whose frost
  // and rim switch with the theme, over the shared glass scrim; its words use the kit fg.
  assert.match(mainShell, /(?:^|\s)liquid-glass-modal-shell(?=\s|$)/, 'Health uses the shared glass modal shell');
  assert.match(mainShell, KIT_TEXT, 'the glass shell words use the kit fg');
  assert.match(healthModal, /className="pos-glass-scrim absolute inset-0"/, 'the page behind is dimmed and blurred like every glass modal');
  assert.doesNotMatch(mainShell, /(?:^|\s)(?:dark:)?bg-/, 'no opaque or tinted shell fill over the glass');
  for (const card of ["cn('pos-frost rounded-3xl border p-5', visual.shell)", "cn('pos-frost mt-4 rounded-2xl border', liquidGlassModalTone('neutral'))", 'pos-frost rounded-2xl border border-(--pos-s-border) bg-(--pos-s-surface-2) px-3 py-2']) {
    assert.ok(healthModal.includes(card), `card frosts inside the glass shell: ${card}`);
  }

  // Founder 01/11 («πολλά πολλά πορτοκαλί, κάνε τα να εκφράζουν καταστάσεις»): the state card is the neutral
  // tone; only the headline and the status words carry the state colour (shared/pos/health/health-tone.ts).
  assert.match(healthModal, /const visual = \{\s*shell: liquidGlassModalTone\('neutral'\),\s*titleClassName: HEALTH_TONE_TEXT\[healthStateTone\(summary\.state\)\],/);
  assert.match(healthModal, /<HealthStateGlyph state=\{summary\.state\} \/>/, 'the state icon has no box: a filled glyph');
  assert.doesNotMatch(healthModal, /iconBox/);
  assert.match(healthModal, /className=\{cn\('mt-1 text-base font-bold', HEALTH_TONE_TEXT\[item\.tone\]\)\}/, 'each status word in its state colour');
  assert.match(healthModal, /<Send className=\{cn\('h-5 w-5 text-white', sendingSupport && 'animate-pulse'\)\} \/>/, 'only the send icon is white');
  assert.doesNotMatch(healthModal, /uppercase tracking/);

  // The compact layout groups support behind one disclosure. Check both real
  // neutral surfaces instead of requiring the retired duplicate sections.
  assert.match(
    healthModal,
    /<details\s+className=\{cn\('[^']+',\s*liquidGlassModalTone\('neutral'\)\)\}/,
    'support disclosure must use the shared light/dark neutral tone',
  );
  assert.match(
    healthModal,
    /<section\s+id=\{healthAdvancedId\}\s+className=\{cn\('[^']+',\s*liquidGlassModalTone\('neutral'\)\)\}/,
    'expanded technical details must use the shared light/dark neutral tone',
  );

  assert.deepEqual(failures, [], failures.join('\n'));
});

test('Health Status modal neutral controls have light bases and dark overrides', () => {
  const buttonClasses = [
    ...modalContent.matchAll(/<button\b[\s\S]*?className="([^"]+)"/g),
  ].map((match) => match[1]);

  // Amber/yellow/red/green opaque buttons intentionally use the same high-contrast
  // semantic palette in both themes. Neutral chrome must adapt explicitly.
  const neutralControls = buttonClasses.filter(
    (classes) =>
      !/\bbg-(?:amber|yellow|red|rose|emerald|green)-(?:400|500|600|700|800|900)\b/.test(
        classes,
      ) && !/(?:^|\s)pos-raised--yellow(?=\s|$)/.test(classes),
  );
  assert.ok(neutralControls.length >= 5, 'close, export, folder, advanced and refresh controls must be covered, including arrow-function handlers');

  for (const classes of buttonClasses.filter(classes => /\bbg-(?:amber|yellow)-400\b/.test(classes))) {
    assert.match(classes, /\btext-(?:black|slate-950)\b/, 'bright primary actions must retain a dark, readable foreground');
  }

  const failures = neutralControls.flatMap((classes, index) => {
    const label = `neutral control ${index + 1}`;
    const result: string[] = [];
    // Founder 01/11: the one shared close button takes the kit surface and words from glassmorphism.css.
    if (/(?:^|\s)liquid-glass-modal-close(?=\s|$)/.test(classes)) return result;
    // Founder 01/11: a raised button's surface comes from the theme tokens; its words still need a kit colour.
    if (RAISED.test(classes)) {
      if (!LIGHT_TEXT.test(classes) && !KIT_TEXT.test(classes)) result.push(`${label}: missing readable light text`);
      return result;
    }
    // Wave ΣΤ1: kit tokens switch with the theme (the solid footer buttons use them).
    if (!LIGHT_SURFACE.test(classes) && !KIT_SURFACE.test(classes)) result.push(`${label}: missing readable light background`);
    if (!LIGHT_TEXT.test(classes) && !KIT_TEXT.test(classes)) result.push(`${label}: missing readable light text`);
    if (!DARK_SURFACE.test(classes) && !KIT_SURFACE.test(classes)) result.push(`${label}: missing dark background override`);
    if (!DARK_TEXT.test(classes) && !KIT_TEXT.test(classes)) result.push(`${label}: missing dark text override`);
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
