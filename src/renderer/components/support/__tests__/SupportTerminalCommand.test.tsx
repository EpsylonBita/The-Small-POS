import { expect, it } from 'vitest';
import { TierThreeOnsiteRequestSchema } from '../SupportOnsiteSheet';
it('refuses withdrawn free-text on-site requests instead of showing an execute button', () => {
  expect(TierThreeOnsiteRequestSchema.safeParse({ request_id: 'your-request', session_id: 'your-session',
    title: 'support.onsite.title', description: '', terminal_command: { text: 'your-text', sha256: 'a'.repeat(64) } }).success).toBe(false);
});
