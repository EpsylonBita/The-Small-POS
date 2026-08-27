import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const projectRoot = process.cwd();

// The update dialog shows operators the changelog section matching the
// released version (extract-changelog-section.mjs). Without a per-version
// section the release ships the generic "Release vX.Y.Z" line, which tells
// the people running the till nothing. Every version bump must therefore
// land together with a human-written section for that version.

test('the version being shipped has a human changelog section', () => {
  const pkg = JSON.parse(
    readFileSync(path.join(projectRoot, 'package.json'), 'utf8'),
  ) as { version?: string };
  const version = String(pkg.version || '').trim();
  assert.ok(version, 'pos-tauri package.json must declare a version');

  const changelog = readFileSync(
    path.join(projectRoot, '..', 'docs', 'CHANGELOG.md'),
    'utf8',
  );
  const heading = new RegExp(
    `^##\\s*\\[?v?${version.replace(/\./g, '\\.')}\\]?\\s*$`,
    'm',
  );
  assert.match(
    changelog,
    heading,
    `docs/CHANGELOG.md needs a "## ${version}" section with plain-language notes ` +
      'for the update dialog — write what changed for the operator, in Greek.',
  );
});
