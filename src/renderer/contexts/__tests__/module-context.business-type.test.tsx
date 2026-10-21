import React from 'react';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';

const bridge = vi.hoisted(() => ({
  terminalConfig: {
    getOrganizationId: vi.fn(async () => 'org'),
    getBusinessType: vi.fn(async () => 'convenience_store'),
  },
  modules: { fetchFromAdmin: vi.fn(async () => ({ success: false })) },
}));
vi.mock('../../../lib', () => ({ getBridge: () => bridge, onEvent: vi.fn(), offEvent: vi.fn() }));
vi.mock('../../services/terminal-credentials', () => ({ getCachedTerminalCredentials: () => ({ terminalId: 'terminal' }) }));
import { ModuleProvider, useModules } from '../module-context';

function State() {
  const state = useModules();
  return <output>{JSON.stringify({ businessType: state.businessType, error: state.error, loading: state.isLoading })}</output>;
}
afterEach(() => { cleanup(); localStorage.clear(); });
it('resolves a convenience_store terminal without rejecting its business type', async () => {
  render(<ModuleProvider><State /></ModuleProvider>);
  await waitFor(() => expect(screen.getByRole('status').textContent).toContain('"businessType":"convenience"'));
  expect(screen.getByRole('status').textContent).not.toContain('Invalid business type');
  expect(bridge.modules.fetchFromAdmin).toHaveBeenCalled();
});
