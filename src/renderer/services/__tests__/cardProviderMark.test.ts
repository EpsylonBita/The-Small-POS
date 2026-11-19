import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  read: vi.fn(), listeners: new Map<string, (raw: unknown) => void>(),
  scope: {} as Partial<Record<'organizationId' | 'branchId' | 'terminalId', string>>,
  unreadable: false,
}));
vi.mock('../../../lib', () => ({
  getBridge: () => ({ ecr: { getDeviceAdmission: m.read } }),
  onEvent: (name: string, fn: (raw: unknown) => void) => m.listeners.set(name, fn),
  offEvent: (name: string) => m.listeners.delete(name),
}));
vi.mock('../terminal-credentials', () => ({ getCachedTerminalCredentials: () => {
  if (m.unreadable) throw new Error('identity unavailable');
  return m.scope;
} }));
import {
  applyCardProviderSnapshot, cardProviderConnected, cardProviderState, clearCardProviderMark,
  lastNoProviderAnswerAt, loadCardProviderMark, startCardProviderMark,
} from '../cardProviderMark';

const at = '2026-11-06T09:00:00.000Z';
const olderAt = '2026-11-06T08:59:00.000Z';
const newerAt = '2026-11-06T09:01:00.000Z';
const snapshot = (admitted = true, fetchedAt = at) => ({ success: true, cardTerminal: { admitted, fetchedAt,
  organizationId: 'org', branchId: 'branch', terminalId: 'till' } });
beforeEach(() => {
  clearCardProviderMark(); m.listeners.clear(); m.read.mockReset();
  m.unreadable = false;
  Object.assign(m.scope, { organizationId: 'org', branchId: 'branch', terminalId: 'till' });
});

describe('card provider mark', () => {
  it('starts empty, records no-provider evidence, and clears both', () => {
    expect(cardProviderState()).toBe('unknown');
    expect(cardProviderConnected()).toBe(false); expect(lastNoProviderAnswerAt()).toBeNull();
    applyCardProviderSnapshot(snapshot(false));
    expect(cardProviderState()).toBe('none');
    expect(cardProviderConnected()).toBe(false); expect(lastNoProviderAnswerAt()).toBe(at);
    applyCardProviderSnapshot(snapshot());
    expect(cardProviderState()).toBe('connected');
    expect(cardProviderConnected()).toBe(true); expect(lastNoProviderAnswerAt()).toBeNull();
    clearCardProviderMark(); expect(cardProviderConnected()).toBe(false);
  });
  it.each(['organizationId', 'branchId', 'terminalId'] as const)('requires a complete matching %s for either verdict', key => {
    for (const value of ['', ' ', undefined, 'different']) {
      if (value === undefined) delete m.scope[key];
      else m.scope[key] = value;
      applyCardProviderSnapshot(snapshot());
      expect(cardProviderConnected()).toBe(false);
      expect(cardProviderState()).toBe('unknown');
      applyCardProviderSnapshot(snapshot(false));
      expect(lastNoProviderAnswerAt()).toBeNull();
      expect(cardProviderState()).toBe('unknown');
    }
  });
  it.each(['organizationId', 'branchId', 'terminalId'] as const)('preserves both verdicts on an answer with a foreign %s', key => {
    const foreignNone = snapshot(false, newerAt);
    foreignNone.cardTerminal[key] = 'different';
    applyCardProviderSnapshot(snapshot());
    applyCardProviderSnapshot(foreignNone);
    expect(cardProviderState()).toBe('connected');

    const foreignConnected = snapshot(true, newerAt);
    foreignConnected.cardTerminal[key] = 'different';
    applyCardProviderSnapshot(snapshot(false));
    applyCardProviderSnapshot(foreignConnected);
    expect(cardProviderState()).toBe('none');
    expect(lastNoProviderAnswerAt()).toBe(at);
  });
  it('stores an answer while the cached identity is incomplete', () => {
    m.scope.organizationId = 'different';
    delete m.scope.branchId;
    applyCardProviderSnapshot(snapshot());
    expect(cardProviderState()).toBe('unknown');
    Object.assign(m.scope, { organizationId: 'org', branchId: 'branch' });
    expect(cardProviderState()).toBe('connected');
  });
  it('returns an empty mark and evidence when identity is unreadable', () => {
    m.unreadable = true;
    applyCardProviderSnapshot(snapshot());
    expect(cardProviderConnected()).toBe(false);
    applyCardProviderSnapshot(snapshot(false));
    expect(lastNoProviderAnswerAt()).toBeNull();
    expect(cardProviderState()).toBe('unknown');
    m.unreadable = false;
    expect(cardProviderState()).toBe('none');
    expect(lastNoProviderAnswerAt()).toBe(at);
  });
  it.each([false, true])('ignores an older opposite verdict when admitted is %s', admitted => {
    applyCardProviderSnapshot(snapshot(admitted));
    applyCardProviderSnapshot(snapshot(!admitted, olderAt));
    expect(cardProviderState()).toBe(admitted ? 'connected' : 'none');
    expect(lastNoProviderAnswerAt()).toBe(admitted ? null : at);
  });
  it('replaces the verdict when its time is equal or newer', () => {
    applyCardProviderSnapshot(snapshot());
    applyCardProviderSnapshot(snapshot(false));
    expect(cardProviderState()).toBe('none');
    expect(lastNoProviderAnswerAt()).toBe(at);
    applyCardProviderSnapshot(snapshot(true, newerAt));
    expect(cardProviderState()).toBe('connected');
    expect(lastNoProviderAnswerAt()).toBeNull();
  });
  it('keeps a newer Settings answer when a delayed heartbeat event arrives', () => {
    applyCardProviderSnapshot({
      ...snapshot(false, newerAt),
      cashRegister: { admitted: true, fetchedAt: newerAt, mode: null, status: null },
    });
    applyCardProviderSnapshot(snapshot());
    expect(cardProviderState()).toBe('none');
    expect(lastNoProviderAnswerAt()).toBe(newerAt);
  });
  it('clears a prior verdict when the native snapshot has no card answer', () => {
    applyCardProviderSnapshot(snapshot(false));
    applyCardProviderSnapshot({
      success: true,
      cardTerminal: { admitted: false, fetchedAt: null, organizationId: null, branchId: null, terminalId: null },
      cashRegister: { admitted: false, fetchedAt: null, mode: null, status: null },
    });
    expect(cardProviderState()).toBe('unknown');
    expect(lastNoProviderAnswerAt()).toBeNull();
  });
  it.each([null, [], {}, { cardTerminal: {} },
    ...['admitted', 'fetchedAt', 'organizationId', 'branchId', 'terminalId'].map(key => {
      const raw = snapshot(); delete (raw.cardTerminal as Record<string, unknown>)[key]; return raw;
    }), { ...snapshot(), cardTerminal: { ...snapshot().cardTerminal, admitted: 'true' } },
    { ...snapshot(), cardTerminal: { ...snapshot().cardTerminal, fetchedAt: 'invalid' } },
    { ...snapshot(), cardTerminal: { ...snapshot().cardTerminal, branchId: ' ' } },
    { ...snapshot(), success: false },
    { cardTerminal: snapshot().cardTerminal },
  ])('empties a prior mark for malformed payload %j', raw => {
    applyCardProviderSnapshot(snapshot()); applyCardProviderSnapshot(raw);
    expect(cardProviderConnected()).toBe(false); expect(lastNoProviderAnswerAt()).toBeNull();
  });
  it('loads the stored answer with no options and never throws', async () => {
    m.read.mockResolvedValue(snapshot()); await loadCardProviderMark();
    expect(m.read).toHaveBeenCalledExactlyOnceWith(); expect(cardProviderConnected()).toBe(true);
    m.read.mockRejectedValue(new Error('held lock')); await expect(loadCardProviderMark()).resolves.toBeUndefined();
    expect(cardProviderConnected()).toBe(false);
  });
  it.each(['event', 'clear', 'newer load'])('does not overwrite a newer %s with an old load', async action => {
    let finish!: (raw: unknown) => void;
    m.read.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const pending = loadCardProviderMark();
    if (action === 'clear') clearCardProviderMark();
    else if (action === 'event') applyCardProviderSnapshot(snapshot(false));
    else { m.read.mockResolvedValue(snapshot(false)); await loadCardProviderMark(); }
    finish(snapshot()); await pending;
    expect(cardProviderConnected()).toBe(false);
    expect(lastNoProviderAnswerAt()).toBe(action === 'clear' ? null : at);
  });
  it.each(['foreign', 'older'])('keeps a pending load after a %s event', async kind => {
    applyCardProviderSnapshot(snapshot(false));
    let finish!: (raw: unknown) => void;
    m.read.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const pending = loadCardProviderMark();

    const event = snapshot(true, kind === 'foreign' ? newerAt : olderAt);
    if (kind === 'foreign') event.cardTerminal.terminalId = 'different';
    applyCardProviderSnapshot(event);
    expect(cardProviderState()).toBe('none');
    expect(lastNoProviderAnswerAt()).toBe(at);

    finish(snapshot(true, newerAt));
    await pending;
    expect(cardProviderState()).toBe('connected');
  });
  it('subscribes to updates, clears on reset/disable, reloads on re-pair and unsubscribes', async () => {
    const stop = startCardProviderMark();
    m.listeners.get('ecr:device-admission-updated')!(snapshot()); expect(cardProviderConnected()).toBe(true);
    m.listeners.get('app:reset')!({}); expect(cardProviderConnected()).toBe(false);
    applyCardProviderSnapshot(snapshot()); m.listeners.get('terminal-disabled')!({});
    expect(cardProviderConnected()).toBe(false);
    applyCardProviderSnapshot(snapshot()); m.read.mockResolvedValue(snapshot(false));
    m.listeners.get('terminal-credentials-updated')!({}); expect(cardProviderConnected()).toBe(false);
    await vi.waitFor(() => expect(lastNoProviderAnswerAt()).toBe(at));
    stop(); expect(m.listeners.size).toBe(0);
  });
});

it('publishes explicit refreshes, maps their event, and never refreshes admission on a card path', () => {
  expect(readFileSync('src-tauri/src/commands/ecr.rs', 'utf8')).toContain('device_admission::publish_snapshot(');
  expect(readFileSync('src/lib/event-bridge.ts', 'utf8')).toContain("'ecr_device_admission_updated': 'ecr:device-admission-updated'");
  for (const path of ['services/cardProviderMark.ts', 'services/ManualCardAdmissionService.ts',
    'components/modals/PaymentModal.tsx', 'components/modals/SinglePaymentCollectionModal.tsx', 'components/modals/SplitPaymentModal.tsx']) {
    expect(readFileSync(`src/renderer/${path}`, 'utf8')).not.toMatch(/getDeviceAdmission\??\.?\(\{\s*refresh/);
  }
});

it('keeps the combined read on its 5-minute cadence and dispatches the stored card answer in the background', () => {
  const sync = readFileSync('src-tauri/src/sync.rs', 'utf8');
  expect(sync).not.toMatch(/include_card_provider_revision|note_heartbeat_signal|heartbeat_wants_signal|spawn_heartbeat_refresh/);
  const loop = sync.slice(sync.indexOf('pub fn start_terminal_heartbeat_loop('),
    sync.indexOf('pub fn start_sync_loop('));
  const order = ['crate::device_admission::REFRESH_INTERVAL', 'last_admission_refresh = Some(std::time::Instant::now());',
    'crate::device_admission::refresh_and_publish(&app, db.as_ref()).await']
    .map(text => loop.indexOf(text));
  expect(order.every(index => index >= 0)).toBe(true);
  expect([...order].sort((left, right) => left - right)).toEqual(order);
  expect(loop.match(/device_admission::/g)).toHaveLength(2);

  const admission = readFileSync('src-tauri/src/device_admission.rs', 'utf8');
  expect(admission).toContain('pub(crate) const REFRESH_INTERVAL: std::time::Duration = std::time::Duration::from_secs(300);');
  expect(admission).not.toMatch(/RefreshClock|RunningRead|spawn_heartbeat_refresh|request_refresh|refresh_after_repair|SIGNAL_INTERVAL|note_revision/);
  const refresh = admission.match(/^async fn refresh_storing\([\s\S]*?^}/m)?.[0] ?? '';
  expect(refresh.match(/admin_fetch_detailed\(/g)).toHaveLength(2);
  expect(refresh.indexOf('MANUAL_ADMISSION_PATH')).toBeLessThan(refresh.indexOf('MYDATA_CONFIG_PATH'));
  const publish = admission.match(/^pub\(crate\) async fn refresh_and_publish\([\s\S]*?^}/m)?.[0] ?? '';
  expect(publish).toContain('refresh_storing(db).await');
  expect(publish.match(/\.await\b/g)).toHaveLength(1);
  expect(publish).toContain('async_runtime::spawn');
  expect(publish.match(/app\.emit\(/g)).toHaveLength(1);
  const spawned = publish.match(/async_runtime::spawn\(async move \{([\s\S]*?)^\s*\}\);/m)?.[1] ?? '';
  expect(spawned).toContain('app.emit(');
  expect(publish).toContain('card_event(');
  expect(publish).not.toMatch(/db\.conn\.lock\(\)|snapshot\(|OpeningScope::resolve/);
  expect(admission).not.toContain('pub(crate) fn publish(');

  const publishSnapshot = admission.match(/^pub\(crate\) fn publish_snapshot\([\s\S]*?^}/m)?.[0] ?? '';
  expect(publishSnapshot).toContain('app.emit(UPDATED_EVENT, view.clone())');
  expect(publishSnapshot).not.toMatch(/lock\(\)|\.await|\bsnapshot\(/);

  const ecr = readFileSync('src-tauri/src/commands/ecr.rs', 'utf8');
  const start = ecr.indexOf('pub async fn ecr_get_device_admission(');
  const getAdmission = ecr.slice(start, ecr.indexOf('#[cfg(test)]', start));
  expect(getAdmission.match(/db\.conn\.lock\(\)/g)).toHaveLength(1);
  expect(getAdmission).toContain('publish_snapshot(&app, &view)');
});

it('leaves the terminal binding code untouched: a re-pair is covered by strict identity alone', () => {
  expect(readFileSync('src-tauri/src/commands/settings.rs', 'utf8')).not.toMatch(/device_admission::|TERMINAL_CONFIG_APP/);
  // A stored answer for the previous store is void the moment the cached identity changes, before any re-read.
  applyCardProviderSnapshot(snapshot());
  expect(cardProviderState()).toBe('connected');
  for (const [key, value] of [['organizationId', 'other-org'], ['branchId', 'other-branch'], ['terminalId', 'other-till']] as const) {
    const previous = m.scope[key];
    m.scope[key] = value;
    expect(cardProviderState()).toBe('unknown');
    expect(cardProviderConnected()).toBe(false);
    expect(m.read).not.toHaveBeenCalled();
    m.scope[key] = previous;
    expect(cardProviderState()).toBe('connected');
  }
});

it('starting the mark loads the stored answer in the background and returns at once', async () => {
  let finish!: (raw: unknown) => void;
  m.read.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const stop = startCardProviderMark();
  expect(m.read).toHaveBeenCalledExactlyOnceWith();
  expect(cardProviderState()).toBe('unknown');
  finish(snapshot());
  await vi.waitFor(() => expect(cardProviderState()).toBe('connected'));
  stop();
});

it('ignores an old load failure after a newer snapshot arrives', async () => {
  let fail!: (reason: Error) => void;
  m.read.mockImplementation(() => new Promise((_resolve, reject) => { fail = reject; }));
  const old = loadCardProviderMark();
  applyCardProviderSnapshot(snapshot());
  fail(new Error('old lock failure')); await old;
  expect(cardProviderConnected()).toBe(true);
});
