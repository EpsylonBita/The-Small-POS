/**
 * Property-Based Tests for ModuleSyncService
 * 
 * **Feature: pos-module-sync, Property 2: Fallback to Cache on Error**
 * **Validates: Requirements 1.3, 4.1**
 * 
 * This test verifies that for any API error (network failure, timeout, 4xx/5xx response),
 * the module resolver returns null (indicating fallback to cache should be used).
 */

import * as fc from 'fast-check';
import { ModuleSyncService, ModuleSyncServiceConfig } from '../main/services/ModuleSyncService';

// Configure fast-check for minimum 100 iterations
fc.configureGlobal({
  numRuns: 100,
  verbose: true,
});

/**
 * Mock fetch implementation that simulates various error conditions
 */
function createMockFetch(behavior: 'network_error' | 'timeout' | 'http_error', httpStatus?: number) {
  return async (url: string, options?: RequestInit): Promise<Response> => {
    switch (behavior) {
      case 'network_error':
        throw new Error('Network error: Failed to fetch');
      
      case 'timeout':
        const error = new Error('The operation was aborted');
        error.name = 'AbortError';
        throw error;
      
      case 'http_error':
        return new Response(JSON.stringify({ error: 'Error' }), {
          status: httpStatus ?? 500,
          statusText: 'Error',
        });
      
      default:
        throw new Error('Unknown behavior');
    }
  };
}

/**
 * Arbitrary for generating valid terminal IDs
 */
const terminalIdArb = fc.stringMatching(/^terminal-[a-z0-9]{4,12}$/);

/**
 * Arbitrary for generating valid API keys
 */
const apiKeyArb = fc.stringMatching(/^[a-zA-Z0-9]{16,64}$/);

/**
 * Arbitrary for generating HTTP error status codes (4xx and 5xx)
 */
const httpErrorStatusArb = fc.oneof(
  fc.integer({ min: 400, max: 499 }), // 4xx client errors
  fc.integer({ min: 500, max: 599 }), // 5xx server errors
);

/**
 * Arbitrary for generating error types
 */
const errorTypeArb = fc.constantFrom('network_error', 'timeout', 'http_error') as fc.Arbitrary<'network_error' | 'timeout' | 'http_error'>;

describe('ModuleSyncService Property Tests', () => {
  // Store original fetch
  const originalFetch = global.fetch;

  afterEach(() => {
    // Restore original fetch after each test
    global.fetch = originalFetch;
  });

  /**
   * **Feature: pos-module-sync, Property 2: Fallback to Cache on Error**
   * **Validates: Requirements 1.3, 4.1**
   * 
   * Property: For any API error (network failure, timeout, 4xx/5xx response),
   * the module resolver SHALL return null, indicating that cached modules
   * should be used as fallback.
   */
  it('Property 2: Fallback to Cache on Error - returns null for any API error', async () => {
    await fc.assert(
      fc.asyncProperty(
        terminalIdArb,
        apiKeyArb,
        errorTypeArb,
        httpErrorStatusArb,
        async (terminalId, apiKey, errorType, httpStatus) => {
          // Setup mock fetch based on error type
          global.fetch = createMockFetch(errorType, httpStatus) as typeof fetch;

          // Create service instance
          const config: ModuleSyncServiceConfig = {
            adminDashboardUrl: 'http://localhost:3001',
            fetchTimeoutMs: 100, // Short timeout for tests
          };
          const service = new ModuleSyncService(config);

          // Execute fetch
          const result = await service.fetchEnabledModules(terminalId, apiKey);

          // Property assertion: result should be null for any error
          expect(result).toBeNull();
        }
      ),
      { verbose: true }
    );
  });

  /**
   * Additional property: Empty or invalid credentials should return null
   */
  it('Property 2a: Returns null for empty credentials', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom('', ' ', null as unknown as string, undefined as unknown as string),
        fc.constantFrom('', ' ', null as unknown as string, undefined as unknown as string),
        async (terminalId, apiKey) => {
          const config: ModuleSyncServiceConfig = {
            adminDashboardUrl: 'http://localhost:3001',
          };
          const service = new ModuleSyncService(config);

          // Should not make any network call, just return null
          const result = await service.fetchEnabledModules(terminalId, apiKey);

          expect(result).toBeNull();
        }
      ),
      { verbose: true }
    );
  });

  /**
   * Property: HTTP 401 errors should return null (for cache fallback)
   */
  it('Property 2b: Returns null for authentication errors (401)', async () => {
    await fc.assert(
      fc.asyncProperty(
        terminalIdArb,
        apiKeyArb,
        async (terminalId, apiKey) => {
          global.fetch = createMockFetch('http_error', 401) as typeof fetch;

          const config: ModuleSyncServiceConfig = {
            adminDashboardUrl: 'http://localhost:3001',
          };
          const service = new ModuleSyncService(config);

          const result = await service.fetchEnabledModules(terminalId, apiKey);

          expect(result).toBeNull();
        }
      ),
      { verbose: true }
    );
  });

  /**
   * Property: HTTP 404 errors should return null (for cache fallback)
   */
  it('Property 2c: Returns null for not found errors (404)', async () => {
    await fc.assert(
      fc.asyncProperty(
        terminalIdArb,
        apiKeyArb,
        async (terminalId, apiKey) => {
          global.fetch = createMockFetch('http_error', 404) as typeof fetch;

          const config: ModuleSyncServiceConfig = {
            adminDashboardUrl: 'http://localhost:3001',
          };
          const service = new ModuleSyncService(config);

          const result = await service.fetchEnabledModules(terminalId, apiKey);

          expect(result).toBeNull();
        }
      ),
      { verbose: true }
    );
  });

  /**
   * Property: Server errors (5xx) should return null (for cache fallback)
   */
  it('Property 2d: Returns null for server errors (5xx)', async () => {
    await fc.assert(
      fc.asyncProperty(
        terminalIdArb,
        apiKeyArb,
        fc.integer({ min: 500, max: 599 }),
        async (terminalId, apiKey, statusCode) => {
          global.fetch = createMockFetch('http_error', statusCode) as typeof fetch;

          const config: ModuleSyncServiceConfig = {
            adminDashboardUrl: 'http://localhost:3001',
          };
          const service = new ModuleSyncService(config);

          const result = await service.fetchEnabledModules(terminalId, apiKey);

          expect(result).toBeNull();
        }
      ),
      { verbose: true }
    );
  });
});
