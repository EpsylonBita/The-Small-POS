import React from 'react';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({
  identity: { organizationId: 'org', branchId: 'A', terminalId: 'till' },
  listeners: new Map<string, (payload: unknown) => void>(),
  fetch: vi.fn(),
}));
vi.mock('../../../lib', () => ({
  getBridge: () => ({
    terminalConfig: { getOrganizationId: async () => 'org', getBusinessType: async () => 'restaurant' },
    modules: { fetchFromAdmin: fixture.fetch },
  }),
  onEvent: (name: string, fn: (payload: unknown) => void) => fixture.listeners.set(name, fn),
  offEvent: (name: string) => fixture.listeners.delete(name),
}));
vi.mock('../../services/terminal-credentials', () => ({ getCachedTerminalCredentials: () => fixture.identity }));
import { ModuleProvider, useModules } from '../module-context';

const reply = (ids: string[]) => ({ success: true, identityMatch: true, modules: {
  organization_id: 'org', timestamp: 'now', modules: ids.map(module_id => ({
    module_id, display_name: module_id, pos_enabled: true, is_purchased: true,
    show_in_navigation: true, category: 'vertical', route: `/${module_id}`, sort_order: 1,
  })),
} });
function State() {
  const state = useModules();
  return <output>{JSON.stringify({ tables: state.isModuleEnabled('tables'), ids: state.enabledModules.map(m => m.module.id) })}</output>;
}
beforeEach(() => {
  fixture.identity.branchId = 'A';
  fixture.fetch.mockReset();
  fixture.fetch.mockResolvedValue(reply(['tables']));
  localStorage.setItem('admin_dashboard_url', 'https://admin.test');
});
afterEach(() => { cleanup(); localStorage.clear(); fixture.listeners.clear(); });
async function move(store: string) {
  await act(async () => {
    fixture.identity.branchId = store;
    fixture.listeners.get('terminal-settings-updated')?.({ updated: ['terminal.branch_id'] });
  });
}
it('shows A modules, resyncs on a store move, and treats B empty as core only', async () => {
  render(<ModuleProvider><State /></ModuleProvider>);
  await waitFor(() => expect(screen.getByRole('status').textContent).toContain('"tables":true'));
  fixture.fetch.mockResolvedValue(reply([]));
  await move('B');
  await waitFor(() => expect(fixture.fetch).toHaveBeenCalledTimes(2));
  expect(screen.getByRole('status').textContent).toContain('"tables":false');
  expect(screen.getByRole('status').textContent).toContain('dashboard');
});
it('fences A late response and fetches B after the old request settles', async () => {
  let finish!: (value: ReturnType<typeof reply>) => void;
  fixture.fetch.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  render(<ModuleProvider><State /></ModuleProvider>);
  await waitFor(() => expect(fixture.fetch).toHaveBeenCalledTimes(1));
  fixture.fetch.mockResolvedValue(reply([]));
  await move('B');
  await act(async () => finish(reply(['tables'])));
  await waitFor(() => expect(fixture.fetch).toHaveBeenCalledTimes(2));
  expect(screen.getByRole('status').textContent).toContain('"tables":false');
});
it('rejects the old organization cache on the first updated start', async () => {
  localStorage.setItem('pos-modules-cache', JSON.stringify({ enabledModuleIds: ['tables'], organizationId: 'org', timestamp: Date.now() }));
  fixture.fetch.mockResolvedValue(reply([]));
  render(<ModuleProvider><State /></ModuleProvider>);
  await waitFor(() => expect(fixture.fetch).toHaveBeenCalledTimes(1));
  expect(screen.getByRole('status').textContent).toContain('"tables":false');
});
it('keeps a single store entitlement across a restart and ordinary refresh', async () => {
  const view = render(<ModuleProvider><State /></ModuleProvider>);
  await waitFor(() => expect(screen.getByRole('status').textContent).toContain('"tables":true'));
  await waitFor(() => expect(Object.keys(localStorage).some(key => key.startsWith('pos-store-modules-v3:'))).toBe(true));
  view.unmount();
  fixture.fetch.mockResolvedValue({ success: false, error: 'offline' });
  render(<ModuleProvider><State /></ModuleProvider>);
  await waitFor(() => expect(screen.getByRole('status').textContent).toContain('"tables":true'));
});


it('clears visible optional access when native identity validation refuses the server store', async () => {
  render(<ModuleProvider><State /></ModuleProvider>);
  await waitFor(() => expect(screen.getByRole('status').textContent).toContain('"tables":true'));
  fixture.fetch.mockResolvedValue({ success: false, identityMatch: false });
  await act(async () => fixture.listeners.get('terminal-settings-updated')?.({ updated: ['receipt.currency'] }));
  await waitFor(() => expect(screen.getByRole('status').textContent).toContain('"tables":false'));
});
