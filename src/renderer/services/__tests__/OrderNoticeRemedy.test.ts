// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { selectOrderNoticeRemedy } from '../OrderNoticeRemedy';
import type { RendererRemedyMatch } from '../support/SupportMatcherBridge';
const notice = { orderId: 'o', orderNumber: '1', queueId: 'q', since: '', kind: 'change_refused' as const, state: 'refused' as const, actions: [] };
const match = { id: 'invalid-driver-order-update.repair', version: 1, matches_now: true, target_count: 1,
  observation: { status: 'fresh', inputs: {} }, targets: [{ key: 'q', count: 1,
    issue: { orderId: 'o', params: { sampleItemId: 'q' } }, action: { id: 'repairInvalidDriverOrderUpdate', recipeId: 'invalid-driver-order-update.repair', recipeVersion: 1, safetyLevel: 'safe' } }] } as RendererRemedyMatch;
describe('the staff action is an exact shipped recipe', () => {
  it('selects the safe current exact row', () => { expect(selectOrderNoticeRemedy(notice, [match])).toEqual(match.targets[0]); });
  it.each(['unshipped', 'wrong-version', 'wrong-row', 'wrong-order', 'destructive', 'bulk', 'stale', 'navigation'])('rejects %s', reason => {
    const changed = structuredClone(match);
    const target = changed.targets[0];
    if (reason === 'unshipped') { target.action.recipeId = 'made-up-retry'; }
    if (reason === 'wrong-version') { target.action.recipeVersion = 9; }
    if (reason === 'wrong-row') { target.issue.params!.sampleItemId = 'other'; }
    if (reason === 'wrong-order') { target.issue.orderId = 'other'; }
    if (reason === 'destructive') { target.action.safetyLevel = 'destructive_local'; }
    if (reason === 'bulk') { changed.target_count = 2; target.count = 2; }
    if (reason === 'stale') { changed.observation!.status = 'stale'; }
    if (reason === 'navigation') { target.action.routeTarget = { screen: 'connectionSettings' }; }
    expect(selectOrderNoticeRemedy(notice, [changed])).toBeNull();
  });
  it('can select one row when the recipe also has other independent targets',()=>{
    const changed=structuredClone(match);
    const other=structuredClone(changed.targets[0]);other.issue.orderId='elsewhere';other.issue.params!.sampleItemId='other';
    changed.targets.unshift(other);changed.target_count=2;
    expect(selectOrderNoticeRemedy(notice,[changed])).toEqual(changed.targets[1]);
  });
});
