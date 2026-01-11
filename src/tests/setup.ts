/**
 * Shared Jest setup file for property-based tests
 *
 * This file configures fast-check globally using the shared propertyTestConfig,
 * ensuring all property tests use environment-driven defaults instead of hard-coded values.
 */

import './propertyTestConfig';

// The propertyTestConfig module calls fc.configureGlobal() on import,
// so all tests automatically use the shared settings:
// - numRuns: from FAST_CHECK_NUM_RUNS env var or 100 (default)
// - verbose: from FAST_CHECK_VERBOSE env var or true (default)
