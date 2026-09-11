import { beforeEach, expect, it, vi } from 'vitest';
const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke }));
import { CHANNEL_MAP, TauriBridge } from '../ipc-adapter';

beforeEach(() => { invoke.mockReset(); });

it('discovers only through the argument-free native command and preserves network-only status', async () => {
  const response = { success: true, candidates: [{ host: '192.168.1.169', detectedFamily: 'rbs_mat', label: 'MAT ECR', verification: 'network_only' }] };
  invoke.mockResolvedValue(response);
  expect(await new TauriBridge().ecr.capDiscover()).toEqual(response);
  expect(invoke).toHaveBeenCalledWith('ecr_cap_discover', undefined);
  expect(CHANNEL_MAP['ecr:cap-discover']).toBe('ecr.capDiscover');
});

it('keeps a failed scan failed instead of inventing candidates or connection status', async () => {
  invoke.mockRejectedValue(new Error('scan failed'));
  await expect(new TauriBridge().ecr.capDiscover()).rejects.toThrow('scan failed');
});
