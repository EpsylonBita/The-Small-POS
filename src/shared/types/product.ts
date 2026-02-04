/**
 * Product Types - Re-exports from root shared types
 *
 * This file re-exports product-related types from the root shared folder
 * to maintain consistency with the local @shared/* path alias.
 */

export type {
  BarcodeType,
  BarcodeSource,
  ProductBarcode,
  CreateProductBarcodeInput,
  BarcodeValidationResult,
  GenerateBarcodeOptions,
} from '../../../../shared/types/product';
