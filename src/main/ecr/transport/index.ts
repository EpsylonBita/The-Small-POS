/**
 * ECR Transport Module
 *
 * Exports transport implementations for ECR device communication.
 *
 * @module ecr/transport
 */

// Base transport
export {
  BaseECRTransport,
  ECRTransportState,
  ECRTransportEvent,
  DEFAULT_ECR_TRANSPORT_OPTIONS,
  type ECRTransportError,
} from './ECRTransport';

// Serial USB transport
export {
  SerialTransport,
  listSerialPorts,
  type SerialTransportOptions,
} from './SerialTransport';

// Bluetooth transport
export {
  BluetoothTransport,
  type BluetoothTransportOptions,
} from './BluetoothTransport';

// Network (TCP) transport
export {
  NetworkTransport,
  type NetworkTransportOptions,
} from './NetworkTransport';
