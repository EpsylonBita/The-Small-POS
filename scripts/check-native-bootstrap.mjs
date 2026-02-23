#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');
const entryPath = path.join(rootDir, 'src', 'main.tsx');
const source = fs.readFileSync(entryPath, 'utf8');

const forbidden = [
  'installElectronCompat',
  'startEventBridge',
  './lib/electron-compat',
  'window.electron',
  'window.electronAPI',
  'window.isElectron',
];

const violations = forbidden.filter((token) => source.includes(token));

if (!source.includes('getBridge')) {
  violations.push('missing-getBridge-bootstrap');
}

if (violations.length > 0) {
  console.error('Native bootstrap contract failed for src/main.tsx');
  for (const token of violations) {
    console.error(` - ${token}`);
  }
  process.exitCode = 1;
} else {
  console.log('Native bootstrap contract passed.');
}
