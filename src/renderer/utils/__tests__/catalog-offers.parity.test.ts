import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../lib', () => ({ isBrowser: () => false, getBridge: () => ({}) }));
vi.mock('../api-helpers', () => ({ posApiPost: vi.fn() }));

import {
  CATALOG_OFFER_PARITY_CASES,
  CATALOG_OFFER_PARITY_REWARD_ITEMS,
  summarizeCatalogOfferEvaluation,
  type CatalogOfferParityCase,
} from '../../../../../shared/catalog-offer.parity-cases';
import { guardItemSetTriggersForLegacyTills } from '../../../../../shared/types/catalog-offer';
import { evaluateCachedCatalogOffers, type CachedOffersPayload } from '../catalog-offers';

// The admin's `api/pos/offers/_shared.parity.test.ts` runs the same cases
// through the server's evaluator, which Android reaches online.
function payloadFor(parityCase: CatalogOfferParityCase): CachedOffersPayload {
  return {
    success: true,
    branch_id: 'branch-1',
    catalog_type: 'menu',
    offers: parityCase.offers,
    reward_items: [...CATALOG_OFFER_PARITY_REWARD_ITEMS],
  };
}

describe('desktop offline offer evaluation (shared parity cases)', () => {
  it.each(CATALOG_OFFER_PARITY_CASES.map((parityCase) => [parityCase.name, parityCase] as const))(
    '%s',
    (_name, parityCase) => {
      const result = evaluateCachedCatalogOffers(payloadFor(parityCase), parityCase.cart, 'menu');

      expect(summarizeCatalogOfferEvaluation(result)).toEqual(parityCase.expected);
    },
  );

  // branch_data.rs stores the /api/pos/offers payload as JSON text and hands
  // it back unchanged, item_ids included; an offline read must agree with a
  // fresh one.
  it.each(CATALOG_OFFER_PARITY_CASES.map((parityCase) => [parityCase.name, parityCase] as const))(
    'from the JSON cache: %s',
    (_name, parityCase) => {
      const cached = JSON.parse(JSON.stringify(payloadFor(parityCase))) as CachedOffersPayload;
      const result = evaluateCachedCatalogOffers(cached, parityCase.cart, 'menu');

      expect(summarizeCatalogOfferEvaluation(result)).toEqual(parityCase.expected);
    },
  );

  // GET /api/pos/offers marks set triggers with a category no cart line has,
  // so desktops up to 1.4.139 skip them; this build must not be affected.
  it.each(CATALOG_OFFER_PARITY_CASES.map((parityCase) => [parityCase.name, parityCase] as const))(
    'from the feed GET /api/pos/offers sends: %s',
    (_name, parityCase) => {
      const payload = payloadFor(parityCase);
      const fromFeed = { ...payload, offers: guardItemSetTriggersForLegacyTills(payload.offers ?? []) };
      const result = evaluateCachedCatalogOffers(fromFeed, parityCase.cart, 'menu');

      expect(summarizeCatalogOfferEvaluation(result)).toEqual(parityCase.expected);
    },
  );
});
