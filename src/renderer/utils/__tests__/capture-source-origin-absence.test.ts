/**
 * supplier-email-ingest task 2.4 — the desktop half of the origin-label answer.
 *
 * Spec: `.claude/specs/supplier-email-ingest/tasks.md` task 2.4; requirements
 * R11.8, R11.9, R19.6. The design recorded as UNVERIFIED (F7, residual risk 5)
 * whether either POS client renders a source-kind label for a *supplier
 * invoice's origin*. If one did, the new `'email'` member of the shared
 * `CaptureSourceKind` union (decision E1) would need a plain-language label in
 * all five desktop locale files.
 *
 * **It does not, and this file is what keeps that answer true.** The two
 * `sourceKindKey(...)` label sites on this client both describe a *locally
 * produced* capture — the till's own capture queue and the capture-sources
 * picker — never the provenance of an invoice that arrived from somewhere
 * else. Nothing on the desktop reads `capture_metadata` or `email_metadata`
 * back off a supplier invoice, so there is no origin surface to translate for.
 * The correct change for this client was no change (R11.9, R19.6).
 *
 * The second assertion is the belt to that brace: `CAPTURE_SOURCE_KIND_KEYS`
 * is this client's own list of the five device kinds, deliberately *not* the
 * shared union, so `sourceKindKey` treats `'email'` as unknown and falls back
 * to a label that exists in every locale. A raw `email`, or a key with no
 * translation behind it, can therefore never reach a shopkeeper — even if a
 * server-minted capture did somehow reach the queue panel.
 *
 * If either assertion fails, an origin surface has appeared. Add the
 * plain-language `email` label to all five `src/locales/*.json` files and to
 * `CAPTURE_SOURCE_KIND_KEYS`, in the same change.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { CAPTURE_SOURCE_KIND_KEYS, sourceKindKey } from '../capture-review';
import { translateEn } from '../../test/en-translate';

const RENDERER_ROOT = resolve(__dirname, '..', '..');

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      return entry.name === '__tests__' || entry.name === 'test' ? [] : walk(full);
    }
    return /\.tsx?$/.test(entry.name) ? [full] : [];
  });
}

describe('supplier-invoice origin labels on the desktop POS', () => {
  it('labels only locally produced captures, so email needs no desktop translation', () => {
    const files = walk(RENDERER_ROOT);
    // Sanity: a walk that found nothing would make every assertion below vacuous.
    expect(files.length).toBeGreaterThan(50);

    const labelSites: string[] = [];
    const originReaders: string[] = [];

    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      const rel = relative(RENDERER_ROOT, file).split('\\').join('/');
      // Comments carry spec prose naming these very strings; scan code only.
      const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(?<!:)\/\/[^\n]*/g, '');

      if (/sourceKindKey\s*\(/.test(code)) labelSites.push(rel);
      if (/capture_metadata|captureMetadata|email_metadata|emailMetadata/.test(code)) {
        originReaders.push(rel);
      }
    }

    // The till's own capture queue, the capture-sources picker, and the helper
    // that builds the key — nothing that describes where an invoice came from.
    expect(labelSites.sort()).toEqual([
      'components/suppliers/CaptureQueuePanel.tsx',
      'components/suppliers/CaptureScanSettingsModal.tsx',
      'utils/capture-review.ts',
    ]);
    expect(originReaders.sort()).toEqual([]);
  });

  it('treats an email capture kind as unknown and still produces a translated sentence', () => {
    expect([...CAPTURE_SOURCE_KIND_KEYS]).not.toContain('email');

    const key = sourceKindKey('email');
    expect(key).toBe('suppliers.capture.sourceKind.file_pick');

    // The fallback must resolve to real copy, not to the key echoed back.
    const label = translateEn(key);
    expect(label).not.toBe(key);
    expect(label.trim().length).toBeGreaterThan(0);
  });
});
