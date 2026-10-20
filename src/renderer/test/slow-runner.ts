/**
 * Waiting budgets for multi-step modal flows on a loaded CI runner.
 *
 * Every StaffShiftModal check-in step swaps its pane inside
 * `AnimatePresence mode="wait"`, so each step waits for a real 0.22 s exit
 * animation driven by framer-motion's frame loop, and the role queries walk a
 * large modal DOM. On the Windows release runner (full vitest run ~18 min,
 * environment ~500 s) those frames stall: the desktop release failed on
 * 29/09/2026 and 06/10/2026 with a `findBy*` that ran out of Testing Library's
 * 1 s default while the modal was still finishing a step transition, and one
 * whole check-in flow took 4.7 s of vitest's 5 s test timeout.
 *
 * The budgets only lengthen how long a wait may take to succeed. A wait whose
 * condition never holds still fails, with the same error, once they run out.
 */
import { configure, getConfig } from '@testing-library/react';
import { beforeAll } from 'vitest';

export const SLOW_RUNNER_WAIT_TIMEOUT_MS = 8_000;
export const SLOW_RUNNER_TEST_TIMEOUT_MS = 30_000;

/**
 * Gives every `findBy*` and `waitFor` in the calling test file the slow-runner
 * budget, restoring the previous one after the file. Call it at the top level
 * of the file, and pass `{ timeout: SLOW_RUNNER_TEST_TIMEOUT_MS }` to its
 * `describe` so a whole flow gets the matching test budget.
 */
export function configureSlowRunnerWaits(): void {
  beforeAll(() => {
    const { asyncUtilTimeout } = getConfig();
    // The function form keeps React Testing Library's other options as they are.
    configure((current) => ({ ...current, asyncUtilTimeout: SLOW_RUNNER_WAIT_TIMEOUT_MS }));
    return () => configure((current) => ({ ...current, asyncUtilTimeout }));
  });
}
