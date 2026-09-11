import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MyDataCashierDiscovery } from '../MyDataCashierDiscovery';

const mocks = vi.hoisted(() => ({ capDiscover: vi.fn() }));
vi.mock('../../../../lib', () => ({ getBridge: () => ({ ecr: { capDiscover: mocks.capDiscover } }) }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (_key: string, fallback: string) => fallback }) }));
vi.mock('../../ui/pos-glass-components', () => ({
  POSGlassButton: ({ children, variant: _variant, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: string }) => <button {...props}>{children}</button>,
}));
const found = { success: true, candidates: [{ host: '192.168.1.169', detectedFamily: 'rbs_mat', label: 'MAT ECR', verification: 'network_only' }] };

describe('CAP cashier LAN discovery', () => {
  beforeEach(() => mocks.capDiscover.mockReset());
  afterEach(cleanup);
  it('only scans on request and only selects an IP after an explicit candidate click', async () => {
    mocks.capDiscover.mockResolvedValue(found);
    const select = vi.fn();
    render(<MyDataCashierDiscovery scopeKey="branch-a/terminal-a" onSelect={select} disabled={false} />);
    expect(mocks.capDiscover).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Find cashier' }));
    const candidate = await screen.findByRole('button', { name: 'Select MAT ECR · 192.168.1.169' });
    expect(select).not.toHaveBeenCalled();
    expect(screen.getByText('Discovery checks the local network only. Selecting an IP does not connect or verify the cashier, or change the CAP Driver service configuration.')).toBeInTheDocument();
    fireEvent.click(candidate);
    expect(select).toHaveBeenCalledWith('192.168.1.169');
  });
  it('discards delayed results after scope change and prevents duplicate in-flight requests', async () => {
    let finish!: (value: unknown) => void;
    mocks.capDiscover.mockReturnValue(new Promise(resolve => { finish = resolve; }));
    const select = vi.fn();
    const view = render(<MyDataCashierDiscovery scopeKey="a" onSelect={select} disabled={false} />);
    const find = screen.getByRole('button', { name: 'Find cashier' });
    fireEvent.click(find); fireEvent.click(find);
    expect(mocks.capDiscover).toHaveBeenCalledTimes(1);
    view.rerender(<MyDataCashierDiscovery scopeKey="b" onSelect={select} disabled={false} />);
    await act(async () => finish(found));
    expect(screen.queryByRole('button', { name: /Select MAT ECR/ })).not.toBeInTheDocument();
    expect(select).not.toHaveBeenCalled();
  });
  it('shows no-results and recoverable errors without changing the manual target', async () => {
    mocks.capDiscover.mockRejectedValueOnce(new Error('timeout')).mockResolvedValue({ success: true, candidates: [] });
    const select = vi.fn();
    render(<MyDataCashierDiscovery scopeKey="a" onSelect={select} disabled={false} />);
    fireEvent.click(screen.getByRole('button', { name: 'Find cashier' }));
    await screen.findByRole('alert');
    fireEvent.click(screen.getByRole('button', { name: 'Find cashier' }));
    await screen.findByText('No RBS/MAT cashier found. Check its network connection or enter the IP manually.');
    expect(select).not.toHaveBeenCalled();
  });
  it('does not show malformed or unqualified network discoveries', async () => {
    mocks.capDiscover.mockResolvedValue({ success: true, candidates: [
      { ...found.candidates[0], verification: 'connected' }, { ...found.candidates[0], host: 'bad-host' },
      { ...found.candidates[0], detectedFamily: 'unknown' },
    ] });
    render(<MyDataCashierDiscovery scopeKey="a" onSelect={vi.fn()} disabled={false} />);
    fireEvent.click(screen.getByRole('button', { name: 'Find cashier' }));
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('No RBS/MAT cashier found'));
  });
});
