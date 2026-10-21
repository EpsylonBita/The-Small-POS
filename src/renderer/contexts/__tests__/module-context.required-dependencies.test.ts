import { describe, expect, it } from 'vitest';
import type { EnabledModule } from '../../../shared/types/modules';
import { getModuleAccessStatic, hasRequiredModuleDependencies } from '../module-context';

const mod = (id: string): EnabledModule =>
  ({ module: { id, name: id, showInNavigation: true }, isEnabled: true }) as unknown as EnabledModule;

describe('module-context required dependency closure (Android parity)', () => {
  it('blocks guest_billing and housekeeping without rooms', () => {
    const enabled = [mod('dashboard'), mod('guest_billing'), mod('housekeeping')];
    expect(hasRequiredModuleDependencies(enabled, 'guest_billing')).toBe(false);
    expect(hasRequiredModuleDependencies(enabled, 'housekeeping')).toBe(false);
    expect(getModuleAccessStatic(enabled, [], 'guest_billing').isEnabled).toBe(false);
  });

  it('allows them once rooms is enabled', () => {
    const enabled = [mod('rooms'), mod('guest_billing'), mod('housekeeping')];
    expect(hasRequiredModuleDependencies(enabled, 'guest_billing')).toBe(true);
    expect(hasRequiredModuleDependencies(enabled, 'housekeeping')).toBe(true);
    expect(getModuleAccessStatic(enabled, [], 'housekeeping').isEnabled).toBe(true);
  });

  it('never blocks on recommended dependencies', () => {
    // reservations only recommends tables/rooms
    expect(hasRequiredModuleDependencies([mod('reservations')], 'reservations')).toBe(true);
    // modules without declared dependencies are unaffected
    expect(hasRequiredModuleDependencies([mod('retail')], 'retail')).toBe(true);
  });
});
