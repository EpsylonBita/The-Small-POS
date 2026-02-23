#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');
const srcDir = path.join(rootDir, 'src');

const SOURCE_EXTENSIONS = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.mts',
  '.cts',
]);

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === 'target') {
      continue;
    }
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full, out);
      continue;
    }
    if (SOURCE_EXTENSIONS.has(path.extname(entry.name))) {
      out.push(full);
    }
  }
  return out;
}

const lineChecks = [
  {
    id: 'window.electron*',
    test: (line) => line.includes('window.electron') || line.includes('window.electronAPI'),
  },
  {
    id: 'window.isElectron',
    test: (line) => line.includes('window.isElectron'),
  },
  {
    id: "import 'electron'",
    test: (line) =>
      /\bimport\s+['"]electron['"]/.test(line) || /\bimport\s+.*\s+from\s+['"]electron['"]/.test(line),
  },
  {
    id: "require('electron')",
    test: (line) => /\brequire\(\s*['"]electron['"]\s*\)/.test(line),
  },
];

const violations = [];

for (const filePath of walk(srcDir)) {
  const rel = path.relative(rootDir, filePath).replaceAll('\\', '/');
  const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/);
  lines.forEach((line, index) => {
    for (const check of lineChecks) {
      if (check.test(line)) {
        violations.push({
          file: rel,
          line: index + 1,
          check: check.id,
          snippet: line.trim(),
        });
      }
    }
  });
}

if (violations.length > 0) {
  console.error('Native runtime contract failed: Electron surfaces found in src/.');
  for (const violation of violations) {
    console.error(
      ` - ${violation.file}:${violation.line} [${violation.check}] ${violation.snippet}`
    );
  }
  process.exitCode = 1;
} else {
  console.log('Native runtime contract passed: no Electron surfaces found in src/.');
}
