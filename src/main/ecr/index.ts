/**
 * ECR Module
 *
 * Electronic Cash Register integration for bank POS payment terminals.
 * Supports Ingenico, Verifone, and PAX terminals via Bluetooth, Serial USB, and Network.
 *
 * @module ecr
 */

// Transport layer
export * from './transport';

// Discovery services
export * from './discovery';

// Protocol adapters
export * from './protocols';

// Services
export * from './services';

// IPC handlers
export * from './handlers';
