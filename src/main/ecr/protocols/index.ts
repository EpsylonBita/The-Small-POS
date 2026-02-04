/**
 * ECR Protocols Module
 *
 * Exports protocol implementations for ECR device communication.
 *
 * @module ecr/protocols
 */

// Base protocol adapter
export {
  BaseProtocolAdapter,
  ProtocolAdapterEvent,
  DEFAULT_PROTOCOL_CONFIG,
  type ProtocolAdapterConfig,
  type TransactionProgressCallback,
} from './ProtocolAdapter';

// Generic ECR Protocol
export {
  GenericECRProtocol,
  type GenericECRConfig,
} from './GenericECRProtocol';

// ZVT Protocol (Ingenico, Verifone)
export {
  ZVTProtocol,
  type ZVTConfig,
} from './ZVTProtocol';

// PAX Protocol
export {
  PAXProtocol,
  type PAXConfig,
} from './PAXProtocol';
