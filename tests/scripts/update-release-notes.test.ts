import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const projectRoot = process.cwd();
const extractScriptPath = path.join(projectRoot, 'scripts', 'extract-changelog-section.mjs');
const manifestScriptPath = path.join(projectRoot, 'scripts', 'generate-updater-manifest.mjs');

function runNodeScript(scriptPath: string, args: string[]) {
  const result = spawnSync(process.execPath, [scriptPath, ...args], {
    cwd: projectRoot,
    encoding: 'utf8',
  });

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

test('generate-updater-manifest embeds release notes from a file', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'pos-manifest-notes-'));
  try {
    const notesPath = path.join(dir, 'notes.md');
    const signaturePath = path.join(dir, 'installer.sig');
    const outputPath = path.join(dir, 'latest.json');

    writeFileSync(notesPath, '### Added\n- Update changelog preview.\n', 'utf8');
    writeFileSync(signaturePath, 'trusted comment\nYWJjMTIz\n', 'utf8');

    runNodeScript(manifestScriptPath, [
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
      '--notesFile',
      notesPath,
      '--outputPath',
      outputPath,
    ]);

    const manifest = JSON.parse(readFileSync(outputPath, 'utf8'));
    assert.equal(manifest.notes, '### Added\n- Update changelog preview.');
    assert.equal(manifest.version, '1.2.3');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
