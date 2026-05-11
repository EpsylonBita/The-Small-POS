import test from 'node:test';
import assert from 'node:assert/strict';
import { extractPrivilegedActionError } from '../../src/renderer/utils/privileged-actions';

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
