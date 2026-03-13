import type {
  CatalogOfferEvaluationResult,
  CatalogType,
  OfferEvaluationCartItem,
  RewardAction,
} from '../../../../shared/types/catalog-offer';
import { posApiPost } from './api-helpers';

export interface OfferRewardLineMetadata {
  is_offer_reward?: boolean;
  auto_added_by_offer?: boolean;
  offer_id: string;
  offer_name: string;
  reward_item_id: string;
  reward_item_category_id?: string | null;
  reward_source_item_id?: string | null;
  reward_source_category_id?: string | null;
  reward_signature: string;
}

export function buildOfferRewardSignature(action: RewardAction, occurrence: number): string {
  return [
    action.offer_id,
    action.item_id,
    action.source_item_id ?? 'none',
    action.source_category_id ?? 'none',
    occurrence,
  ].join(':');
}

export function mapRewardActionsWithSignatures(actions: RewardAction[]) {
  const occurrences = new Map<string, number>();

  return actions.map((action) => {
    const baseKey = [
      action.offer_id,
      action.item_id,
      action.source_item_id ?? 'none',
      action.source_category_id ?? 'none',
    ].join(':');
    const nextOccurrence = occurrences.get(baseKey) ?? 0;
    occurrences.set(baseKey, nextOccurrence + 1);

    return {
      action,
      signature: buildOfferRewardSignature(action, nextOccurrence),
    };
  });
}

export function isOfferRewardLine(item: unknown): item is OfferRewardLineMetadata {
  return (
    typeof item === 'object' &&
    item !== null &&
    (item as { is_offer_reward?: boolean }).is_offer_reward === true
  );
}

export async function validateCatalogOffers(params: {
  catalogType: CatalogType;
  cartItems: OfferEvaluationCartItem[];
}): Promise<CatalogOfferEvaluationResult | null> {
  const { catalogType, cartItems } = params;
  if (cartItems.length === 0) {
    return null;
  }

  const response = await posApiPost<CatalogOfferEvaluationResult>('pos/offers/validate', {
    catalog_type: catalogType,
    cart_items: cartItems,
  });

  if (!response.success) {
    throw new Error(response.error || 'Failed to validate catalog offers');
  }

  return response.data ?? null;
}
