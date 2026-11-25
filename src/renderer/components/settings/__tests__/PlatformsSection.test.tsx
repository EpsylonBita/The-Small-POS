import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import dePlatforms from '../../../../locales/overlays/de.platforms.json';
import elPlatforms from '../../../../locales/overlays/el.platforms.json';
import enPlatforms from '../../../../locales/overlays/en.platforms.json';
import frPlatforms from '../../../../locales/overlays/fr.platforms.json';
import itPlatforms from '../../../../locales/overlays/it.platforms.json';
import sqPlatforms from '../../../../locales/overlays/sq.platforms.json';

const { posApiGet, posApiPost, boxDetails, woltDetails, fixtures } = vi.hoisted(() => ({
  posApiGet: vi.fn(),
  boxDetails: vi.fn(),
  woltDetails: vi.fn(),
  posApiPost: vi.fn(),
  fixtures: { box: undefined as Platform | undefined },
}));
vi.mock('../../../utils/api-helpers', () => ({
  posApiPost,
  posApiGet: async (path: string) => {
    if (path.includes('?plugin_id=box')) return boxDetails(path);
    if (path === '/pos/platforms?plugin_id=wolt') return woltDetails(path);
    const response = await posApiGet(path);
    fixtures.box = response?.data?.platforms?.find((row: Platform) => row.plugin_id === 'box' && row.reason !== 'unsupported');
    if (!fixtures.box) return response;
    return listResponse(...response.data.platforms.map((row: Platform) => row.plugin_id === 'box'
      ? { ...row, open: null, controllable: false, reason: 'unsupported' }
      : row));
  },
}));

// A stable `t` reference: react-i18next's real useTranslation would also be
// stable across renders, and a mock that hands back a brand-new function each
// render can put dependent useCallback/useEffect chains into a render loop.
const translate = (key: string, defaultValueOrOptions?: string | { defaultValue?: string; [k: string]: unknown }) => {
  if (typeof defaultValueOrOptions === 'string') return defaultValueOrOptions;
  const template = defaultValueOrOptions?.defaultValue ?? key;
  if (typeof template !== 'string' || !defaultValueOrOptions) return template;
  return template.replace(/\{\{(\w+)\}\}/g, (_, name) => String((defaultValueOrOptions as Record<string, unknown>)[name] ?? ''));
};
// Stable for the same reason; the closure end reads `i18n.language` for its weekday.
const i18nStub = { language: 'en' };
vi.mock('react-i18next', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-i18next')>();
  return { ...actual, useTranslation: () => ({ t: translate, i18n: i18nStub }) };
});

const { efoodPartnerHook } = vi.hoisted(() => ({
  efoodPartnerHook: {
    available: true,
    settings: { enabled: true, muted: false },
    updateSettings: vi.fn(),
  },
}));
vi.mock('../../../hooks/useEfoodPartner', () => ({ useEfoodPartner: () => efoodPartnerHook }));

import { PlatformsSection, type Platform } from '../PlatformsSection';


const AWAITING_TEXT = 'The platform accepted the change. Its status can take a few minutes to update.';
const REJECTED_TEXT = "The platform refused this change. Outside opening hours, try again during them or use the platform's own app.";
const DAY_START_TEXT = 'Opens automatically when the first cashier checks in.';
const CLOSED_BY_PROVIDER_TEXT =
  'efood closed the store again after accepting the open. This usually means the efood Partner app is disconnected: open it, or ask efood to stop requiring a device.';
const UNCERTAIN_TEXT = /Could not confirm the result/;

function makePlatform(overrides: Partial<Platform> = {}): Platform {
  return {
    plugin_id: 'efood',
    name: 'efood',
    open: true,
    controllable: true,
    accepting_orders: null,
    reason: null,
    checked_at: null,
    ...overrides,
  };
}

function listResponse(...platforms: Platform[]) {
  return { success: true, data: { success: true, platforms } };
}

function actionResponse(platform: Platform) {
  return { success: true, data: { success: true, platform } };
}

async function flush() {
  await act(async () => Promise.resolve());
}

// Under full fake timers findBy/waitFor cannot poll, so time moves explicitly
// and inside act, letting resolved requests and their re-renders land.
async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

function setOnline(online: boolean) {
  act(() => {
    Object.defineProperty(window.navigator, 'onLine', { value: online, configurable: true });
    window.dispatchEvent(new Event(online ? 'online' : 'offline'));
  });
}

function flattenKeys(value: unknown, prefix = ''): string[] {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return Object.entries(value as Record<string, unknown>)
      .flatMap(([key, nested]) => flattenKeys(nested, prefix ? `${prefix}.${key}` : key));
  }
  return [prefix];
}

function valueAt(source: unknown, dotPath: string): unknown {
  return dotPath.split('.').reduce<unknown>(
    (current, key) => (current && typeof current === 'object' ? (current as Record<string, unknown>)[key] : undefined),
    source,
  );
}

describe('PlatformsSection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Also drop queued once-values so no response can leak into the next test.
    posApiGet.mockReset();
    fixtures.box = undefined;
    woltDetails.mockReset().mockResolvedValue(listResponse(makePlatform({ plugin_id: 'wolt', name: 'Wolt' })));
    boxDetails.mockReset().mockImplementation(async () => listResponse(...(fixtures.box ? [{
      ...fixtures.box, weekly_schedule_revision: fixtures.box.weekly_schedule_revision ?? 'a'.repeat(64),
    }] : [])));
    posApiPost.mockReset();
    Object.defineProperty(window.navigator, 'onLine', { value: true, configurable: true });
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it('edits the provider-confirmed Wolt week without a previous POS save, and reloads an uncertain update', async () => {
    const week = { monday: [], tuesday: [], wednesday: [], thursday: [], friday: [], saturday: [], sunday: [{ from: '17:00', to: '06:00' }] };
    const wolt = makePlatform({ plugin_id: 'wolt', name: 'Wolt', open: false });
    posApiGet.mockResolvedValue(listResponse(wolt));
    woltDetails.mockResolvedValue(listResponse({ ...wolt, auto_open: false, weekly_schedule: week, weekly_schedule_revision: 'rev1' }));
    posApiPost.mockResolvedValue({ success: false, error: 'outcome_unknown (HTTP 502)' });
    render(<PlatformsSection />);
    fireEvent.click(await screen.findByRole('button', { name: 'Weekly hours' }));
    expect(screen.getByText('Next day')).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: 'Wolt' })).not.toBeChecked();
    fireEvent.change(screen.getByLabelText('To'), { target: { value: '07:00' } });
    const save = screen.getByRole('button', { name: 'settings.platforms.wolt.save' });
    fireEvent.click(save);
    expect(posApiPost).toHaveBeenCalledWith('/pos/platforms?plugin_id=wolt', {
      plugin_id: 'wolt', weekly_schedule: { ...week, sunday: [{ from: '17:00', to: '07:00' }] }, expected_schedule_revision: 'rev1',
    });
    await screen.findByText('settings.platforms.wolt.unconfirmed');
    expect(save).toBeDisabled();
    woltDetails.mockResolvedValueOnce(listResponse({ ...wolt, weekly_schedule: week, weekly_schedule_revision: 'rev1', weekly_schedule_pending: true }));
    fireEvent.click(screen.getByRole('button', { name: 'Discard my changes and reload' }));
    await waitFor(() => expect(screen.getByLabelText('To')).toHaveValue('06:00'));
    fireEvent.change(screen.getByLabelText('To'), { target: { value: '07:30' } });
    expect(save).toBeDisabled();
    expect(screen.getByText('settings.platforms.wolt.unconfirmed')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Discard my changes and reload' }));
    await waitFor(() => expect(screen.getByLabelText('To')).toHaveValue('06:00'));
    fireEvent.change(screen.getByLabelText('To'), { target: { value: '07:30' } });
    expect(save).toBeEnabled();
  });

  it('saves Wolt automation separately from the manual availability switch', async () => {
    const initial = makePlatform({ plugin_id: 'wolt', name: 'Wolt', open: false });
    posApiGet.mockResolvedValue(listResponse(initial));
    woltDetails.mockResolvedValueOnce(listResponse({ ...initial, auto_open: false, wolt_availability_mode: 'manual' }))
      .mockResolvedValue(listResponse({ ...initial, auto_open: true, wolt_availability_mode: 'shifts' }));
    posApiPost.mockResolvedValue(actionResponse({ ...initial, auto_open: true, wolt_availability_mode: 'shifts' }));
    render(<PlatformsSection />);
    const automation = await screen.findByRole('switch', { name: 'settings.platforms.wolt.automatic' });
    expect(automation).not.toBeChecked();
    fireEvent.click(automation);
    expect(posApiPost).toHaveBeenCalledWith('/pos/platforms?plugin_id=wolt', { plugin_id: 'wolt', auto_open: true });
    await waitFor(() => expect(automation).toBeChecked());
    expect(screen.getByRole('switch', { name: 'Wolt' })).not.toBeChecked();
    const closed = makePlatform({ ...initial, auto_open: false, wolt_availability_mode: 'off', open: false });
    posApiPost.mockResolvedValue(actionResponse(closed));
    woltDetails.mockResolvedValue(listResponse(closed));
    fireEvent.click(automation);
    await waitFor(() => expect(automation).not.toBeChecked());
    expect(posApiPost).toHaveBeenLastCalledWith('/pos/platforms?plugin_id=wolt', { plugin_id: 'wolt', auto_open: false });
    expect(screen.queryByRole('switch', { name: 'Wolt' })).not.toBeInTheDocument();
  });

  it('holds Wolt closed only after provider confirmation, and keeps the weekly editor available', async () => {
    const week = { monday: [], tuesday: [], wednesday: [], thursday: [], friday: [], saturday: [], sunday: [] };
    const manual = makePlatform({ plugin_id: 'wolt', name: 'Wolt', open: true, auto_open: false, wolt_availability_mode: 'manual',
      weekly_schedule: week, weekly_schedule_revision: 'rev1' });
    let live = manual;
    posApiGet.mockResolvedValue(listResponse(manual));
    woltDetails.mockImplementation(async () => listResponse(live));
    posApiPost.mockImplementationOnce(async () => {
      live = { ...manual, wolt_availability_mode: 'off_pending' };
      return { success: false, error: 'outcome_unknown (HTTP 502)' };
    }).mockImplementationOnce(async () => {
      live = { ...manual, wolt_availability_mode: 'off', open: false };
      return actionResponse(live);
    });
    render(<PlatformsSection />);
    expect(await screen.findByRole('switch', { name: 'Wolt' })).toBeChecked();
    expect(posApiPost).not.toHaveBeenCalled();
    fireEvent.click(await screen.findByRole('button', { name: 'settings.platforms.wolt.holdClosed' }));
    expect(await screen.findByText('settings.platforms.wolt.closePending')).toBeInTheDocument();
    expect(screen.getByText('Open')).toBeInTheDocument();
    expect(screen.queryByRole('switch', { name: 'Wolt' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'settings.platforms.wolt.retryClose' }));
    await waitFor(() => expect(screen.getByText('Closed')).toBeInTheDocument());
    expect(posApiPost).toHaveBeenLastCalledWith('/pos/platforms?plugin_id=wolt', { plugin_id: 'wolt', auto_open: false });
    expect(screen.queryByText('settings.platforms.wolt.closePending')).not.toBeInTheDocument();
    expect(screen.queryByRole('switch', { name: 'Wolt' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Weekly hours' })).toBeEnabled();
  });

  it('keeps the existing Wolt manual switch and hides automation and hours on an older backend', async () => {
    const wolt = makePlatform({ plugin_id: 'wolt', name: 'Wolt', open: false });
    posApiGet.mockResolvedValue(listResponse(wolt));
    render(<PlatformsSection />);
    await waitFor(() => expect(woltDetails).toHaveBeenCalled());
    expect(screen.getAllByRole('switch')).toHaveLength(1);
    expect(screen.queryByRole('button', { name: 'Weekly hours' })).toBeNull();
  });

  it('keeps the efood guidance during the first load and after the first request fails', async () => {
    const guidance = /^efood opens automatically when the first cashier checks in/;
    let finish: (result: unknown) => void = () => {};
    posApiGet.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
    render(<PlatformsSection />);
    expect(screen.getByText(guidance)).toBeInTheDocument();
    await act(async () => finish({ success: false }));
    expect(await screen.findByText('Could not load platforms')).toBeInTheDocument();
    expect(screen.getByText(guidance)).toBeInTheDocument();
  });

  it.each([
    ['provider_forbidden', true],
    ['provider_forbidden (HTTP 502)', true],
    ['provider_forbidden (HTTP 502): upstream refusal', true],
    ['HTTP 403', false],
    ['network timeout', false],
    ['not_provider_forbidden_suffix', false],
    ['provider_rejected_elsewhere', false],
  ])('distinguishes provider refusal from an unknown outcome: %s', async (error, forbidden) => {
    posApiGet.mockResolvedValue({ success: true, data: { platforms: [makePlatform({ open: false })] } });
    posApiPost.mockResolvedValue({ success: false, error });
    render(<PlatformsSection />);
    fireEvent.click(await screen.findByRole('switch'));
    await screen.findByText('Unknown');
    expect(screen.getByText('Last known: Closed')).toBeInTheDocument();
    expect(Boolean(screen.queryByText(/The platform rejected this change/))).toBe(forbidden);
    expect(Boolean(screen.queryByText('Could not confirm the result. Refresh to check the current status.'))).toBe(!forbidden);
    expect(posApiPost).toHaveBeenCalledTimes(1);
  });

  it('recognizes a provider refusal in the response body', async () => {
    posApiGet.mockResolvedValue({ success: true, data: { platforms: [makePlatform({ open: false })] } });
    posApiPost.mockResolvedValue({ success: true, data: { success: false, error: 'provider_forbidden' } });
    render(<PlatformsSection />);
    fireEvent.click(await screen.findByRole('switch'));
    await screen.findByText(/The platform rejected this change/);
    expect(screen.queryByRole('switch')).not.toBeInTheDocument();
  });

  it('calls the unwrapped platforms contract and renders a real switch reflecting open state', async () => {
    posApiGet.mockResolvedValue({ success: true, data: { success: true, platforms: [makePlatform({ open: true })] } });
    render(<PlatformsSection />);
    await waitFor(() => expect(screen.getByRole('switch')).toHaveAttribute('aria-checked', 'true'));
    expect(posApiGet).toHaveBeenCalledWith('/pos/platforms');
    expect(screen.getByText('Open')).toBeInTheDocument();
    expect(screen.getByText(
      'efood opens automatically when the first cashier checks in and closes when the Z report is issued. Closing it here keeps it closed until the next check-in, unless you open it again.',
    )).toBeInTheDocument();
  });

  it('shows an empty state when there are no connected platforms', async () => {
    posApiGet.mockResolvedValue({ success: true, data: { success: true, platforms: [] } });
    render(<PlatformsSection />);
    await screen.findByText('No delivery platforms connected');
  });

  it('shows a disabled switch reflecting the known open state for an uncontrollable platform', async () => {
    posApiGet.mockResolvedValue({
      success: true,
      data: { success: true, platforms: [makePlatform({ controllable: false, open: true, reason: null })] },
    });
    render(<PlatformsSection />);
    await waitFor(() => expect(screen.getByRole('switch')).toBeDisabled());
  });

  it('shows explanatory text instead of an off-looking switch for an unknown, uncontrollable platform', async () => {
    posApiGet.mockResolvedValue({
      success: true,
      data: { success: true, platforms: [makePlatform({ controllable: false, open: null, reason: 'unsupported' })] },
    });
    render(<PlatformsSection />);
    await screen.findByText('This platform cannot be opened or closed from here.');
    // Unknown must never be represented as a closed/off switch.
    expect(screen.queryByRole('switch')).not.toBeInTheDocument();
    expect(screen.getByText('Unknown')).toBeInTheDocument();
  });

  it('shows unknown without inventing a connection failure when the server gives no reason', async () => {
    posApiGet.mockResolvedValue({
      success: true,
      data: { success: true, platforms: [makePlatform({ controllable: false, open: null, reason: null })] },
    });
    render(<PlatformsSection />);
    await screen.findByText('Unknown');
    expect(screen.queryByRole('switch')).not.toBeInTheDocument();
  });

  it('offers explicit Open/Close actions for a controllable platform in an unknown state', async () => {
    posApiGet.mockResolvedValue({
      success: true,
      data: { success: true, platforms: [makePlatform({ controllable: true, open: null, reason: 'outcome_unknown' })] },
    });
    render(<PlatformsSection />);
    await screen.findByRole('button', { name: /Open/ });
    expect(screen.getByRole('button', { name: /Close/ })).toBeInTheDocument();
    expect(screen.queryByRole('switch')).not.toBeInTheDocument();
    expect(screen.getByText('Unknown')).toBeInTheDocument();
  });

  it('renders the efood card while the separate BOX detail never answers', async () => {
    const box = makePlatform({ plugin_id: 'box', name: 'BOX', open: null, controllable: false, reason: 'unsupported' });
    posApiGet.mockResolvedValue(listResponse(makePlatform(), box));
    boxDetails.mockReturnValue(new Promise(() => {}));
    render(<PlatformsSection />);
    expect(await screen.findByRole('switch', { name: 'efood' })).toHaveAttribute('aria-checked', 'true');
    expect(boxDetails).toHaveBeenCalledWith('/pos/platforms?plugin_id=box');
  });

  it('keeps the base efood list failure while a BOX action is pending', async () => {
    const box = makePlatform({ plugin_id: 'box', name: 'BOX', open: null });
    posApiGet.mockResolvedValueOnce(listResponse(makePlatform(), box)).mockResolvedValueOnce({ success: false });
    posApiPost.mockReturnValue(new Promise(() => {}));
    render(<PlatformsSection />);
    await screen.findByRole('switch', { name: 'efood' });
    fireEvent.click(await screen.findByRole('button', { name: 'Open' }));
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await screen.findByText('Could not load platforms');
    expect(screen.queryByRole('switch', { name: 'efood' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Open' })).toBeDisabled();
  });

  it('makes zero BOX detail requests for an efood-only list', async () => {
    posApiGet.mockResolvedValue(listResponse(makePlatform()));
    render(<PlatformsSection />);
    await screen.findByRole('switch', { name: 'efood' });
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Refresh' })).toBeEnabled());
    expect(boxDetails).not.toHaveBeenCalled();
  });

  it('shows a refused BOX reissue alongside the Merchant warning without refreshing efood', async () => {
    const box = makePlatform({ plugin_id: 'box', name: 'BOX', open: null, reason: 'outcome_unknown' });
    posApiGet.mockResolvedValueOnce(listResponse(makePlatform(), box)).mockResolvedValue({ success: false });
    posApiPost.mockResolvedValue({ success: false, error: 'provider_rejected' });
    render(<PlatformsSection />);
    fireEvent.click(await screen.findByRole('button', { name: 'Open' }));
    expect(await screen.findByText('BOX rejected the request.')).toBeInTheDocument();
    expect(screen.getByText('Could not confirm the request. Check the shop in BOX Merchant.')).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: 'efood' })).toHaveAttribute('aria-checked', 'true');
    expect(posApiGet).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['outcome_unknown', 'Could not confirm the request. Check the shop in BOX Merchant.'],
    ['provider_rejected', 'BOX rejected the request.'],
  ])('keeps the %s warning when a BOX availability action is busy', async (reason, warning) => {
    posApiGet.mockResolvedValue(listResponse(makePlatform({ plugin_id: 'box', name: 'BOX', open: null, reason })));
    posApiPost.mockResolvedValue({ success: false, error: 'busy (HTTP 409)' });
    render(<PlatformsSection />);
    fireEvent.click(await screen.findByRole('button', { name: 'Open' }));
    expect(await screen.findByText('The platform is busy. Try again shortly.')).toBeInTheDocument();
    expect(screen.getByText(warning)).toBeInTheDocument();
    expect(boxDetails).toHaveBeenCalledTimes(1);
  });

  it('retires omitted BOX controls and ignores a late save while keeping the hours draft', async () => {
    const week = { monday: [{ from: '09:00', to: '14:00' }], tuesday: [], wednesday: [], thursday: [], friday: [], saturday: [], sunday: [] };
    const box = makePlatform({ plugin_id: 'box', name: 'BOX', open: null, auto_open: true,
      weekly_schedule: week, weekly_schedule_revision: 'a'.repeat(64) });
    let complete!: (result: unknown) => void;
    posApiPost.mockImplementation(() => new Promise(resolve => { complete = resolve; }));
    posApiGet.mockResolvedValueOnce(listResponse(makePlatform(), box)).mockResolvedValueOnce(listResponse(makePlatform()));
    render(<PlatformsSection />);
    const card = within((await screen.findByText('BOX')).closest('section')!);
    fireEvent.click(await card.findByRole('button', { name: 'Weekly hours' }));
    fireEvent.change(screen.getByLabelText('To'), { target: { value: '15:00' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send week to BOX' }));
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Open' })).not.toBeInTheDocument());
    await act(async () => complete(actionResponse({ ...box, weekly_schedule_revision: 'b'.repeat(64) })));
    expect(screen.queryByRole('button', { name: 'Open' })).not.toBeInTheDocument();
    expect(screen.queryByRole('switch', { name: 'Automatic BOX opening' })).not.toBeInTheDocument();
    expect(screen.getByLabelText('To')).toHaveValue('15:00');
    expect(screen.getByRole('button', { name: 'Send week to BOX' })).toBeDisabled();
    expect(screen.getByRole('switch', { name: 'efood' })).toHaveAttribute('aria-checked', 'true');
    expect(posApiGet).toHaveBeenCalledTimes(2);
    expect(boxDetails).toHaveBeenCalledTimes(1);
  });

  it('shows an empty BOX detail as a refresh error on the card from the list', async () => {
    const box = makePlatform({ plugin_id: 'box', name: 'BOX', open: null, controllable: false, reason: 'unsupported' });
    posApiGet.mockResolvedValue(listResponse(makePlatform(), box));
    render(<PlatformsSection />);
    const alert = await screen.findByText('Could not refresh BOX. Try again.');
    expect(alert.closest('[data-platform-hints="box"]')).toHaveClass('pos-row', 'pos-row--stack');
    expect(screen.getByText('BOX')).toBeInTheDocument();
    expect(screen.queryByText('This platform cannot be opened or closed from here.')).not.toBeInTheDocument();
    expect(screen.getByRole('switch', { name: 'efood' })).toHaveAttribute('aria-checked', 'true');
  });

  it('can open and close BOX manually with automation off and displays the accepted request time', async () => {
    const box = makePlatform({ plugin_id: 'box', name: 'BOX', open: null, auto_open: false });
    const at = '2026-11-18T07:05:00Z';
    const time = new Date(at).toLocaleString('en', { dateStyle: 'short', timeStyle: 'short' });
    posApiGet.mockResolvedValue(listResponse(box));
    posApiPost
      .mockResolvedValueOnce(actionResponse({ ...box, last_requested_open: true, last_requested_at: at }))
      .mockResolvedValueOnce(actionResponse({ ...box, last_requested_open: false, last_requested_at: at }));
    render(<PlatformsSection />);
    await screen.findByRole('button', { name: 'Open' });
    expect(screen.getAllByText(/Customers only see the shop as open when it is open here and within BOX opening hours/)).toHaveLength(1);
    expect(screen.getByText(/Customers only see the shop/).closest('[data-platform-hints="box"]')).toHaveClass('pos-row');
    fireEvent.click(screen.getByRole('button', { name: 'Open' }));
    await screen.findByText(`Last accepted POS request · Open, ${time}`);
    expect(screen.getByRole('button', { name: 'Open' })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    await screen.findByText(`Last accepted POS request · Close, ${time}`);
    expect(screen.getByRole('switch', { name: 'Automatic BOX opening' })).toHaveAttribute('aria-checked', 'false');
    expect(posApiPost.mock.calls).toEqual([
      ['/pos/platforms?plugin_id=box', { plugin_id: 'box', open: true }],
      ['/pos/platforms?plugin_id=box', { plugin_id: 'box', open: false }],
    ]);
  });

  it('changes only the BOX automatic preference and keeps all BOX actions locked while saving', async () => {
    const box = makePlatform({ plugin_id: 'box', name: 'BOX', open: null, auto_open: false });
    posApiGet.mockResolvedValue(listResponse(box));
    let confirm!: (value: unknown) => void;
    posApiPost.mockImplementationOnce(() => new Promise(resolve => { confirm = resolve; }))
      .mockResolvedValueOnce(actionResponse(box));
    render(<PlatformsSection />);
    const auto = await screen.findByRole('switch', { name: 'Automatic BOX opening' });
    fireEvent.click(auto);
    expect(auto).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Open' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Close' })).toBeDisabled();
    await act(async () => confirm(actionResponse({ ...box, auto_open: true })));
    expect(auto).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(auto);
    await waitFor(() => expect(auto).toHaveAttribute('aria-checked', 'false'));
    expect(posApiPost.mock.calls).toEqual([
      ['/pos/platforms?plugin_id=box', { plugin_id: 'box', auto_open: true }],
      ['/pos/platforms?plugin_id=box', { plugin_id: 'box', auto_open: false }],
    ]);
    expect(screen.queryByText(/Last accepted POS request/)).not.toBeInTheDocument();
  });

  it('keeps the last BOX preference on an unconfirmed write and disables offline commands', async () => {
    posApiGet.mockResolvedValue(listResponse(makePlatform({ plugin_id: 'box', name: 'BOX', open: null, auto_open: true })));
    posApiPost.mockRejectedValue(new Error('offline'));
    render(<PlatformsSection />);
    const auto = await screen.findByRole('switch');
    fireEvent.click(auto);
    await screen.findByText('Could not confirm the setting was saved. Refresh to check.');
    expect(auto).toHaveAttribute('aria-checked', 'true');
    setOnline(false);
    expect(auto).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Open' })).toBeDisabled();
  });

  it('does not expose BOX controls on a different register', async () => {
    posApiGet.mockResolvedValue(listResponse(makePlatform({
      plugin_id: 'box', name: 'BOX', open: null, controllable: false, auto_open: true, reason: 'wrong_terminal',
    })));
    render(<PlatformsSection />);
    await screen.findByText('Manage this platform from its assigned register.');
    expect(screen.queryByRole('switch')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Open' })).not.toBeInTheDocument();
  });

  it('requires seven explicit days before sending BOX hours and supports service after midnight', async () => {
    const box = makePlatform({ plugin_id: 'box', name: 'BOX', open: null, weekly_schedule: null, weekly_schedule_at: null, weekly_schedule_revision: 'a'.repeat(64) });
    const week = {
      monday: [], tuesday: [], wednesday: [], thursday: [], friday: [], saturday: [],
      sunday: [{ from: '17:00', to: '06:00' }],
    };
    posApiGet.mockResolvedValue(listResponse(box));
    posApiPost.mockResolvedValue(actionResponse({ ...box, weekly_schedule: week, weekly_schedule_at: '2026-11-18T08:00:00Z' }));
    render(<PlatformsSection />);
    fireEvent.click(await screen.findByRole('button', { name: 'Weekly hours' }));
    const save = screen.getByRole('button', { name: 'Send week to BOX' });
    expect(save).toBeDisabled();
    const noStarts = screen.getAllByRole('checkbox', { name: 'No hours start this day' });
    expect(noStarts).toHaveLength(7);
    noStarts.slice(0, 6).forEach(box => { expect(box).not.toBeChecked(); fireEvent.click(box); });
    expect(save).toBeDisabled();
    const sunday = within(screen.getByRole('group', { name: 'Sunday' }));
    fireEvent.click(sunday.getByRole('button', { name: 'Add hours' }));
    fireEvent.change(sunday.getByLabelText('From'), { target: { value: '17:00' } });
    fireEvent.change(sunday.getByLabelText('To'), { target: { value: '06:00' } });
    expect(sunday.getByText('Next day')).toBeInTheDocument();
    const monday = within(screen.getByRole('group', { name: 'Monday' }));
    fireEvent.click(monday.getByRole('button', { name: 'Add hours' }));
    fireEvent.change(monday.getByLabelText('From'), { target: { value: '05:30' } });
    fireEvent.change(monday.getByLabelText('To'), { target: { value: '10:00' } });
    expect(save).toBeDisabled();
    fireEvent.click(monday.getByRole('checkbox'));
    fireEvent.click(save);
    expect(posApiPost).toHaveBeenCalledWith('/pos/platforms?plugin_id=box', { plugin_id: 'box', weekly_schedule: week, expected_schedule_revision: box.weekly_schedule_revision });
    await screen.findByText(/Last schedule sent from the POS/);
    expect(save).toBeDisabled();
  });

  it('keeps a first draft tied to its shop when neither shop has submitted a week', async () => {
    const shop = makePlatform({ plugin_id: 'box', name: 'BOX', open: null, weekly_schedule: null, weekly_schedule_at: null, weekly_schedule_revision: 'a'.repeat(64) });
    posApiGet.mockResolvedValueOnce(listResponse(shop)).mockResolvedValueOnce(listResponse({ ...shop, weekly_schedule_revision: 'b'.repeat(64) }));
    render(<PlatformsSection />);
    fireEvent.click(await screen.findByRole('button', { name: 'Weekly hours' }));
    screen.getAllByRole('checkbox', { name: 'No hours start this day' }).forEach(day => fireEvent.click(day));
    const save = screen.getByRole('button', { name: 'Send week to BOX' });
    expect(save).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await screen.findByText(/Another register saved a newer schedule/);
    expect(save).toBeDisabled();
    expect(posApiPost).not.toHaveBeenCalled();
  });

  it.each([
    ['busy (HTTP 409)', 'The platform is busy. Try again shortly.'],
    ['provider_rejected (HTTP 502)', 'BOX rejected the request.'],
    ['outcome_unknown (HTTP 502)', 'Could not confirm the request. Check the shop in BOX Merchant.'],
  ])('shows BOX schedule feedback for %s and keeps the draft editable', async (error, instruction) => {
    const box = makePlatform({ plugin_id: 'box', name: 'BOX', open: null, weekly_schedule: null, weekly_schedule_revision: 'a'.repeat(64) });
    posApiGet.mockResolvedValue(listResponse(box));
    posApiPost.mockResolvedValue({ success: false, error });
    render(<PlatformsSection />);
    fireEvent.click(await screen.findByRole('button', { name: 'Weekly hours' }));
    screen.getAllByRole('checkbox', { name: 'No hours start this day' }).forEach(day => fireEvent.click(day));
    const save = screen.getByRole('button', { name: 'Send week to BOX' });
    fireEvent.click(save);
    await screen.findByText(instruction);
    expect(save).toBeEnabled();
    expect(screen.queryByText(/Another register saved a newer schedule/)).not.toBeInTheDocument();
  });

  it('preserves unsaved BOX hours on a version conflict and reloads the last POS copy on request', async () => {
    const week = { monday: [{ from: '09:00', to: '14:00' }], tuesday: [], wednesday: [], thursday: [], friday: [], saturday: [], sunday: [] };
    const previous = '2026-11-18T08:00:00Z';
    const box = makePlatform({ plugin_id: 'box', name: 'BOX', open: null, weekly_schedule: week, weekly_schedule_at: previous, weekly_schedule_revision: 'a'.repeat(64) });
    posApiGet.mockResolvedValueOnce(listResponse(box, makePlatform({ controllable: false }))).mockResolvedValueOnce({ success: false });
    boxDetails.mockResolvedValueOnce(listResponse(box)).mockResolvedValueOnce({ success: false, status: 429 }).mockResolvedValueOnce(listResponse({
      ...box, weekly_schedule: { ...week, monday: [{ from: '10:00', to: '18:00' }] },
      weekly_schedule_at: '2026-11-18T09:00:00Z', weekly_schedule_revision: 'b'.repeat(64),
    }));
    posApiPost.mockResolvedValue({ success: false, error: 'schedule_conflict (HTTP 409): conflict' });
    render(<PlatformsSection />);
    fireEvent.click(await screen.findByRole('button', { name: 'Weekly hours' }));
    fireEvent.change(screen.getByLabelText('To'), { target: { value: '15:00' } });
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Refresh' })).toBeEnabled());
    expect(screen.getByText('Could not load platforms')).toBeInTheDocument();
    expect(screen.queryByText('efood')).not.toBeInTheDocument();
    expect(screen.getByLabelText('To')).toHaveValue('15:00');
    fireEvent.click(screen.getByRole('button', { name: 'Send week to BOX' }));
    await screen.findByText(/Another register saved a newer schedule/);
    expect(screen.getByLabelText('To')).toHaveValue('15:00');
    expect(posApiPost).toHaveBeenCalledWith('/pos/platforms?plugin_id=box', expect.objectContaining({ expected_schedule_revision: box.weekly_schedule_revision }));
    expect(screen.getByRole('button', { name: 'Send week to BOX' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Discard my changes and reload' }));
    expect(await screen.findByText('Could not refresh BOX. Try again.')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Discard my changes and reload' })).toBeEnabled());
    expect(screen.getByLabelText('To')).toHaveValue('15:00');
    fireEvent.click(screen.getByRole('button', { name: 'Discard my changes and reload' }));
    await waitFor(() => expect(screen.getByLabelText('To')).toHaveValue('18:00'));
  });

  it('keeps the BOX draft mounted and disables submission during an uncontrollable detail refresh', async () => {
    const week = { monday: [{ from: '09:00', to: '14:00' }], tuesday: [], wednesday: [], thursday: [], friday: [], saturday: [], sunday: [] };
    const box = makePlatform({ plugin_id: 'box', name: 'BOX', open: null, weekly_schedule: week, weekly_schedule_revision: 'a'.repeat(64) });
    const failed = { ...box, controllable: false, reason: 'provider_unavailable', weekly_schedule: undefined, weekly_schedule_revision: undefined };
    posApiGet.mockResolvedValue(listResponse(box));
    boxDetails.mockResolvedValueOnce(listResponse(box)).mockResolvedValueOnce(listResponse(failed));
    render(<PlatformsSection />);
    fireEvent.click(await screen.findByRole('button', { name: 'Weekly hours' }));
    fireEvent.change(screen.getByLabelText('To'), { target: { value: '15:00' } });
    const save = screen.getByRole('button', { name: 'Send week to BOX' });
    expect(save).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await screen.findByText('Could not refresh BOX. Try again.');
    expect(screen.getByLabelText('To')).toHaveValue('15:00');
    expect(save).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() => expect(save).toBeEnabled());
    expect(screen.getByLabelText('To')).toHaveValue('15:00');
  });

  it('shows a Wolt-style outside-hours limitation instead of implying it is receiving orders', async () => {
    posApiGet.mockResolvedValue({
      success: true,
      data: {
        success: true,
        platforms: [
          makePlatform({
            plugin_id: 'wolt',
            name: 'Wolt',
            open: true,
            accepting_orders: false,
            reason: 'outside_hours',
          }),
        ],
      },
    });
    render(<PlatformsSection />);
    await screen.findByText('Open');
    expect(screen.getByText('Not receiving orders right now')).toBeInTheDocument();
    expect(screen.getByText('Online, but outside the scheduled ordering hours — not receiving orders.')).toBeInTheDocument();
    expect(screen.getByRole('switch')).toHaveAttribute('aria-checked', 'true');
  });

  it('shows a pending state then replaces it with the confirmed response on toggle', async () => {
    posApiGet.mockResolvedValue({ success: true, data: { success: true, platforms: [makePlatform({ open: false })] } });
    let resolvePost!: (value: unknown) => void;
    posApiPost.mockReturnValue(new Promise((resolve) => { resolvePost = resolve; }));
    render(<PlatformsSection />);
    await waitFor(() => expect(screen.getByRole('switch')).toHaveAttribute('aria-checked', 'false'));

    fireEvent.click(screen.getByRole('switch'));
    expect(screen.getByRole('switch')).toBeDisabled();

    await act(async () => resolvePost({
      success: true,
      data: { success: true, platform: makePlatform({ open: true }) },
    }));

    await waitFor(() => expect(screen.getByRole('switch')).toHaveAttribute('aria-checked', 'true'));
    expect(screen.getByRole('switch')).toBeEnabled();
    expect(posApiPost).toHaveBeenCalledWith('/pos/platforms', { plugin_id: 'efood', open: true });
  });

  it('shows Unknown (not the previous open/closed value) and flags uncertainty on a rejected toggle', async () => {
    posApiGet.mockResolvedValue({ success: true, data: { success: true, platforms: [makePlatform({ open: true })] } });
    posApiPost.mockResolvedValue({ success: false, error: 'busy' });
    render(<PlatformsSection />);
    await waitFor(() => expect(screen.getByRole('switch')).toHaveAttribute('aria-checked', 'true'));

    fireEvent.click(screen.getByRole('switch'));
    await screen.findByText(/Could not confirm the result/);
    expect(screen.getByText('Unknown')).toBeInTheDocument();
    expect(screen.getByText('Last known: Open')).toBeInTheDocument();
    expect(screen.queryByText(/^busy$/)).not.toBeInTheDocument();
  });

  it('shows Unknown and flags uncertainty when the toggle request throws, without leaking raw error text', async () => {
    posApiGet.mockResolvedValue({ success: true, data: { success: true, platforms: [makePlatform({ open: false })] } });
    posApiPost.mockRejectedValue(new Error('ECONNRESET raw provider failure'));
    render(<PlatformsSection />);
    await waitFor(() => expect(screen.getByRole('switch')).toHaveAttribute('aria-checked', 'false'));

    fireEvent.click(screen.getByRole('switch'));
    await screen.findByText(/Could not confirm the result/);
    expect(screen.getByText('Unknown')).toBeInTheDocument();
    expect(screen.getByText('Last known: Closed')).toBeInTheDocument();
    expect(screen.queryByText(/ECONNRESET/)).not.toBeInTheDocument();
  });

  it('ignores a second rapid click on the same platform instead of firing a duplicate POST', async () => {
    posApiGet.mockResolvedValue({ success: true, data: { success: true, platforms: [makePlatform({ open: false })] } });
    let resolvePost!: (value: unknown) => void;
    posApiPost.mockReturnValue(new Promise((resolve) => { resolvePost = resolve; }));
    render(<PlatformsSection />);
    await waitFor(() => expect(screen.getByRole('switch')).toHaveAttribute('aria-checked', 'false'));

    const switchEl = screen.getByRole('switch');
    fireEvent.click(switchEl);
    fireEvent.click(switchEl);
    fireEvent.click(switchEl);
    expect(posApiPost).toHaveBeenCalledTimes(1);

    await act(async () => resolvePost({ success: true, data: { success: true, platform: makePlatform({ open: true }) } }));
    await waitFor(() => expect(screen.getByRole('switch')).toHaveAttribute('aria-checked', 'true'));
  });

  it('shows a localized load-failure message and never the raw response body on GET failure', async () => {
    posApiGet.mockResolvedValue({ success: false, error: '<!doctype html>raw upstream failure' });
    render(<PlatformsSection />);
    await screen.findByText('Could not load platforms');
    expect(screen.queryByText(/raw upstream failure/)).not.toBeInTheDocument();
  });

  it('treats a rejected GET promise as a load failure, not a fake empty success', async () => {
    posApiGet.mockRejectedValue(new Error('network down'));
    render(<PlatformsSection />);
    await screen.findByText('Could not load platforms');
    expect(screen.queryByText('No delivery platforms connected')).not.toBeInTheDocument();
  });

  it('treats a malformed (non-array) platforms list as a load failure, not an empty success', async () => {
    posApiGet.mockResolvedValue({ success: true, data: { success: true, platforms: 'not-a-list' } });
    render(<PlatformsSection />);
    await screen.findByText('Could not load platforms');
    expect(screen.queryByText('No delivery platforms connected')).not.toBeInTheDocument();
  });

  it('disables the switch and does not POST while offline', async () => {
    posApiGet.mockResolvedValue({ success: true, data: { success: true, platforms: [makePlatform({ open: true })] } });
    render(<PlatformsSection />);
    await waitFor(() => expect(screen.getByRole('switch')).toHaveAttribute('aria-checked', 'true'));

    act(() => {
      Object.defineProperty(window.navigator, 'onLine', { value: false, configurable: true });
      window.dispatchEvent(new Event('offline'));
    });

    await waitFor(() => expect(screen.getByRole('switch')).toBeDisabled());
    fireEvent.click(screen.getByRole('switch'));
    await flush();
    expect(posApiPost).not.toHaveBeenCalled();
  });

  it('rechecks status when the browser comes back online', async () => {
    posApiGet.mockResolvedValue({ success: true, data: { success: true, platforms: [makePlatform({ open: true })] } });
    render(<PlatformsSection />);
    await waitFor(() => expect(posApiGet).toHaveBeenCalledTimes(1));

    act(() => {
      Object.defineProperty(window.navigator, 'onLine', { value: false, configurable: true });
      window.dispatchEvent(new Event('offline'));
    });
    act(() => {
      Object.defineProperty(window.navigator, 'onLine', { value: true, configurable: true });
      window.dispatchEvent(new Event('online'));
    });

    await waitFor(() => expect(posApiGet).toHaveBeenCalledTimes(2));
  });

  it('rechecks status on window focus', async () => {
    posApiGet.mockResolvedValue({ success: true, data: { success: true, platforms: [makePlatform({ open: true })] } });
    render(<PlatformsSection />);
    await waitFor(() => expect(posApiGet).toHaveBeenCalledTimes(1));

    act(() => { window.dispatchEvent(new Event('focus')); });
    await waitFor(() => expect(posApiGet).toHaveBeenCalledTimes(2));
  });

  it('never lets a slower refresh overwrite a newer, already-confirmed mutation result', async () => {
    let resolveFirstGet!: (value: unknown) => void;
    posApiGet.mockReturnValueOnce(new Promise((resolve) => { resolveFirstGet = resolve; }));
    render(<PlatformsSection />);

    resolveFirstGet({ success: true, data: { success: true, platforms: [makePlatform({ open: false })] } });
    await waitFor(() => expect(screen.getByRole('switch')).toHaveAttribute('aria-checked', 'false'));

    let resolveRefreshGet!: (value: unknown) => void;
    posApiGet.mockReturnValueOnce(new Promise((resolve) => { resolveRefreshGet = resolve; }));
    fireEvent.click(screen.getByRole('button', { name: /Refresh/ }));

    posApiPost.mockResolvedValue({ success: true, data: { success: true, platform: makePlatform({ open: true }) } });
    fireEvent.click(screen.getByRole('switch'));
    await waitFor(() => expect(screen.getByRole('switch')).toHaveAttribute('aria-checked', 'true'));

    resolveRefreshGet({ success: true, data: { success: true, platforms: [makePlatform({ open: false })] } });
    await flush();
    expect(screen.getByRole('switch')).toHaveAttribute('aria-checked', 'true');
  });

  it('keeps a confirmed toggle visible when an older refresh fails', async () => {
    posApiGet.mockResolvedValueOnce({ success: true, data: { success: true, platforms: [makePlatform({ open: false })] } });
    render(<PlatformsSection />);
    await screen.findByRole('switch');
    let rejectRefresh!: (error: Error) => void;
    posApiGet.mockReturnValueOnce(new Promise((_resolve, reject) => { rejectRefresh = reject; }));
    fireEvent.click(screen.getByRole('button', { name: /Refresh/ }));
    posApiPost.mockResolvedValueOnce({ success: true, data: { success: true, platform: makePlatform({ open: true }) } });
    fireEvent.click(screen.getByRole('switch'));
    await waitFor(() => expect(screen.getByRole('switch')).toHaveAttribute('aria-checked', 'true'));
    await act(async () => { rejectRefresh(new Error('late network failure')); });
    expect(screen.getByRole('switch')).toHaveAttribute('aria-checked', 'true');
    expect(screen.queryByText('Could not load platforms')).not.toBeInTheDocument();
  });

  it('keeps a newer confirmed row omitted by a stale GET but removes it on a fresh acquisition list', async () => {
    posApiGet.mockResolvedValueOnce({ success: true, data: { success: true, platforms: [makePlatform({ open: false })] } });
    render(<PlatformsSection />);
    await screen.findByRole('switch');
    let resolveRefresh!: (value: unknown) => void;
    posApiGet.mockReturnValueOnce(new Promise(resolve => { resolveRefresh = resolve; }));
    fireEvent.click(screen.getByRole('button', { name: /Refresh/ }));
    posApiPost.mockResolvedValueOnce({ success: true, data: { success: true, platform: makePlatform({ open: true }) } });
    fireEvent.click(screen.getByRole('switch'));
    await waitFor(() => expect(screen.getByRole('switch')).toHaveAttribute('aria-checked', 'true'));
    await act(async () => resolveRefresh({ success: true, data: { success: true, platforms: [] } }));
    expect(screen.getByRole('switch')).toHaveAttribute('aria-checked', 'true');
    posApiGet.mockResolvedValueOnce({ success: true, data: { success: true, platforms: [] } });
    fireEvent.click(screen.getByRole('button', { name: /Refresh/ }));
    await screen.findByText('No delivery platforms connected');
    expect(screen.queryByRole('switch')).not.toBeInTheDocument();
  });

  it('marks untouched providers unknown when a failed refresh predates another provider toggle', async () => {
    posApiGet.mockResolvedValueOnce({ success: true, data: { success: true, platforms: [
      makePlatform({ open: false }), makePlatform({ plugin_id: 'wolt', name: 'Wolt', open: true }),
    ] } });
    render(<PlatformsSection />);
    await screen.findByRole('switch', { name: 'efood' });
    let resolveRefresh!: (value: unknown) => void;
    posApiGet.mockReturnValueOnce(new Promise(resolve => { resolveRefresh = resolve; }));
    fireEvent.click(screen.getByRole('button', { name: /Refresh/ }));
    posApiPost.mockResolvedValueOnce({ success: true, data: { success: true, platform: makePlatform({ open: true }) } });
    fireEvent.click(screen.getByRole('switch', { name: 'efood' }));
    await waitFor(() => expect(screen.getByRole('switch', { name: 'efood' })).toHaveAttribute('aria-checked', 'true'));
    await act(async () => resolveRefresh({ success: false }));
    expect(screen.getByRole('switch', { name: 'efood' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.queryByRole('switch', { name: 'Wolt' })).not.toBeInTheDocument();
    expect(screen.getByText('Wolt')).toBeInTheDocument();
    expect(screen.getByText('Unknown')).toBeInTheDocument();
  });

  it('discards a stale, superseded GET response instead of applying it (refresh-vs-refresh race)', async () => {
    let resolveFirstGet!: (value: unknown) => void;
    let resolveSecondGet!: (value: unknown) => void;
    posApiGet
      .mockReturnValueOnce(new Promise((resolve) => { resolveFirstGet = resolve; }))
      .mockReturnValueOnce(new Promise((resolve) => { resolveSecondGet = resolve; }));
    render(<PlatformsSection />);

    // Trigger a second GET (refresh) before the first has resolved.
    act(() => { window.dispatchEvent(new Event('focus')); });
    await waitFor(() => expect(posApiGet).toHaveBeenCalledTimes(2));

    // Second (newer) request resolves first, with the true current state.
    resolveSecondGet({ success: true, data: { success: true, platforms: [makePlatform({ open: true })] } });
    await waitFor(() => expect(screen.getByRole('switch')).toHaveAttribute('aria-checked', 'true'));

    // First (older, slower) request resolves after — it must be discarded.
    resolveFirstGet({ success: true, data: { success: true, platforms: [makePlatform({ open: false })] } });
    await flush();
    expect(screen.getByRole('switch')).toHaveAttribute('aria-checked', 'true');
  });

  it('discards a stale refresh response after unmount without throwing', async () => {
    let resolveGet!: (value: unknown) => void;
    posApiGet.mockReturnValue(new Promise((resolve) => { resolveGet = resolve; }));
    const { unmount } = render(<PlatformsSection />);
    unmount();
    expect(() => resolveGet({ success: true, data: { success: true, platforms: [makePlatform()] } })).not.toThrow();
    await flush();
  });

  it('offers "Weekly hours" only for a connected, controllable efood card', async () => {
    posApiGet.mockResolvedValue({
      success: true,
      data: {
        success: true,
        platforms: [
          makePlatform({ plugin_id: 'efood', name: 'efood', controllable: true }),
          makePlatform({ plugin_id: 'wolt', name: 'wolt', controllable: true }),
          makePlatform({ plugin_id: 'efood-locked', name: 'efood locked', controllable: false }),
        ],
      },
    });
    render(<PlatformsSection />);
    await screen.findByText('efood');

    expect(screen.getAllByText('Weekly hours')).toHaveLength(1);
    expect(screen.queryByText('efood locked')).toBeInTheDocument();
  });

  it('opens the efood weekly hours editor from the platform card', async () => {
    posApiGet.mockImplementation((path: string) => {
      if (path === '/pos/platforms/efood/schedule') {
        return Promise.resolve({
          success: true,
          data: { success: true, schedule: { days: [], checked_at: null } },
        });
      }
      return Promise.resolve({
        success: true,
        data: { success: true, platforms: [makePlatform({ plugin_id: 'efood', name: 'efood', controllable: true })] },
      });
    });
    render(<PlatformsSection />);
    await screen.findByText('efood');

    fireEvent.click(screen.getByText('Weekly hours'));
    expect(await screen.findByRole('dialog', { name: 'efood weekly hours' })).toBeInTheDocument();
  });

  it('shows "Opening…" and the awaiting explanation, never the uncertain banner, while efood catches up', async () => {
    posApiGet.mockResolvedValue(listResponse(makePlatform({ open: false })));
    posApiPost.mockResolvedValue(actionResponse(
      makePlatform({ open: true, pending: true, reason: 'awaiting_provider_confirmation' }),
    ));
    render(<PlatformsSection />);
    fireEvent.click(await screen.findByRole('switch'));

    await screen.findByText('Opening…');
    expect(screen.getByText(AWAITING_TEXT)).toBeInTheDocument();
    expect(screen.queryByText('Open')).not.toBeInTheDocument();
    expect(screen.queryByText('Unknown')).not.toBeInTheDocument();
    expect(screen.queryByText(UNCERTAIN_TEXT)).not.toBeInTheDocument();
    // Staff can still change their mind: the switch shows the requested state and stays usable.
    await waitFor(() => expect(screen.getByRole('switch')).toBeEnabled());
    expect(screen.getByRole('switch')).toHaveAttribute('aria-checked', 'true');
  });

  it('shows "Closing…" for an accepted close and sends a new request when staff change their mind', async () => {
    posApiGet.mockResolvedValue(listResponse(makePlatform({ open: true })));
    posApiPost
      .mockResolvedValueOnce(actionResponse(makePlatform({ open: false, pending: true, reason: 'awaiting_provider_confirmation' })))
      .mockResolvedValueOnce(actionResponse(makePlatform({ open: true, pending: true, reason: 'awaiting_provider_confirmation' })));
    render(<PlatformsSection />);
    fireEvent.click(await screen.findByRole('switch'));

    await screen.findByText('Closing…');
    expect(screen.getByText(AWAITING_TEXT)).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('switch')).toBeEnabled());
    expect(screen.getByRole('switch')).toHaveAttribute('aria-checked', 'false');

    fireEvent.click(screen.getByRole('switch'));
    await screen.findByText('Opening…');
    expect(posApiPost).toHaveBeenNthCalledWith(1, '/pos/platforms', { plugin_id: 'efood', open: false });
    expect(posApiPost).toHaveBeenNthCalledWith(2, '/pos/platforms', { plugin_id: 'efood', open: true });
  });

  it('drops the pending label when a later change cannot be confirmed', async () => {
    posApiGet.mockResolvedValue(listResponse(
      makePlatform({ open: true, pending: true, reason: 'awaiting_provider_confirmation' }),
    ));
    posApiPost.mockResolvedValue({ success: false, error: 'outcome_unknown (HTTP 502)' });
    render(<PlatformsSection />);
    await screen.findByText('Opening…');

    fireEvent.click(screen.getByRole('switch'));
    await screen.findByText(UNCERTAIN_TEXT);
    expect(screen.getByText('Unknown')).toBeInTheDocument();
    expect(screen.queryByText('Opening…')).not.toBeInTheDocument();
  });

  it.each([
    ['as the error code', { success: false, error: 'provider_rejected' }],
    ['wrapped by the IPC transport', { success: false, error: 'provider_rejected (HTTP 502): efood refused the change' }],
    ['in the response body', { success: true, data: { success: false, error: 'provider_rejected' } }],
  ])('keeps the previous status and explains a provider refusal %s', async (_where, result) => {
    posApiGet.mockResolvedValue(listResponse(makePlatform({ open: false })));
    posApiPost.mockResolvedValue(result);
    render(<PlatformsSection />);
    fireEvent.click(await screen.findByRole('switch'));

    await screen.findByText(REJECTED_TEXT);
    expect(screen.getByText('Closed')).toBeInTheDocument();
    expect(screen.queryByText('Unknown')).not.toBeInTheDocument();
    expect(screen.queryByText(UNCERTAIN_TEXT)).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('switch')).toBeEnabled());
    expect(screen.getByRole('switch')).toHaveAttribute('aria-checked', 'false');
  });

  it('explains when efood itself reports the store closed', async () => {
    posApiGet.mockResolvedValue(listResponse(makePlatform({ open: false, reason: 'provider_reports_closed' })));
    render(<PlatformsSection />);
    await screen.findByText("The platform reports the store as closed. Check the platform's tablet or app.");
    expect(screen.getByText('Closed')).toBeInTheDocument();
  });

  it('says efood closed the store again after an accepted open, with the closure it reports, never "Opening…"', async () => {
    posApiGet.mockResolvedValue(listResponse(makePlatform({
      open: false, reason: 'closed_by_provider', closure_status: 'close_indefinite', closed_until: null,
    })));
    render(<PlatformsSection />);
    await screen.findByText(CLOSED_BY_PROVIDER_TEXT);
    expect(screen.getByText('Closed')).toBeInTheDocument();
    expect(screen.getByText('efood status: close_indefinite')).toBeInTheDocument();
    expect(screen.queryByText('Opening…')).not.toBeInTheDocument();
    expect(screen.queryByText(UNCERTAIN_TEXT)).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('switch')).toBeEnabled());
    expect(screen.getByRole('switch')).toHaveAttribute('aria-checked', 'false');
  });

  describe('efood Partner page hosted in the POS', () => {
    beforeEach(() => {
      efoodPartnerHook.settings = { enabled: true, muted: false };
      efoodPartnerHook.updateSettings.mockReset();
    });

    it('offers the in-POS page as a toggle on the efood card and saves it (its mute lives in Display & sound)', async () => {
      posApiGet.mockResolvedValue(listResponse(makePlatform({ open: true })));
      render(<PlatformsSection />);

      const pageToggle = await screen.findByRole('button', { name: 'efood page inside the POS' });
      expect(pageToggle).toHaveAttribute('aria-pressed', 'true');
      fireEvent.click(pageToggle);
      expect(efoodPartnerHook.updateSettings).toHaveBeenCalledWith({ enabled: false });

      expect(screen.queryByRole('button', { name: 'Mute efood sounds' })).not.toBeInTheDocument();
      // The efood switch itself is untouched: still the only switch on the card.
      expect(screen.getAllByRole('switch')).toHaveLength(1);
    });

    it('shows the saved state of the page toggle', async () => {
      efoodPartnerHook.settings = { enabled: false, muted: true };
      posApiGet.mockResolvedValue(listResponse(makePlatform({ open: true })));
      render(<PlatformsSection />);
      expect(await screen.findByRole('button', { name: 'efood page inside the POS' })).toHaveAttribute('aria-pressed', 'false');
    });

    it('keeps the toggles off the cards of other platforms and of an efood that this register cannot manage', async () => {
      posApiGet.mockResolvedValue(listResponse(
        makePlatform({ plugin_id: 'wolt', name: 'Wolt', open: true }),
        makePlatform({ open: null, controllable: false, reason: 'wrong_terminal' }),
      ));
      render(<PlatformsSection />);
      await screen.findByText('Wolt');
      expect(screen.queryByRole('button', { name: 'efood page inside the POS' })).not.toBeInTheDocument();
    });
  });

  describe('automatic re-read while efood catches up', () => {

    it('re-reads 30 s after the change is accepted, then every 60 s, and stops once nothing is pending', async () => {
      vi.useFakeTimers();
      posApiGet.mockResolvedValueOnce(listResponse(makePlatform({ open: false })));
      render(<PlatformsSection />);
      await advance(0);
      expect(posApiGet).toHaveBeenCalledTimes(1);

      const opening = makePlatform({ open: true, pending: true, reason: 'awaiting_provider_confirmation' });
      posApiPost.mockResolvedValueOnce(actionResponse(opening));
      posApiGet.mockResolvedValue(listResponse(opening));
      fireEvent.click(screen.getByRole('switch'));
      await advance(0);
      expect(screen.getByText('Opening…')).toBeInTheDocument();

      await advance(29_999);
      expect(posApiGet).toHaveBeenCalledTimes(1);
      await advance(1);
      expect(posApiGet).toHaveBeenCalledTimes(2);
      expect(posApiGet).toHaveBeenLastCalledWith('/pos/platforms');
      expect(screen.getByText('Opening…')).toBeInTheDocument();

      await advance(59_999);
      expect(posApiGet).toHaveBeenCalledTimes(2);
      posApiGet.mockResolvedValue(listResponse(makePlatform({ open: true })));
      await advance(1);
      expect(posApiGet).toHaveBeenCalledTimes(3);
      expect(screen.getByText('Open')).toBeInTheDocument();
      expect(screen.queryByText('Opening…')).not.toBeInTheDocument();

      await advance(15 * 60_000);
      expect(posApiGet).toHaveBeenCalledTimes(3);
    });

    it('drops "Opening…" and explains as soon as a re-read says efood closed the store again, then stops', async () => {
      vi.useFakeTimers();
      posApiGet.mockResolvedValueOnce(listResponse(
        makePlatform({ open: true, pending: true, reason: 'awaiting_provider_confirmation' }),
      ));
      render(<PlatformsSection />);
      await advance(0);
      expect(screen.getByText('Opening…')).toBeInTheDocument();

      posApiGet.mockResolvedValue(listResponse(makePlatform({
        open: false, reason: 'closed_by_provider', closure_status: 'close_indefinite',
      })));
      await advance(30_000);
      expect(posApiGet).toHaveBeenCalledTimes(2);
      expect(screen.getByText(CLOSED_BY_PROVIDER_TEXT)).toBeInTheDocument();
      expect(screen.getByText('Closed')).toBeInTheDocument();
      expect(screen.queryByText('Opening…')).not.toBeInTheDocument();

      await advance(15 * 60_000);
      expect(posApiGet).toHaveBeenCalledTimes(2);
    });

    it('starts from a list read and gives up 15 minutes after the wait began', async () => {
      vi.useFakeTimers();
      posApiGet.mockResolvedValue(listResponse(
        makePlatform({ open: false, pending: true, reason: 'awaiting_provider_confirmation' }),
      ));
      render(<PlatformsSection />);
      await advance(0);
      expect(screen.getByText('Closing…')).toBeInTheDocument();
      expect(posApiGet).toHaveBeenCalledTimes(1);

      // Re-reads at 0:30, 1:30, … 14:30: fifteen inside the window, none after it.
      await advance(15 * 60_000);
      expect(posApiGet).toHaveBeenCalledTimes(16);
      await advance(30 * 60_000);
      expect(posApiGet).toHaveBeenCalledTimes(16);
    });

    it('does not re-read while offline and picks the cadence back up after reconnecting', async () => {
      vi.useFakeTimers();
      posApiGet.mockResolvedValue(listResponse(
        makePlatform({ open: true, pending: true, reason: 'awaiting_provider_confirmation' }),
      ));
      render(<PlatformsSection />);
      await advance(0);
      expect(posApiGet).toHaveBeenCalledTimes(1);

      setOnline(false);
      await advance(5 * 60_000);
      expect(posApiGet).toHaveBeenCalledTimes(1);

      setOnline(true);
      await advance(0);
      expect(posApiGet).toHaveBeenCalledTimes(2); // the existing reconnect re-check
      // Five minutes into the wait, the next slot on the cadence is 5:30.
      await advance(29_999);
      expect(posApiGet).toHaveBeenCalledTimes(2);
      await advance(1);
      expect(posApiGet).toHaveBeenCalledTimes(3);
    });

    it('clears the scheduled re-read when the section unmounts', async () => {
      vi.useFakeTimers();
      posApiGet.mockResolvedValue(listResponse(
        makePlatform({ open: true, pending: true, reason: 'awaiting_provider_confirmation' }),
      ));
      const { unmount } = render(<PlatformsSection />);
      await advance(0);
      expect(posApiGet).toHaveBeenCalledTimes(1);

      unmount();
      await advance(15 * 60_000);
      expect(posApiGet).toHaveBeenCalledTimes(1);
    });

    it('shows Closed with the opening time for an «Open» pressed before hours, and keeps re-reading', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date(2026, 8, 14, 23, 0, 0)); // Monday night on the register's clock
      posApiGet.mockResolvedValue(listResponse(
        makePlatform({ open: false, reason: 'closed_until_day_start', closed_until: '2026-09-15T05:00:00' }),
      ));
      render(<PlatformsSection />);
      await advance(0);
      expect(screen.getByText(DAY_START_TEXT)).toBeInTheDocument();

      const reopensAtOpening = makePlatform({
        open: false,
        pending: true,
        reason: 'reopens_at_opening',
        closed_until: '2026-09-15T09:00:00',
      });
      posApiPost.mockResolvedValueOnce(actionResponse(reopensAtOpening));
      posApiGet.mockResolvedValue(listResponse(reopensAtOpening));
      fireEvent.click(screen.getByRole('switch'));
      await advance(0);

      expect(posApiPost).toHaveBeenCalledWith('/pos/platforms', { plugin_id: 'efood', open: true });
      expect(screen.getByText('Closed')).toBeInTheDocument();
      expect(screen.getByText('Opens automatically at Tue 09:00.')).toBeInTheDocument();
      expect(screen.queryByText('Closing…')).not.toBeInTheDocument();
      expect(screen.queryByText(/Closed until/)).not.toBeInTheDocument();
      expect(screen.queryByText(UNCERTAIN_TEXT)).not.toBeInTheDocument();
      expect(screen.getByRole('switch')).toBeEnabled();
      expect(screen.getByRole('switch')).toHaveAttribute('aria-checked', 'false');

      // `pending` still drives the loop even though no pending label is shown.
      await advance(30_000);
      expect(posApiGet).toHaveBeenCalledTimes(2);
      expect(screen.getByText('Opens automatically at Tue 09:00.')).toBeInTheDocument();
    });
  });

  describe('closure end', () => {
    beforeEach(() => {
      // Only Date is faked, so findBy/waitFor keep their real timers.
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date(2026, 8, 14, 9, 0, 0)); // Monday 14/09/2026 on the register's clock
    });

    it.each([
      ['today', '2026-09-14T23:30:00', 'Closed until 23:30'],
      ['on another day', '2026-09-15T18:00:00', 'Closed until Tue 18:00'],
    ])('shows when a closure set outside the POS ends %s', async (_when, closedUntil, expected) => {
      posApiGet.mockResolvedValue(listResponse(makePlatform({ open: false, closed_until: closedUntil })));
      render(<PlatformsSection />);
      await screen.findByText(expected);
      expect(screen.getByText('Closed')).toBeInTheDocument();
    });

    it('shows no closure end while a change is pending, while open, or for a value with an offset', async () => {
      posApiGet.mockResolvedValue(listResponse(
        makePlatform({
          plugin_id: 'efood',
          name: 'efood',
          open: false,
          pending: true,
          reason: 'awaiting_provider_confirmation',
          closed_until: '2026-09-15T18:00:00',
        }),
        makePlatform({ plugin_id: 'efood-open', name: 'efood open', open: true, closed_until: '2026-09-15T18:00:00' }),
        makePlatform({ plugin_id: 'efood-offset', name: 'efood offset', open: false, closed_until: '2026-09-15T18:00:00+03:00' }),
      ));
      render(<PlatformsSection />);
      await screen.findByText('Closing…');
      expect(screen.getByText('Open')).toBeInTheDocument();
      expect(screen.getByText('Closed')).toBeInTheDocument();
      expect(screen.queryByText(/Closed until/)).not.toBeInTheDocument();
    });

    it.each([false, true])(
      'explains a POS or Z-report closure without its distant safety bound (pending: %s)',
      async (pending) => {
        posApiGet.mockResolvedValue(listResponse(
          makePlatform({ open: false, pending, reason: 'closed_until_day_start', closed_until: '2026-09-21T05:00:00' }),
        ));
        render(<PlatformsSection />);
        await screen.findByText(DAY_START_TEXT);
        expect(screen.getByText('Closed')).toBeInTheDocument();
        expect(screen.queryByText('Closing…')).not.toBeInTheDocument();
        expect(screen.queryByText(/05:00/)).not.toBeInTheDocument();
      },
    );

    it('says when opening hours reopen efood, with the time formatted like the closure end', async () => {
      posApiGet.mockResolvedValue(listResponse(
        makePlatform({ open: false, reason: 'reopens_at_opening', closed_until: '2026-09-14T18:00:00' }),
      ));
      render(<PlatformsSection />);
      await screen.findByText('Opens automatically at 18:00.');
      expect(screen.getByText('Closed')).toBeInTheDocument();
      expect(screen.queryByText(/Closed until/)).not.toBeInTheDocument();
    });
  });
});

describe('platforms locale overlays', () => {
  const overlays: Record<string, unknown> = {
    en: enPlatforms,
    el: elPlatforms,
    de: dePlatforms,
    fr: frPlatforms,
    it: itPlatforms,
    sq: sqPlatforms,
  };
  const newCopyKeys = [
    'settings.platforms.box.autoOpen',
    'settings.platforms.box.autoHelp',
    'settings.platforms.box.statusHelp',
    'settings.platforms.box.lastAction',
    'settings.platforms.box.automationUnconfirmed',
    'settings.platforms.box.requestUnconfirmed',
    'settings.platforms.manualClosureNote',
    'settings.platforms.closedUntil',
    'settings.platforms.status.opening',
    'settings.platforms.status.closing',
    'settings.platforms.reason.awaitingProviderConfirmation',
    'settings.platforms.reason.providerRejected',
    'settings.platforms.reason.providerReportsClosed',
    'settings.platforms.reason.closedUntilDayStart',
    'settings.platforms.reason.reopensAtOpening',
    'settings.platforms.reason.closedByProvider',
    'settings.platforms.closureStatus',
    'settings.platforms.efoodPartner.pageToggle',
    'settings.platforms.efoodPartner.mute',
    'settings.platforms.efoodPartner.help',
    'settings.platforms.efoodPartner.reload',
    'settings.platforms.efoodPartner.home',
    'settings.platforms.efoodPartner.unavailable',
  ];


  it('keeps all six overlays on the same keys', () => {
    const englishKeys = flattenKeys(enPlatforms).sort();
    for (const [locale, overlay] of Object.entries(overlays)) {
      expect({ locale, keys: flattenKeys(overlay).sort() }).toEqual({ locale, keys: englishKeys });
    }
  });

  it('translates the pending, closure and refusal copy in every locale', () => {
    for (const [locale, overlay] of Object.entries(overlays)) {
      for (const key of newCopyKeys) {
        const value = valueAt(overlay, key);
        const translated = typeof value === 'string' && value.trim() !== ''
          && (locale === 'en' || value !== valueAt(enPlatforms, key));
        expect({ locale, key, translated }).toEqual({ locale, key, translated: true });
      }
      for (const key of ['settings.platforms.closedUntil', 'settings.platforms.reason.reopensAtOpening']) {
        expect({ locale, key, value: valueAt(overlay, key) })
          .toEqual({ locale, key, value: expect.stringContaining('{{time}}') });
      }
      expect({ locale, value: valueAt(overlay, 'settings.platforms.closureStatus') })
        .toEqual({ locale, value: expect.stringContaining('{{status}}') });
    }
  });
});
