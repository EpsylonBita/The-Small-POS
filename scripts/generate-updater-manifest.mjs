#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;

    const eqIdx = token.indexOf('=');
    if (eqIdx > -1) {
      const key = token.slice(2, eqIdx);
      const value = token.slice(eqIdx + 1);
      args[key] = value;
      continue;
    }

    const key = token.slice(2);
    const value = argv[i + 1];
    if (!value || value.startsWith('--')) {
      args[key] = 'true';
      continue;
    }
    args[key] = value;
    i += 1;
  }
  return args;
}

function requiredArg(args, key) {
  const value = args[key];
  if (!value || value === 'true') {
    throw new Error(`Missing required argument --${key}`);
  }
  return value;
}

function main() {
  const args = parseArgs(process.argv.slice(2));

  const version = requiredArg(args, 'version');
  const releaseTagInput = requiredArg(args, 'releaseTag');
  const repoOwner = requiredArg(args, 'repoOwner');
  const repoName = requiredArg(args, 'repoName');
  const assetFileName = requiredArg(args, 'assetFileName');
  const signatureFilePath = requiredArg(args, 'signatureFilePath');

  const outputPath = path.resolve(args.outputPath || 'latest.json');
  const normalizedReleaseTag = releaseTagInput.startsWith('v')
    ? releaseTagInput
    : `v${releaseTagInput}`;
  const notes = args.notes || `Release ${normalizedReleaseTag}`;
  const pubDate = args.pubDate || new Date().toISOString();

  const signatureRaw = fs.readFileSync(path.resolve(signatureFilePath), 'utf8');
  const signatureLines = signatureRaw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const base64Candidates = signatureLines.filter((line) => /^[A-Za-z0-9+/=]+$/.test(line));
  const signature = base64Candidates.sort((a, b) => b.length - a.length)[0] || '';
  if (!signature) {
    throw new Error(`No base64 signature payload found in: ${signatureFilePath}`);
  }

  const downloadUrl = `https://github.com/${repoOwner}/${repoName}/releases/download/${normalizedReleaseTag}/${assetFileName}`;
  const manifest = {
    version,
    notes,
    pub_date: pubDate,
    platforms: {
      'windows-x86_64': {
        signature,
        url: downloadUrl,
      },
    },
  };

  fs.writeFileSync(outputPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  console.log(`[generate-updater-manifest] Wrote ${outputPath}`);
}

try {
  main();
} catch (error) {
  console.error(`[generate-updater-manifest] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
