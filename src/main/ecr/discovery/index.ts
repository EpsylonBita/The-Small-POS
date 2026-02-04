/**
 * ECR Discovery Module
 *
 * Exports discovery services for ECR device detection.
 *
 * @module ecr/discovery
 */

export {
  SerialDiscovery,
  SerialDiscoveryEvent,
} from './SerialDiscovery';

export {
  BluetoothDiscovery,
  BluetoothDiscoveryEvent,
} from './BluetoothDiscovery';
