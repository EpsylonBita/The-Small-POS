import { describe, expect, it, vi } from 'vitest';
import type { ExternalDisplayCapabilities, ExternalDisplayInfo } from '../../../lib';
import {
  ExternalPresentationOwner,
  closeStaleExternalOpen,
  externalDisplayChoices,
  externalOpenParams,
  isExternalContentLive,
  isExternalDisplayFree,
  liveExternalPresentation,
} from '../ExternalDisplayOwnership';

const KDS = 'kitchen_display';
const CD = 'customer_display';

function screen(overrides: Partial<ExternalDisplayInfo> = {}): ExternalDisplayInfo {
  return {
    index: 1,
    id: 'screen-b',
    name: 'Screen B',
    isPrimary: false,
    hostsPos: false,
    external: true,
    available: true,
    ...overrides,
  };
}

function capabilities(overrides: Partial<ExternalDisplayCapabilities> = {}): ExternalDisplayCapabilities {
  return { success: true, supported: true, displays: [], activePresentations: [], ...overrides };
}

function closer() {
  return { externalDisplay: { close: vi.fn(async () => ({ success: true })) } };
}

describe('externalDisplayChoices', () => {
  it('offers only screens the native side explicitly marks external', () => {
    const choices = externalDisplayChoices(capabilities({
      displays: [
        screen({ index: 0, id: 'cashier-primary', isPrimary: true, hostsPos: true, external: false }),
        screen({ index: 1, id: 'cashier', hostsPos: true, external: false }),
        screen({ index: 2, id: 'unknown-flag', external: undefined }),
        screen({ index: 3, id: 'unknown-topology', isPrimary: undefined, hostsPos: undefined }),
        screen({ index: 4, id: '' }),
        screen({ index: 5, id: undefined as unknown as string }),
        screen({ index: 6, id: 'screen-c', available: false, occupiedBy: CD }),
        screen({ index: 7, id: 'screen-d' }),
      ],
    }));
    expect(choices.map((display) => display.id)).toEqual(['screen-c', 'screen-d']);
  });

  it('offers an external OS primary screen: only the cashier screen is protected', () => {
    // Three extended screens: Windows made the kitchen TV primary, the cashier POS runs on the second.
    const choices = externalDisplayChoices(capabilities({
      displays: [
        screen({ index: 0, id: 'tv-primary', isPrimary: true }),
        screen({ index: 1, id: 'cashier', hostsPos: true, external: false }),
        screen({ index: 2, id: 'screen-c' }),
      ],
    }));
    expect(choices.map((display) => display.id)).toEqual(['tv-primary', 'screen-c']);
  });

  it('offers nothing when the monitor read failed, is unsupported, missing or the cashier screen is unknown', () => {
    const displays = [screen()];
    expect(externalDisplayChoices(null)).toEqual([]);
    expect(externalDisplayChoices(capabilities({ success: false, displays }))).toEqual([]);
    expect(externalDisplayChoices(capabilities({ supported: false, displays }))).toEqual([]);
    // While the cashier's monitor is unknown, native marks every screen as the cashier's.
    expect(externalDisplayChoices(capabilities({
      displays: [
        screen({ index: 0, id: 'tv-primary', isPrimary: true, hostsPos: true, external: false }),
        screen({ index: 1, id: 'screen-b', hostsPos: true, external: false }),
      ],
    }))).toEqual([]);
  });
});

describe('isExternalDisplayFree', () => {
  it('treats only an explicitly available, unoccupied screen as free', () => {
    expect(isExternalDisplayFree(screen())).toBe(true);
    expect(isExternalDisplayFree(screen({ available: undefined }))).toBe(false);
    expect(isExternalDisplayFree(screen({ available: false, occupiedBy: KDS }))).toBe(false);
    expect(isExternalDisplayFree(screen({ occupiedBy: CD }))).toBe(false);
  });
});

describe('live presentations', () => {
  it('counts opening and active presentations of this content, never closing ones', () => {
    const caps = capabilities({
      activePresentations: [
        { contentType: KDS, displayId: 'screen-b', token: 'kds-old', state: 'closing' },
        { contentType: CD, displayId: 'screen-c', token: 'cd-1', state: 'active' },
      ],
    });
    expect(isExternalContentLive(caps, KDS)).toBe(false);
    expect(liveExternalPresentation(caps, CD)?.token).toBe('cd-1');
    const opening = capabilities({
      activePresentations: [{ contentType: KDS, displayId: 'screen-d', token: 'kds-2', state: 'opening' }],
    });
    expect(isExternalContentLive(opening, KDS)).toBe(true);
    expect(isExternalContentLive(null, KDS)).toBe(false);
  });
});

describe('externalOpenParams', () => {
  it('lets the native side choose when no screen is given', () => {
    expect(externalOpenParams(KDS)).toEqual({ contentType: KDS });
  });

  it('sends an explicit screen only by id so a stale choice can fail but never redirect', () => {
    expect(externalOpenParams(CD, screen({ index: 2, id: 'screen-c' }))).toEqual({
      contentType: CD,
      displayId: 'screen-c',
    });
    expect(externalOpenParams(CD, screen({ id: undefined as unknown as string }))).toEqual({
      contentType: CD,
      displayId: '',
    });
  });

  it('names the presentation the caller holds, and none when it holds nothing', () => {
    expect(externalOpenParams(KDS, null, 'kds-1')).toEqual({ contentType: KDS, expectedToken: 'kds-1' });
    expect(externalOpenParams(CD, screen({ id: 'screen-c' }), 'cd-2')).toEqual({
      contentType: CD,
      displayId: 'screen-c',
      expectedToken: 'cd-2',
    });
    expect('expectedToken' in externalOpenParams(KDS, null, null)).toBe(false);
    expect('expectedToken' in externalOpenParams(KDS, undefined, '')).toBe(false);
  });
});

describe('ExternalPresentationOwner', () => {
  it('owns only the token of a successful open and closes exactly it once', async () => {
    const bridge = closer();
    const owner = new ExternalPresentationOwner(KDS);
    owner.opened({ success: false, token: 'kds-failed' });
    owner.opened({ success: true });
    expect(owner.ownedToken).toBeNull();
    owner.opened({ success: true, token: 'kds-1' });
    owner.opened({ success: true, token: 'kds-2' });
    await owner.release(bridge);
    await owner.release(bridge);
    expect(bridge.externalDisplay.close).toHaveBeenCalledTimes(1);
    expect(bridge.externalDisplay.close).toHaveBeenCalledWith({ contentType: KDS, token: 'kds-2' });
    expect(owner.ownedToken).toBeNull();
  });

  it('closes nothing when it owns nothing', async () => {
    const bridge = closer();
    await expect(new ExternalPresentationOwner(CD).release(bridge)).resolves.toBeNull();
    expect(bridge.externalDisplay.close).not.toHaveBeenCalled();
  });

  it('adopts a live presentation only while it owns none and no open is in flight', () => {
    const live = capabilities({
      activePresentations: [
        { contentType: CD, displayId: 'screen-c', token: 'cd-1', state: 'active' },
        { contentType: KDS, displayId: 'screen-b', token: 'kds-live', state: 'active' },
      ],
    });
    const owner = new ExternalPresentationOwner(KDS);
    const endFirst = owner.beginOpen();
    const endSecond = owner.beginOpen();
    owner.observe(live);
    endFirst();
    endFirst();
    owner.observe(live);
    expect(owner.ownedToken).toBeNull();
    endSecond();
    owner.observe(live);
    expect(owner.ownedToken).toBe('kds-live');
    owner.observe(capabilities({
      activePresentations: [{ contentType: KDS, displayId: 'screen-d', token: 'kds-other', state: 'active' }],
    }));
    expect(owner.ownedToken).toBe('kds-live');

    const closing = new ExternalPresentationOwner(KDS);
    closing.observe(capabilities({
      activePresentations: [{ contentType: KDS, displayId: 'screen-b', token: 'kds-closing', state: 'closing' }],
    }));
    expect(closing.ownedToken).toBeNull();
  });

  it('forgets its presentation once a fresh answer lists none, so an open after an OS close starts fresh', () => {
    const owner = new ExternalPresentationOwner(KDS);
    owner.opened({ success: true, token: 'kds-1' });
    expect(externalOpenParams(KDS, null, owner.ownedToken)).toEqual({ contentType: KDS, expectedToken: 'kds-1' });
    // The window was closed from the OS; only the customer display still runs.
    owner.observe(capabilities({
      activePresentations: [{ contentType: CD, displayId: 'screen-c', token: 'cd-1', state: 'active' }],
    }), owner.revision);
    expect(owner.ownedToken).toBeNull();
    expect(externalOpenParams(KDS, null, owner.ownedToken)).toEqual({ contentType: KDS });
  });

  it('keeps its presentation on failed, unknown, cached, outdated or still-closing answers', async () => {
    const bridge = closer();
    const owner = new ExternalPresentationOwner(KDS);
    owner.opened({ success: true, token: 'kds-1' });
    const none = capabilities();
    owner.observe(null, owner.revision);
    owner.observe(capabilities({ success: false }), owner.revision);
    owner.observe(capabilities({ supported: false }), owner.revision);
    owner.observe(capabilities({ activePresentations: undefined }), owner.revision);
    // A cached answer without the revision of its read may adopt, never forget.
    owner.observe(none);
    expect(owner.ownedToken).toBe('kds-1');
    // A read issued before a later open settled answers for an older state.
    const before = owner.revision;
    const endOpen = owner.beginOpen();
    owner.observe(none, owner.revision);
    owner.opened({ success: true, token: 'kds-2' });
    endOpen();
    owner.observe(none, before);
    expect(owner.ownedToken).toBe('kds-2');
    // A closing window is still this content's lease; another token never replaces the owned one.
    owner.observe(capabilities({
      activePresentations: [{ contentType: KDS, displayId: 'screen-b', token: 'kds-2', state: 'closing' }],
    }), owner.revision);
    owner.observe(capabilities({
      activePresentations: [{ contentType: KDS, displayId: 'screen-b', token: 'kds-other', state: 'active' }],
    }), owner.revision);
    expect(owner.ownedToken).toBe('kds-2');
    await owner.release(bridge);
    expect(bridge.externalDisplay.close).toHaveBeenCalledWith({ contentType: KDS, token: 'kds-2' });
  });

  it('adopts no other token while opens overlap, not even from a read answered after they settled', () => {
    const owner = new ExternalPresentationOwner(CD);
    const other = (token: string) => capabilities({
      activePresentations: [{ contentType: CD, displayId: 'screen-c', token, state: 'active' }],
    });
    const endOlder = owner.beginOpen();
    const endNewer = owner.beginOpen();
    const during = owner.revision;
    owner.observe(other('cd-other'), during);
    owner.observe(other('cd-other'));
    expect(owner.ownedToken).toBeNull();
    // The newer open settles first and owns its own result.
    owner.opened({ success: true, token: 'cd-new' });
    endNewer();
    owner.observe(other('cd-other'), during);
    expect(owner.ownedToken).toBe('cd-new');
    // The older one was refused; a read issued while it was pending changes nothing.
    endOlder();
    owner.observe(capabilities(), during);
    owner.observe(other('cd-old'), during);
    expect(owner.ownedToken).toBe('cd-new');
  });
});

describe('closeStaleExternalOpen', () => {
  it('closes only the presentation the late open created', async () => {
    const bridge = closer();
    await closeStaleExternalOpen(bridge, KDS, { success: false, token: 'kds-failed' });
    await closeStaleExternalOpen(bridge, KDS, { success: true });
    await closeStaleExternalOpen(bridge, KDS, null);
    expect(bridge.externalDisplay.close).not.toHaveBeenCalled();
    await closeStaleExternalOpen(bridge, KDS, { success: true, token: 'kds-old' });
    expect(bridge.externalDisplay.close).toHaveBeenCalledTimes(1);
    expect(bridge.externalDisplay.close).toHaveBeenCalledWith({ contentType: KDS, token: 'kds-old' });
  });
});
