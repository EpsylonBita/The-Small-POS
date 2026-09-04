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
