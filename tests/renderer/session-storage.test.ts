/**
 * Wave 0 regression test for Critical C6 (sessionId in plain localStorage).
 *
 * On HEAD, `pos-tauri/src/renderer/App.tsx` persists the authenticated
 * session object — including `sessionId`, `staffId`, `branchId`, and
 * `organizationId` — to `localStorage` at three call-sites (lines 1049,
 * 1097, 1182 in the reviewed revision). Any script executing in the
 * renderer context, or any WebView compromise, can read a live session
 * credential directly.
 *
 * A full behavioural test would boot React with a stubbed Tauri IPC and
 * drive LoginPage → AuthContext → App. That harness is a Wave-5 follow-up
 * (frontend contract tightening). For Wave 0, we lock the bug in with a
 * source-level assertion over `App.tsx`: it MUST NOT call
 * `localStorage.setItem(...)` for any key whose name suggests it stores
 * session credentials.
 *
 * Wave 1's C6 fix moves session state to React state backed by the Tauri
 * secure store (via `storage.rs` keyring). After that change, this
 * assertion passes because the only remaining `localStorage.setItem`
 * calls in App.tsx are for non-secret hints (e.g. `terminal_configured`
 * flag).
 *
 * This test is intentionally a file-level lint. When Wave 5 lands a
 * proper renderer harness, replace with a behavioural test that drives
 * the login flow and snapshots `localStorage`.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

// Tests are bundled by esbuild into `node_modules/.cache/parity-tests/`
// and then executed via `node --test`, with `cwd` set to the project
// root (see `scripts/run-parity-tests.mjs`). We resolve source paths
// from `process.cwd()` instead of `__dirname` because the bundled
// module's `__dirname` points into the cache directory, not into the
// repository's real `tests/` tree.
const projectRoot = process.cwd();
const appTsxPath = path.resolve(projectRoot, 'src', 'renderer', 'App.tsx');
const loginPagePath = path.resolve(projectRoot, 'src', 'renderer', 'pages', 'LoginPage.tsx');

/**
 * Returns every `localStorage.setItem(...)` call captured from the given
 * source. Matches across multi-line arguments. The regex is intentionally
 * tolerant of whitespace/newlines inside the argument list.
 */
function collectLocalStorageSetItemCalls(src: string): string[] {
  const pattern = /localStorage\s*\.\s*setItem\s*\(\s*([^)]*?)\s*\)/gs;
  const matches: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = pattern.exec(src)) !== null) {
    matches.push(m[1]);
  }
  return matches;
}

/**
 * Keys that may legitimately be persisted in plain localStorage because
 * they are non-secret UX hints. Everything else is considered a
 * credential-bearing payload until proven otherwise.
 */
const KNOWN_NON_SECRET_KEY_SUBSTRINGS = [
  'terminal_configured',
  'ui.theme',
  'ui.lang',
  'ui.last_route',
];

test(
  'C6: App.tsx does not persist session credentials to localStorage',
  () => {
    // If the file is missing, fail loudly — a rename without updating
    // this test would silently hide the regression.
    assert.ok(
      fs.existsSync(appTsxPath),
      `App.tsx not found at ${appTsxPath} — update this test path if the file moved.`,
    );

    const src = fs.readFileSync(appTsxPath, 'utf8');
    const calls = collectLocalStorageSetItemCalls(src);

    const suspicious = calls.filter((args) => {
      // Heuristic: any setItem whose args mention session / staff / auth
      // / session-scoped identity fields is a smell until the migration
      // to secure storage lands.
      const suspect = /session|sessionId|staffId|staff_id|branchId|branch_id|organizationId|organization_id|auth|token|pin|passcode/i.test(
        args,
      );
      if (!suspect) return false;
      // Allow explicit exceptions.
      return !KNOWN_NON_SECRET_KEY_SUBSTRINGS.some((k) => args.includes(k));
    });

    assert.deepEqual(
      suspicious,
      [],
      `App.tsx still persists credential-bearing values to localStorage (found ${suspicious.length} call(s)). ` +
        `Wave 1 C6 must move these to Tauri secure storage (see storage.rs keyring helpers). ` +
        `Offending arguments:\n${suspicious.map((s) => `  - ${s}`).join('\n')}`,
    );
  },
);

test(
  'C6: LoginPage.tsx does not re-persist credentials to localStorage',
  () => {
    assert.ok(
      fs.existsSync(loginPagePath),
      `LoginPage.tsx not found at ${loginPagePath} — update this test path if the file moved.`,
    );

    const src = fs.readFileSync(loginPagePath, 'utf8');
    const calls = collectLocalStorageSetItemCalls(src);

    const suspicious = calls.filter((args) => {
      const suspect = /pin|passcode|session|staffId|staff_id|auth|token/i.test(args);
      return suspect && !KNOWN_NON_SECRET_KEY_SUBSTRINGS.some((k) => args.includes(k));
    });

    assert.deepEqual(
      suspicious,
      [],
      `LoginPage.tsx still writes credential-bearing values to localStorage. ` +
        `Wave 1 C6/C7 must route via secure storage. Offenders:\n${suspicious.map((s) => `  - ${s}`).join('\n')}`,
    );
  },
);
