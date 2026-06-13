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
