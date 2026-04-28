/**
 * Wave 8 H29 regression test for secure-session validation.
 *
 * Background: `pos-tauri/src/renderer/lib/secure-session-cache.ts` reads the
 * persisted session from the OS keyring and exposes a synchronous accessor
 * (`getSecureSessionSync`). Before H29, the keyring blob was accepted via a
 * bare `as SecureSessionUser` cast — a wrong-shape blob (e.g. `staffId: 42`
 * as a number) would survive the read and crash downstream code far from
 * the source.
 *
 * H29 added `validateSecureSessionUser(raw: unknown)` which asserts that
 * `staffId`, `branchId`, `terminalId`, and `organizationId` are non-empty
 * strings when present. On validation failure the cache stays `null` AND
 * the keyring entry is cleared so the next boot starts clean.
 *
 * This test seeds a corrupt blob into a stub bridge, runs the read path
 * (`hydrateSecureSession`), and asserts both effects.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  setBridge,
  resetBridge,
  type PlatformBridge,
} from '../../src/lib/ipc-adapter';
import {
  __resetForTesting,
  getSecureSessionSync,
  hydrateSecureSession,
} from '../../src/renderer/lib/secure-session-cache';

/**
 * Build a minimal stub bridge that only exposes `secureSession`. The other
 * namespaces are unused on this code path; the cast is intentional so the
 * test stays focused on the validator behaviour.
 */
function makeStubBridge(opts: {
  initialBlob: string | null;
  onClear: () => void;
}): PlatformBridge {
  return {
    secureSession: {
      get: async () => opts.initialBlob,
      set: async (_payload: string) => {},
      clear: async () => {
        opts.onClear();
      },
    },
  } as unknown as PlatformBridge;
}

test('H29: hydrateSecureSession rejects a corrupt blob and clears the keyring', async () => {
  // staffId is a number, not a string — exactly the shape that used to
  // slip through the bare `as SecureSessionUser` cast and crash later.
  const corruptBlob = JSON.stringify({
    staffId: 42,
    branchId: 'br-1',
    terminalId: 't-1',
    organizationId: 'org-1',
  });

  let cleared = false;
  const bridge = makeStubBridge({
    initialBlob: corruptBlob,
    onClear: () => {
      cleared = true;
    },
  });
  setBridge(bridge);
  __resetForTesting();

  try {
    await hydrateSecureSession();

    assert.equal(
      getSecureSessionSync(),
      null,
      'corrupt blob must be rejected — getSecureSessionSync should return null',
    );
    assert.equal(
      cleared,
      true,
      'corrupt blob must trigger keyring clear so next boot starts clean',
    );
  } finally {
    resetBridge();
    __resetForTesting();
  }
});

test('H29: hydrateSecureSession accepts a well-formed blob without clearing', async () => {
  // Negative case — without this we cannot tell whether the validator is
  // rejecting EVERYTHING (which would also satisfy the corrupt-blob test).
  const validBlob = JSON.stringify({
    staffId: 'staff-7',
    branchId: 'br-1',
    terminalId: 't-1',
    organizationId: 'org-1',
    sessionId: 'sess-abc',
    role: { name: 'cashier' },
  });

  let cleared = false;
  const bridge = makeStubBridge({
    initialBlob: validBlob,
    onClear: () => {
      cleared = true;
    },
  });
  setBridge(bridge);
  __resetForTesting();

  try {
    await hydrateSecureSession();

    const cached = getSecureSessionSync();
    assert.notEqual(cached, null, 'valid blob must be accepted');
    assert.equal(cached?.staffId, 'staff-7');
    assert.equal(cached?.organizationId, 'org-1');
    assert.equal(
      cleared,
      false,
      'valid blob must NOT trigger keyring clear',
    );
  } finally {
    resetBridge();
    __resetForTesting();
  }
});

test('H29: hydrateSecureSession rejects unparseable JSON and clears the keyring', async () => {
  // Edge case — malformed JSON is also a corrupted-blob path. The function
  // should treat it as "no session" AND clear the keyring entry so the next
  // boot is not stuck reading garbage.
  const garbage = '{not even json';

  let cleared = false;
  const bridge = makeStubBridge({
    initialBlob: garbage,
    onClear: () => {
      cleared = true;
    },
  });
  setBridge(bridge);
  __resetForTesting();

  try {
    await hydrateSecureSession();

    assert.equal(getSecureSessionSync(), null);
    assert.equal(cleared, true, 'unparseable JSON must trigger keyring clear');
  } finally {
    resetBridge();
    __resetForTesting();
  }
});
