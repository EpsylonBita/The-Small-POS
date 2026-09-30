#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

if (process.platform !== 'win32') {
  process.stdout.write('Managed credential NSIS compile smoke skipped: Windows-only gate.\n');
  process.exit(0);
}

const projectRoot = process.cwd();
const localAppData = process.env.LOCALAPPDATA;
if (!localAppData) {
  throw new Error('LOCALAPPDATA is required to resolve the pinned Tauri NSIS compiler');
}

const candidates = [
  path.join(localAppData, 'tauri', 'NSIS', 'makensis.exe'),
  path.join(localAppData, 'tauri', 'NSIS', 'Bin', 'makensis.exe'),
];
const compiler = candidates.find((candidate) => fs.existsSync(candidate));
if (!compiler) {
  // The release job's pre-bundle verification runs before `tauri build` has
  // fetched the pinned NSIS toolchain. With a cold bundler-tools cache the
  // compiler is not there yet, and the cache is only saved by a successful
  // job, so refusing here deadlocked every release (29/09/2026, v1.4.119).
  // The release workflow opts into deferral for its pre-bundle steps only and
  // re-runs this smoke without the opt-in right after the NSIS bundle step,
  // before anything is published.
  if (process.env.THE_SMALL_POS_NSIS_SMOKE_ALLOW_DEFER === '1') {
    process.stdout.write(
      'Managed credential NSIS compile smoke deferred: the pinned Tauri makensis.exe is not provisioned yet; '
      + 'the release workflow re-runs this smoke strictly after the NSIS bundle step.\n',
    );
    process.exit(0);
  }
  throw new Error('Pinned Tauri makensis.exe is unavailable; refusing to skip Windows NSIS smoke');
}

const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'the-small-pos-nsis-smoke-'));
try {
  const fixturePath = path.join(projectRoot, 'tests', 'fixtures', 'managed-credential-cleanup-smoke.nsi');
  const hooksPath = path.join(projectRoot, 'src-tauri', 'nsis-hooks.nsh').replaceAll('\\', '\\\\');
  const outputPath = path.join(temporaryDirectory, 'managed-credential-cleanup-smoke.exe');
  const smokePath = path.join(temporaryDirectory, 'managed-credential-cleanup-smoke.nsi');
  const source = fs.readFileSync(fixturePath, 'utf8')
    .replace('OutFile "managed-credential-cleanup-smoke.exe"', `OutFile "${outputPath.replaceAll('\\', '\\\\')}"`)
    .replace('!include "..\\..\\src-tauri\\nsis-hooks.nsh"', `!include "${hooksPath}"`);
  fs.writeFileSync(smokePath, source, 'utf8');

  const result = spawnSync(compiler, ['/V2', smokePath], {
    cwd: temporaryDirectory,
    encoding: 'utf8',
    windowsHide: true,
  });
  if (result.status !== 0 || !fs.existsSync(outputPath)) {
    const diagnostic = `${result.stdout ?? ''}\n${result.stderr ?? ''}`.trim();
    throw new Error(`Managed credential NSIS compile smoke failed (${result.status}): ${diagnostic}`);
  }
  process.stdout.write('Managed credential NSIS compile smoke passed.\n');
} finally {
  fs.rmSync(temporaryDirectory, { recursive: true, force: true });
}
