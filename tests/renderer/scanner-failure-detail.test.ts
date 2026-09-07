/**
 * Live 06/09/2026 at Το Μικρό Παρίσι (HP DeskJet Ink Advantage 3788, LAN): the
 * scanner scanned, the POS said «Ο σαρωτής δεν απάντησε», and the log alone
 * knew why — "decode scanned page: The image format Bmp is not supported" and,
 * for the WSD twin entry, "the scanner produced no page". Three things keep
 * that from happening again, and this file pins each in source:
 *
 *   1. the image crate decodes BMP and TIFF, the formats WIA drivers hand back
 *      when they ignore the requested one;
 *   2. the capture client keeps the driver's `detail` instead of dropping it,
 *      and the settings modal shows it under the plain sentence;
 *   3. the eSCL entry lists before its WSD twin (pinned in Rust by
 *      `discovery_lists_the_escl_entry_before_the_wsd_twin`; here only the
 *      seam is checked).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const projectRoot = process.cwd();
const readSource = (relative: string) => readFileSync(path.join(projectRoot, relative), 'utf8');

test('the image crate is built with the formats WIA drivers actually return', () => {
  const cargo = readSource('src-tauri/Cargo.toml');
  const line = cargo.split('\n').find((candidate) => candidate.startsWith('image = '));
  assert.ok(line, 'Cargo.toml declares the image crate');
  for (const feature of ['png', 'jpeg', 'bmp', 'tiff']) {
    assert.ok(line.includes(`"${feature}"`), `image crate feature ${feature} is enabled`);
  }
});

test('the capture client keeps the driver detail on a failed outcome', () => {
  const client = readSource('src/renderer/services/capture-client.ts');
  assert.match(client, /detail\?: string;/);
  assert.match(client, /typeof result\.detail === 'string'/);
});

test('the settings modal shows the detail under the sentence, and clears it with it', () => {
  const modal = readSource('src/renderer/components/suppliers/CaptureScanSettingsModal.tsx');
  assert.match(modal, /data-testid="capture-problem-detail"/);
  assert.match(modal, /suppliers\.capture\.settings\.problemDetail/);
  const failureSites = modal.match(/setProblemDetail\(outcome\.detail \?\? null\)/g) ?? [];
  assert.equal(failureSites.length, 2, 'both the list and the test-scan failure carry the detail');
  const clears = modal.match(/setProblem\(null\);\s*setProblemDetail\(null\);/g) ?? [];
  assert.ok(clears.length >= 3, 'every place that clears the sentence clears the detail');
});

test('the host orders discovered scanners with the eSCL entry first', () => {
  const wia = readSource('src-tauri/src/capture/wia.rs');
  assert.match(wia, /HostReply::Devices\(devices\) => Ok\(order_for_picker\(devices\)\)/);
  assert.match(wia, /pub fn order_for_picker/);
});
