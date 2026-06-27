import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const projectRoot = process.cwd();
const releaseNotesPath = path.join(projectRoot, 'src', 'renderer', 'utils', 'release-notes.ts');
const updateDialogPath = path.join(projectRoot, 'src', 'renderer', 'components', 'UpdateDialog.tsx');
const updateNotificationPath = path.join(
  projectRoot,
  'src',
  'renderer',
  'components',
  'updates',
  'UpdateNotification.tsx',
);
const updateProgressPath = path.join(
  projectRoot,
  'src',
  'renderer',
  'components',
  'updates',
  'UpdateProgressModal.tsx',
);
const updateToastPath = path.join(
  projectRoot,
  'src',
  'renderer',
  'components',
  'updates',
  'UpdateToast.tsx',
);

test('update release notes render markdown changelogs safely', () => {
  const source = readFileSync(releaseNotesPath, 'utf8');

  assert.match(source, /export function releaseNotesMarkdownToHtml/);
  assert.match(source, /const SAFE_RELEASE_NOTE_TAGS = \[/);
  assert.match(source, /'code'/);
  assert.match(source, /DOMPurify\.sanitize\(html/);
  assert.match(source, /releaseNotesLooksLikeHtml\(trimmed\)\s*\?\s*trimmed\s*:\s*releaseNotesMarkdownToHtml\(trimmed\)/);
  assert.ok(source.includes('const heading = /^(#{1,4})\\s+(.+)$/.exec(line);'));
  assert.ok(source.includes('const unordered = /^[-*]\\s+(.+)$/.exec(line);'));
  assert.match(source, /ALLOWED_ATTR: \[\]/);
});

test('update dialog and notification share the release notes renderer', () => {
  const dialogSource = readFileSync(updateDialogPath, 'utf8');
  const notificationSource = readFileSync(updateNotificationPath, 'utf8');

  assert.match(dialogSource, /import \{ getReleaseNotesHtml \} from '\.\.\/utils\/release-notes'/);
  assert.match(dialogSource, /const releaseNotes = getReleaseNotesHtml\(updateInfo\?\.releaseNotes\)/);
  assert.match(dialogSource, /__html: releaseNotes/);
  assert.doesNotMatch(dialogSource, /DOMPurify\.sanitize/);

  assert.match(notificationSource, /import \{ getReleaseNotesHtml \} from '\.\.\/\.\.\/utils\/release-notes'/);
  assert.match(notificationSource, /getReleaseNotesHtml\(updateInfo\.releaseNotes\)/);
  assert.match(notificationSource, /__html: releaseNotesHtml/);
  assert.doesNotMatch(notificationSource, /DOMPurify\.sanitize/);
});

test('update dialog keeps update states on the POS palette without hover-only controls', () => {
  const source = readFileSync(updateDialogPath, 'utf8');

  assert.doesNotMatch(source, /hover:/);
  assert.doesNotMatch(source, /cyan-/);
  assert.doesNotMatch(source, /blue-/);
  assert.match(source, /border-4 border-amber-400 border-t-transparent/);
  assert.match(source, /text-amber-300/);
  assert.match(source, /h-full bg-amber-400/);
  assert.match(source, /bg-green-600/);
  assert.match(source, /active:bg-green-700/);
  assert.match(source, /bg-gray-600/);
  assert.match(source, /active:bg-gray-700/);
  assert.match(source, /rounded-2xl/);
  assert.match(source, /focus-visible:ring-amber-300\/80/);
});

test('secondary update surfaces use amber glass styling instead of cyan alerts', () => {
  const notificationSource = readFileSync(updateNotificationPath, 'utf8');
  const progressSource = readFileSync(updateProgressPath, 'utf8');
  const toastSource = readFileSync(updateToastPath, 'utf8');

  for (const source of [notificationSource, progressSource, toastSource]) {
    assert.doesNotMatch(source, /cyan-/);
    assert.doesNotMatch(source, /hover:/);
  }

  assert.match(notificationSource, /text-amber-300/);
  assert.match(progressSource, /h-full bg-amber-400/);
  assert.match(toastSource, /text-amber-200/);
  assert.match(toastSource, /border-amber-300\/35/);
  assert.match(toastSource, /bg-zinc-950\/90/);
  assert.match(toastSource, /active:scale-\[0\.98\]/);
  assert.match(toastSource, /focus-visible:ring-amber-300\/80/);
  assert.match(toastSource, /e\.preventDefault\(\)/);
});
