import { describe, it, expect } from 'vitest';
import { KdsReadCoordinator } from '../KdsReadCoordinator';
describe('KDS read coordinator', () => {
  it('coalesces bursts, invalidates stale results and starts the new scope after the old request finishes', async () => {
    const owner = new KdsReadCoordinator();
    owner.configure('org/branch/terminal', true);
    let finish!: () => void;
    const accepted: string[] = [];
    const read = (name: string) => async (current: () => boolean) => { if (current()) accepted.push(name); };
    const old = owner.request(async current => { await new Promise<void>(resolve => { finish = resolve; }); if (current()) accepted.push('old'); });
    void owner.request(read('discarded1')); void owner.request(read('discarded2'));
    owner.configure('other-scope', true);
    void owner.request(read('new1')); void owner.request(read('new2'));
    finish(); await old;
    expect(accepted).toEqual(['new2']);
    owner.configure('', false);
    await owner.request(read('stopped'));
    expect(accepted).toEqual(['new2']);
  });
});
