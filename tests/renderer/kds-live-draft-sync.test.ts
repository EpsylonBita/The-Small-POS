import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const projectRoot = process.cwd();
const hookPath = path.join(projectRoot, 'src', 'renderer', 'hooks', 'useKdsLiveDraftSync.ts');

const source = () => readFileSync(hookPath, 'utf8');

test('useKdsLiveDraftSync clears drafts with a query-string session id', () => {
  const hook = source();

  assert.match(
    hook,
    /encodeURIComponent\(sessionId\)/,
    'DELETE must pass session_id in the URL because DELETE bodies can be dropped by the native transport',
  );
  assert.doesNotMatch(
    hook,
    /method:\s*'DELETE'[\s\S]{0,120}body:\s*JSON\.stringify\(\{\s*session_id:\s*sessionId\s*\}\)/,
    'DELETE cleanup should not rely on a JSON body for session_id',
  );
});

test('useKdsLiveDraftSync removes in-flight publishes after the modal closes', () => {
  const hook = source();

  assert.match(
    hook,
    /draftSessionActiveRef\.current\s*=\s*false/,
    'closing/unmounting must mark the draft session inactive',
  );
  assert.match(
    hook,
    /publishTokenRef\.current\s*\+=\s*1/,
    'closing/unmounting must invalidate queued publish work',
  );
  assert.match(
    hook,
    /await clearDrafts\(sessionId\)/,
    'an in-flight publish that completes after close must delete the stale live draft',
  );
});
