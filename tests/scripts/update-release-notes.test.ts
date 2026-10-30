import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  RELEASE_NOTES_LANGUAGE_HEADINGS,
  type ReleaseNotesLanguage,
} from '../../src/renderer/utils/release-notes.ts';

const projectRoot = process.cwd();
const extractScriptPath = path.join(projectRoot, 'scripts', 'extract-changelog-section.mjs');
const manifestScriptPath = path.join(projectRoot, 'scripts', 'generate-updater-manifest.mjs');

function spawnNodeScript(scriptPath: string, args: string[]) {
  return spawnSync(process.execPath, [scriptPath, ...args], {
    cwd: projectRoot,
    encoding: 'utf8',
  });
}

function runNodeScript(scriptPath: string, args: string[]) {
  const result = spawnNodeScript(scriptPath, args);

  assert.equal(
    result.status,
    0,
    `${path.basename(scriptPath)} failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  );
}

test('extract-changelog-section prefers the versioned changelog section', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'pos-release-notes-'));
  try {
    const changelogPath = path.join(dir, 'CHANGELOG.md');
    const outputPath = path.join(dir, 'notes.md');
    writeFileSync(
      changelogPath,
      [
        '# Changelog',
        '',
        '## [Unreleased]',
        '',
        '- Work in progress.',
        '',
        '## [1.2.3] - 2026-06-13',
        '',
        '### Fixed',
        '- Drawer closeout persisted correctly.',
      ].join('\n'),
      'utf8',
    );

    runNodeScript(extractScriptPath, [
      '--version',
      '1.2.3',
      '--changelog',
      changelogPath,
      '--outputPath',
      outputPath,
    ]);

    const notes = readFileSync(outputPath, 'utf8');
    assert.match(notes, /## \[1\.2\.3\]/);
    assert.match(notes, /Drawer closeout persisted correctly/);
    assert.doesNotMatch(notes, /Work in progress/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('extract-changelog-section keeps every language block of a multilingual section', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'pos-release-notes-i18n-'));
  try {
    const changelogPath = path.join(dir, 'CHANGELOG.md');
    const outputPath = path.join(dir, 'notes.md');
    const languages = Object.keys(RELEASE_NOTES_LANGUAGE_HEADINGS) as ReleaseNotesLanguage[];
    writeFileSync(
      changelogPath,
      [
        '# Changelog',
        '',
        '## 1.2.4',
        '',
        ...languages.flatMap((language) => [
          `### ${RELEASE_NOTES_LANGUAGE_HEADINGS[language]}`,
          '',
          `- Note for ${language}.`,
          '',
        ]),
        '## 1.2.3',
        '',
        `### ${RELEASE_NOTES_LANGUAGE_HEADINGS.el}`,
        '',
        '- Older Greek-only note.',
      ].join('\n'),
      'utf8',
    );

    runNodeScript(extractScriptPath, [
      '--version',
      '1.2.4',
      '--changelog',
      changelogPath,
      '--outputPath',
      outputPath,
    ]);

    // The whole section goes into latest.json and the GitHub release body;
    // the till picks its own language when it renders the notes.
    const notes = readFileSync(outputPath, 'utf8');
    assert.match(notes, /^## 1\.2\.4\n/);
    for (const language of languages) {
      assert.ok(
        notes.includes(`### ${RELEASE_NOTES_LANGUAGE_HEADINGS[language]}\n\n- Note for ${language}.`),
        `the extracted notes lost the ${language} block`,
      );
    }
    assert.doesNotMatch(notes, /Older Greek-only note/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// A `.sig` file as `tauri signer sign` writes it: one base64 line holding the
// minisign text. Only the trusted comment matters to the manifest script.
function tauriSignature(trustedComment: string) {
  return Buffer.from(
    [
      'untrusted comment: signature from tauri secret key',
      'RUSplaceholderFileSignature==',
      `trusted comment: ${trustedComment}`,
      'placeholderGlobalSignature==',
      '',
    ].join('\n'),
    'utf8',
  ).toString('base64');
}

function manifestArgs(dir: string, signature: string) {
  const signaturePath = path.join(dir, 'installer.sig');
  writeFileSync(signaturePath, signature, 'utf8');
  return [
    '--version',
    '1.2.3',
    '--releaseTag',
    'v1.2.3',
    '--repoOwner',
    'EpsylonBita',
    '--repoName',
    'The-Small-POS',
    '--assetFileName',
    'The Small POS_1.2.3_x64-setup.exe',
    '--signatureFilePath',
    signaturePath,
    '--outputPath',
    path.join(dir, 'latest.json'),
  ];
}

test('generate-updater-manifest embeds release notes from a file', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'pos-manifest-notes-'));
  try {
    const notesPath = path.join(dir, 'notes.md');
    const signature = tauriSignature(
      'timestamp:1793324498\tfile:The Small POS_1.2.3_x64-setup.exe\tversion:1.2.3',
    );

    writeFileSync(notesPath, '### Added\n- Update changelog preview.\n', 'utf8');

    runNodeScript(manifestScriptPath, [
      ...manifestArgs(dir, signature),
      '--notesFile',
      notesPath,
    ]);

    const manifest = JSON.parse(readFileSync(path.join(dir, 'latest.json'), 'utf8'));
    assert.equal(manifest.notes, '### Added\n- Update changelog preview.');
    assert.equal(manifest.version, '1.2.3');
    assert.equal(manifest.platforms['windows-x86_64'].signature, signature);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Updater 2.14 rejects these at install time anyway; refusing them here stops a
// release from publishing a latest.json the tills would refuse, or one whose
// signature does not bind the version (signed without --app-version).
test('generate-updater-manifest refuses a signature that carries no signed version', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'pos-manifest-unversioned-'));
  try {
    const result = spawnNodeScript(
      manifestScriptPath,
      manifestArgs(dir, tauriSignature('timestamp:1793324498\tfile:The Small POS_1.2.3_x64-setup.exe')),
    );

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /carries no signed version; sign with `tauri signer sign --app-version 1\.2\.3`/);
    assert.equal(existsSync(path.join(dir, 'latest.json')), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('generate-updater-manifest refuses a signature made for another version', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'pos-manifest-other-version-'));
  try {
    const result = spawnNodeScript(
      manifestScriptPath,
      manifestArgs(
        dir,
        tauriSignature('timestamp:1793324498\tfile:The Small POS_1.2.2_x64-setup.exe\tversion:1.2.2'),
      ),
    );

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Signature was made for version 1\.2\.2, not 1\.2\.3/);
    assert.equal(existsSync(path.join(dir, 'latest.json')), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
