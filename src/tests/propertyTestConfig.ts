import * as fc from 'fast-check';

// Define defaults
const DEFAULT_NUM_RUNS = 100;
const DEFAULT_VERBOSE = true;

// Get configuration from environment variables if available
const numRuns = process.env.FAST_CHECK_NUM_RUNS
    ? parseInt(process.env.FAST_CHECK_NUM_RUNS, 10)
    : DEFAULT_NUM_RUNS;

const verbose = process.env.FAST_CHECK_VERBOSE
    ? process.env.FAST_CHECK_VERBOSE === 'true'
    : DEFAULT_VERBOSE;

// Configure global settings
fc.configureGlobal({
    numRuns,
    verbose,
});

export const propertyTestConfig = {
    numRuns,
    verbose,
};
