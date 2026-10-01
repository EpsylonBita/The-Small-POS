import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { extractPrivilegedActionError } from '../../src/renderer/utils/privileged-actions';

const projectRoot = process.cwd();

test('extractPrivilegedActionError parses structured reauth errors', () => {
  const parsed = extractPrivilegedActionError(
    {
      code: 'REAUTH_REQUIRED',
      reason: 'Fresh PIN confirmation required',
      ttlSeconds: 300,
    },
    'cash_drawer_control',
  );

  assert.deepEqual(parsed, {
    code: 'REAUTH_REQUIRED',
    scope: 'cash_drawer_control',
    reason: 'Fresh PIN confirmation required',
    ttlSeconds: 300,
  });
});

test('extractPrivilegedActionError treats bare fresh PIN text as reauth', () => {
  const parsed = extractPrivilegedActionError(
    new Error('Fresh PIN confirmation required'),
    'cash_drawer_control',
  );

  assert.deepEqual(parsed, {
    code: 'REAUTH_REQUIRED',
    scope: 'cash_drawer_control',
    reason: 'Fresh PIN confirmation required',
    ttlSeconds: null,
  });
});

test('RecoveryCenterPanel routes visually safe recovery actions through privileged confirmation', () => {
  const source = fs.readFileSync(
    path.join(projectRoot, 'src', 'renderer', 'components', 'recovery', 'RecoveryCenterPanel.tsx'),
    'utf8',
  );

  assert.match(
    source,
    /runWithPrivilegedConfirmation\(\{\s*scope:\s*'cash_drawer_control'[\s\S]*action:\s*executeAction/,
    'recovery actions should pass through the privileged wrapper so native REAUTH_REQUIRED responses can open the PIN modal',
  );
  assert.doesNotMatch(
    source,
    /action\.safetyLevel\s*===\s*['"]safe['"]\s*\?\s*await executeAction\(\)/,
    'safe-labelled recovery actions must not bypass the wrapper because native commands may still request a fresh PIN',
  );
});

// Fix review 30/09/2026: with nobody on shift at this terminal the till asks
// a manager's own PIN and names what it approves.
test('extractPrivilegedActionError keeps the manager approval the till asks for', () => {
  const parsed = extractPrivilegedActionError(
    {
      code: 'REAUTH_REQUIRED',
      scope: 'cash_drawer_control',
      reason: 'No cashier or manager is on shift at this terminal: a manager approves with their own PIN',
      ttlSeconds: 300,
      approval: 'void_orders',
    },
    'cash_drawer_control',
  );

  assert.equal(parsed?.code, 'REAUTH_REQUIRED');
  assert.equal(parsed?.approval, 'void_orders');
});
