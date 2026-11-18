import type { OrderSyncNotice } from '../../lib/order-sync-notices';
import { RECOVERY_RECIPES } from '../components/recovery/sync-recovery-issues';
import { readHealthRemedyMatches, type RemedyTarget, type RendererRemedyMatch, type SupportTranslate } from './support/SupportMatcherBridge';

/** Staff may run only a shipped, safe, single-row match. Navigation, generic
 * retry buttons, bulk repairs and destructive remedies stay in Health. */
export function selectOrderNoticeRemedy(notice: OrderSyncNotice, matches: RendererRemedyMatch[]): RemedyTarget | null {
  for (const match of matches) {
    if (match.matches_now !== true || match.observation?.status !== 'fresh') { continue; }
    for (const target of match.targets) {
      const { action, issue } = target;
      if (!Object.values(RECOVERY_RECIPES).some(recipe => recipe.recipeId === action.recipeId && recipe.version === action.recipeVersion)) { continue; }
      if (action.safetyLevel !== 'safe' || action.routeTarget || (target.count ?? 1) !== 1) { continue; }
      const rowId = issue.params?.sampleItemId ?? issue.params?.queueId ?? issue.queueId ?? issue.entityId;
      if (String(rowId) !== notice.queueId.replace(/^financial:/, '') || issue.orderId !== notice.orderId) { continue; }
      return target;
    }
  }
  return null;
}
export async function readOrderNoticeRemedy(notice: OrderSyncNotice, t: SupportTranslate): Promise<RemedyTarget | null> {
  return selectOrderNoticeRemedy(notice, await readHealthRemedyMatches(t));
}
