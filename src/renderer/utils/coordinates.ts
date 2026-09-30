/**
 * The one coordinate reader for the desktop renderer.
 *
 * Symptom it fixes: a saved customer address without coordinates became the
 * point (0,0) ("Null Island") because `Number(null) === 0` passes
 * `Number.isFinite`. The zone check then reported that point as out of zone
 * (1,845 such checks at one store since May 2026), the geocoding recovery for
 * addresses without coordinates never ran, and the order silently lost its
 * delivery zone.
 *
 * Rule (shared with Android through the repo-root helper): null, undefined,
 * '' and whitespace are "no point", never 0; the exact point (0,0), a
 * non-finite or out-of-range value and half a pair are "no point" too. A
 * missing point means "the delivery zone was not checked", never out of zone.
 */
import {
  extractSavedAddressCoordinates as extractStrictSavedAddressPoint,
  toValidLatLng,
  type LatLng,
  type SavedAddressCoordinateFields,
} from '../../../../shared/utils/saved-address-coordinates';

export type { LatLng, SavedAddressCoordinateFields };
export { toValidLatLng };

/**
 * The real point stored on a saved address row (any accepted shape), or null.
 * Pure data reading: it does not apply the "#label" special-address zone skip;
 * zone-check callers use `extractSavedAddressCoordinates` from
 * saved-address-geolocation.ts for that.
 */
export function readSavedAddressPoint(
  address: SavedAddressCoordinateFields | null | undefined,
): LatLng | null {
  return extractStrictSavedAddressPoint(address);
}
