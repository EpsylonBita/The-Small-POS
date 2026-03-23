import type {
  CatalogOffer,
  CatalogOfferEvaluationResult,
  CatalogType,
  MatchedCatalogOffer,
  OfferEvaluationCartItem,
  RewardAction,
} from '../../../../shared/types/catalog-offer';
import { isCatalogOfferAvailableNow } from '../../../../shared/types/catalog-offer';
import { posApiPost } from './api-helpers';
import { getBridge, isBrowser } from '../../lib';

interface RewardItemDetails {
  item_id: string;
  item_name: string;
  item_name_en?: string | null;
  item_name_el?: string | null;
  category_id?: string | null;
  unit_price: number;
}

type MutableCartItem = OfferEvaluationCartItem;

type ConsumedQuantity = {
  item_id: string;
  category_id?: string | null;
  quantity: number;
  unit_price: number;
};

type CachedOffersPayload = {
  success?: boolean;
  branch_id?: string;
  catalog_type?: CatalogType;
  offers?: CatalogOffer[];
  reward_items?: RewardItemDetails[];
};

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

function roundCurrency(value: number) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function cloneCartItems(items: MutableCartItem[]): MutableCartItem[] {
  return items.map((item) => ({ ...item }));
}

function getCartTotal(items: OfferEvaluationCartItem[]) {
  return roundCurrency(items.reduce((sum, item) => sum + item.unit_price * item.quantity, 0));
}

function takeSpecificItem(
  items: MutableCartItem[],
  itemId: string,
  quantity: number,
): ConsumedQuantity[] | null {
  let remaining = quantity;
  const consumed: ConsumedQuantity[] = [];

  for (const item of items) {
    if (item.item_id !== itemId || item.quantity <= 0) {
      continue;
    }

    const taken = Math.min(item.quantity, remaining);
    item.quantity -= taken;
    remaining -= taken;
    consumed.push({
      item_id: item.item_id,
      category_id: item.category_id ?? null,
      quantity: taken,
      unit_price: item.unit_price,
    });

    if (remaining <= 0) {
      break;
    }
  }

  return remaining > 0 ? null : consumed;
}

function takeCategoryItems(
  items: MutableCartItem[],
  categoryId: string,
  quantity: number,
): ConsumedQuantity[] | null {
  const candidates = items
    .filter((item) => item.category_id === categoryId && item.quantity > 0)
    .sort((left, right) => right.unit_price - left.unit_price);

  const availableQuantity = candidates.reduce((sum, item) => sum + item.quantity, 0);
  if (availableQuantity < quantity) {
    return null;
  }

  let remaining = quantity;
  const consumed: ConsumedQuantity[] = [];

  for (const item of candidates) {
    if (remaining <= 0) {
      break;
    }

    const taken = Math.min(item.quantity, remaining);
    item.quantity -= taken;
    remaining -= taken;
    consumed.push({
      item_id: item.item_id,
      category_id: item.category_id ?? null,
      quantity: taken,
      unit_price: item.unit_price,
    });
  }

  return remaining > 0 ? null : consumed;
}

function evaluateOfferAgainstRemainingCart({
  offer,
  remainingItems,
  rewardDetails,
}: {
  offer: CatalogOffer;
  remainingItems: MutableCartItem[];
  rewardDetails: Map<string, RewardItemDetails>;
}): { matched: MatchedCatalogOffer | null; nextRemainingItems: MutableCartItem[] } {
  const triggers = [...(offer.triggers ?? [])].sort(
    (left, right) => left.display_order - right.display_order,
  );
  const rewards = [...(offer.rewards ?? [])].sort(
    (left, right) => left.display_order - right.display_order,
  );

  if (triggers.length === 0 || rewards.length === 0) {
    return { matched: null, nextRemainingItems: remainingItems };
  }

  let workingState = cloneCartItems(remainingItems);
  let applications = 0;
  const allocationsByApplication: ConsumedQuantity[][] = [];

  let keepApplying = true;

  while (keepApplying) {
    const nextState = cloneCartItems(workingState);
    const applicationAllocations: ConsumedQuantity[] = [];
    let applicationValid = true;

    for (const trigger of triggers) {
      const allocations =
        trigger.trigger_type === 'specific_item'
          ? takeSpecificItem(nextState, trigger.item_id as string, trigger.quantity)
          : takeCategoryItems(nextState, trigger.category_id as string, trigger.quantity);

      if (!allocations || allocations.length === 0) {
        applicationValid = false;
        break;
      }

      applicationAllocations.push(...allocations);
    }

    if (!applicationValid) {
      break;
    }

    allocationsByApplication.push(applicationAllocations);
    workingState = nextState;
    applications += 1;
    keepApplying = offer.repeatable;
  }

  if (applications <= 0) {
    return { matched: null, nextRemainingItems: remainingItems };
  }

  let discountAmount = 0;
  const rewardActions: RewardAction[] = [];

  for (const applicationAllocations of allocationsByApplication) {
    const applicationSubtotal = applicationAllocations.reduce(
      (sum, allocation) => sum + allocation.quantity * allocation.unit_price,
      0,
    );

    for (const reward of rewards) {
      if (reward.reward_type === 'percent_off') {
        discountAmount += applicationSubtotal * ((reward.percent_off ?? 0) / 100);
        continue;
      }

      if (reward.reward_type === 'fixed_amount') {
        discountAmount += Math.min(reward.fixed_amount ?? 0, applicationSubtotal);
        continue;
      }

      const rewardItemId = reward.item_id;
      if (!rewardItemId) {
        continue;
      }

      const details = rewardDetails.get(rewardItemId);
      if (!details) {
        continue;
      }

      const firstConsumedItem = applicationAllocations[0];
      rewardActions.push({
        offer_id: offer.id,
        offer_name: offer.name,
        catalog_type: offer.catalog_type,
        reward_type: 'add_free_item',
        item_id: rewardItemId,
        item_name: details.item_name,
        item_name_en: details.item_name_en ?? null,
        item_name_el: details.item_name_el ?? null,
        category_id: details.category_id ?? null,
        quantity: reward.quantity,
        unit_price: details.unit_price,
        source_item_id: firstConsumedItem?.item_id ?? null,
        source_category_id: firstConsumedItem?.category_id ?? null,
      });
    }
  }

  return {
    matched: {
      offer_id: offer.id,
      offer_name: offer.name,
      catalog_type: offer.catalog_type,
      applications,
      discount_amount: roundCurrency(discountAmount),
      reward_actions: rewardActions,
    },
    nextRemainingItems: workingState,
  };
}

function evaluateCachedCatalogOffers(
  payload: CachedOffersPayload,
  cartItems: OfferEvaluationCartItem[],
  catalogType: CatalogType,
): CatalogOfferEvaluationResult {
  const branchId = payload.branch_id ?? '';
  const offers = (payload.offers ?? [])
    .filter((offer) => isCatalogOfferAvailableNow(offer))
    .sort((left, right) => {
      if (right.priority !== left.priority) {
        return right.priority - left.priority;
      }
      return right.created_at.localeCompare(left.created_at);
    });
  const rewardDetails = new Map<string, RewardItemDetails>(
    (payload.reward_items ?? []).map((item) => [item.item_id, item]),
  );

  let remainingItems = cloneCartItems(cartItems);
  const matchedOffers: MatchedCatalogOffer[] = [];

  for (const offer of offers) {
    const result = evaluateOfferAgainstRemainingCart({
      offer,
      remainingItems,
      rewardDetails,
    });

    if (!result.matched) {
      continue;
    }

    matchedOffers.push(result.matched);
    remainingItems = result.nextRemainingItems;
  }

  const cartTotal = getCartTotal(cartItems);
  const discountTotal = roundCurrency(
    matchedOffers.reduce((sum, offer) => sum + offer.discount_amount, 0),
  );
  const rewardActions = matchedOffers.flatMap((offer) => offer.reward_actions);

  return {
    branch_id: branchId,
    catalog_type: payload.catalog_type ?? catalogType,
    cart_total: cartTotal,
    discount_total: discountTotal,
    final_total: roundCurrency(Math.max(cartTotal - discountTotal, 0)),
    matched_offers: matchedOffers,
    reward_actions: rewardActions,
  };
}

export async function validateCatalogOffers(params: {
  catalogType: CatalogType;
  cartItems: OfferEvaluationCartItem[];
}): Promise<CatalogOfferEvaluationResult | null> {
  const { catalogType, cartItems } = params;
  if (cartItems.length === 0) {
    return null;
  }

  if (!isBrowser()) {
    const bridge = getBridge();
    const response = await bridge.branchData.getCatalogOffers({ catalog_type: catalogType });
    if (!response.success) {
      throw new Error(response.error || 'Failed to load catalog offers');
    }

    const payload = (response.data ?? {}) as CachedOffersPayload;
    if (payload.success === false) {
      throw new Error('Failed to load catalog offers');
    }

    return evaluateCachedCatalogOffers(payload, cartItems, catalogType);
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
