import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const projectRoot = process.cwd();
const hookPath = path.join(projectRoot, 'src', 'renderer', 'hooks', 'useKdsLiveDraftSync.ts');

const source = () => readFileSync(hookPath, 'utf8');

test('useKdsLiveDraftSync publishes and clears live drafts only through the local draft store', () => {
  const hook = source();

  assert.match(
    hook,
    /import \{\s*clearKdsLocalDraft,\s*publishKdsLocalDraft,[\s\S]*?\} from '\.\.\/services\/KdsLocalDraftStore';/,
    'live drafts must go to the in-memory local draft store',
  );
  assert.match(hook, /publishKdsLocalDraft\(\{\s*scope,\s*sessionId,/);
  assert.match(
    hook,
    /clearKdsLocalDraft\(published\.scope, published\.sessionId\)/,
    'cleanup must clear exactly the scope and session that were published',
  );
  assert.doesNotMatch(
    hook,
    /\bfetch\(|method:\s*'DELETE'|\/api\/|\.invoke\(/,
    'live drafts must not use a network DELETE, hosted API or IPC transport',
  );
});

test('useKdsLiveDraftSync drops queued publishes and clears the live draft after the modal closes', () => {
  const hook = source();

  assert.match(
    hook,
    /publishTokenRef\.current\s*\+=\s*1/,
    'closing/unmounting must invalidate queued publish work',
  );
  assert.match(
    hook,
    /return \(\) => \{\s*cancelPendingPublish\(\);\s*clearPublishedDraft\(\);\s*sessionIdRef\.current = null;\s*\};/,
    'closing the modal must cancel queued publishes, clear the published draft and end the draft session',
  );
  assert.match(
    hook,
    /useEffect\(\(\) => \(\) => \{\s*cancelPendingPublish\(\);\s*clearPublishedDraft\(\);\s*\}, \[cancelPendingPublish, clearPublishedDraft, scope\]\);/,
    'unmounting or a scope change must clear the draft published under the old scope',
  );
  assert.match(
    hook,
    /if \(token !== publishTokenRef\.current \|\| sessionIdRef\.current !== sessionId\) \{\s*return;\s*\}/,
    'a queued publish that fires after close must not republish the stale live draft',
  );
});
