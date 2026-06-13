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
      args[token.slice(2, eqIdx)] = token.slice(eqIdx + 1);
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

function normalizeHeadingLabel(value) {
  return value
    .trim()
    .replace(/^\[/, '')
    .replace(/\].*$/, '')
    .replace(/^v/i, '')
    .toLowerCase();
}

function releaseNoteHeadingCandidates(version) {
  const normalizedVersion = version.trim().replace(/^v/i, '');
  return [normalizedVersion, 'unreleased'];
}

function extractSection(markdown, version) {
  const lines = markdown.split(/\r?\n/);
  const candidates = releaseNoteHeadingCandidates(version);
  const sections = [];

  for (let index = 0; index < lines.length; index += 1) {
    const match = /^##\s+(.+?)\s*$/.exec(lines[index]);
    if (!match) continue;

    const nextHeadingIndex = lines.findIndex((line, nextIndex) => (
      nextIndex > index && /^##\s+(.+?)\s*$/.test(line)
    ));
    const end = nextHeadingIndex === -1 ? lines.length : nextHeadingIndex;

    const headingLabel = normalizeHeadingLabel(match[1]);
    sections.push({
      label: headingLabel,
      heading: match[1].trim(),
      body: lines.slice(index + 1, end).join('\n').trim(),
    });
  }

  for (const candidate of candidates) {
    const section = sections.find((item) => item.label === candidate && item.body);
    if (section) {
      return `## ${section.heading}\n\n${section.body}`;
    }
  }

  return null;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const version = requiredArg(args, 'version');
  const changelogPath = path.resolve(requiredArg(args, 'changelog'));
  const outputPath = path.resolve(requiredArg(args, 'outputPath'));
  const fallback = args.fallback || `Release v${version}`;

  if (!fs.existsSync(changelogPath)) {
    throw new Error(`Changelog file not found: ${changelogPath}`);
  }

  const changelog = fs.readFileSync(changelogPath, 'utf8');
  const notes = extractSection(changelog, version) || fallback;
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${notes.trim()}\n`, 'utf8');
  console.log(`[extract-changelog-section] Wrote ${outputPath}`);
}

try {
  main();
} catch (error) {
  console.error(`[extract-changelog-section] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
