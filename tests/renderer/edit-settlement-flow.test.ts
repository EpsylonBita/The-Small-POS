import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const orderDashboardSource = () =>
  readFileSync(
    path.join(process.cwd(), 'src', 'renderer', 'components', 'OrderDashboard.tsx'),
    'utf8',
  );

test('paid pickup edit collect flow waits for payment choice before committing item changes', () => {
  const source = orderDashboardSource();
  const collectBranch = source.slice(
    source.indexOf('previews[0]?.requiredAction === "collect"'),
    source.indexOf('previews[0]?.requiredAction === "refund"'),
  );

  assert.ok(collectBranch.length > 0, 'collect branch should be present');
  assert.doesNotMatch(
    collectBranch,
    /const refreshedPreview = await bridge\.orders\.previewEditSettlement/,
    'pickup collect edits must not save first and then re-preview the settlement delta',
  );
  assert.doesNotMatch(
    collectBranch,
    /openEditSettlementCollectionPrompt\(refreshedPreview, request\)/,
    'pickup collect prompt should use the original preview instead of a post-save preview',
  );
  assert.match(
    collectBranch,
    /openEditSettlementCollectionPrompt\(previews\[0\], request\)/,
    'collect edits should open the settlement prompt with the original preview',
  );
});
