/**
 * Re-export from shared/pos/feature-mapping.ts
 *
 * This file exists for backward compatibility so existing desktop
 * imports continue to work. New code should import directly from
 * the shared package.
 */
export {
  FEATURE_KEY_MAPPING,
  mapServerFeaturesToLocal,
  type FeatureMapping,
} from '../../../shared/pos/feature-mapping';
