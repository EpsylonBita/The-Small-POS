import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  RELEASE_NOTES_LANGUAGE_HEADINGS,
  type ReleaseNotesLanguage,
  selectReleaseNotesForLanguage,
} from '../../src/renderer/utils/release-notes.ts';

const projectRoot = process.cwd();

// The update dialog shows operators the changelog section matching the
// released version (extract-changelog-section.mjs). Without a per-version
// section the release ships the generic "Release vX.Y.Z" line, which tells
// the people running the till nothing. Every version bump must therefore
// land together with a human-written section for that version.
//
// Founder rule 01/10/2026: that section is written in all six app languages,
// one block per language under the fixed heading the renderer looks for, so
// each till reads the notes in its own language.

const LANGUAGES = Object.keys(RELEASE_NOTES_LANGUAGE_HEADINGS) as ReleaseNotesLanguage[];

function shippedVersion(): string {
  const pkg = JSON.parse(
    readFileSync(path.join(projectRoot, 'package.json'), 'utf8'),
  ) as { version?: string };
  const version = String(pkg.version || '').trim();
  assert.ok(version, 'pos-tauri package.json must declare a version');
  return version;
}

function readChangelog(): string {
  return readFileSync(path.join(projectRoot, '..', 'docs', 'CHANGELOG.md'), 'utf8');
}

function versionHeading(version: string): RegExp {
  return new RegExp(`^##\\s*\\[?v?${version.replace(/\./g, '\\.')}\\]?\\s*$`, 'm');
}

function shippedSection(changelog: string, version: string): string {
  const heading = versionHeading(version).exec(changelog);
  assert.ok(heading, `docs/CHANGELOG.md has no "## ${version}" section`);
  const rest = changelog.slice(heading.index + heading[0].length);
  const next = /^##\s+\S/m.exec(rest);
  return `${heading[0]}${next ? rest.slice(0, next.index) : rest}`.trim();
}

function bulletCount(text: string): number {
  return text.split(/\r?\n/).filter((line) => /^[-*]\s+\S/.test(line)).length;
}

test('the version being shipped has a human changelog section', () => {
  const version = shippedVersion();
  assert.match(
    readChangelog(),
    versionHeading(version),
    `docs/CHANGELOG.md needs a "## ${version}" section with plain-language notes ` +
      'for the update dialog — write what changed for the operator, in all six app languages.',
  );
});

test('the shipped section carries one block per app language under the fixed heading', () => {
  const version = shippedVersion();
  const section = shippedSection(readChangelog(), version);
  const lines = section.split(/\r?\n/);

  for (const language of LANGUAGES) {
    const heading = `### ${RELEASE_NOTES_LANGUAGE_HEADINGS[language]}`;
    const count = lines.filter((line) => line.trim() === heading).length;
    assert.equal(
      count,
      1,
      `the "## ${version}" section needs exactly one "${heading}" block (${language}); found ${count}`,
    );
  }

  const greekBullets = bulletCount(selectReleaseNotesForLanguage(section, 'el'));
  assert.ok(greekBullets > 0, `the Greek block of "## ${version}" has no bullet points`);

  for (const language of LANGUAGES) {
    const selected = selectReleaseNotesForLanguage(section, language);
    assert.ok(
      selected.includes(`### ${RELEASE_NOTES_LANGUAGE_HEADINGS[language]}`),
      `the ${language} till must get its own block of "## ${version}"`,
    );
    for (const other of LANGUAGES.filter((item) => item !== language)) {
      assert.ok(
        !selected.includes(`### ${RELEASE_NOTES_LANGUAGE_HEADINGS[other]}`),
        `the ${language} till must not see the ${other} block of "## ${version}"`,
      );
    }
    assert.equal(
      bulletCount(selected),
      greekBullets,
      `the ${language} block of "## ${version}" must carry the same ${greekBullets} points as the Greek block`,
    );
  }
});
