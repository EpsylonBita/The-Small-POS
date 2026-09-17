import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The efood rail icon is an ordinary module icon.
 *
 * It used to be rendered as its own button after the module map, which is why
 * it was the one icon in the rail staff could not drag: the drag session works
 * on entries of `navigationModules` — pointer handlers, button refs, drop slots
 * and the persisted order all key off `module.id`, and an icon outside that list
 * has none of them. It is now a synthetic entry in the same list, so it drags,
 * reorders and is remembered like every other icon.
 *
 * This is a source guard because the rail needs the module, shift, theme and
 * navigation contexts to render; what it pins is exactly what regressed before:
 * an efood button rendered outside the list.
 */
const SOURCE = fs.readFileSync(
  path.join(__dirname, '..', 'NavigationSidebar.tsx'),
  'utf8',
);

function navigationModulesMemo(): string {
  const start = SOURCE.indexOf('const navigationModules = useMemo(');
  expect(start).toBeGreaterThan(-1);
  const end = SOURCE.indexOf('// State for upgrade modal', start);
  expect(end).toBeGreaterThan(start);
  return SOURCE.slice(start, end);
}

describe('efood rail icon', () => {
  it('is built as an entry of the list the drag session works on', () => {
    const memo = navigationModulesMemo();
    expect(memo).toMatch(/const efoodEntry: NavigationModule/);
    expect(memo).toMatch(/id: EFOOD_PARTNER_VIEW/);
    expect(memo).toMatch(/return \[\.\.\.modules, efoodEntry\]/);
  });

  it('is not rendered as a button of its own any more', () => {
    // The removed button: data-testid="nav-efood-partner", rendered after the
    // map with no pointer handlers, no ref and no drop slot.
    expect(SOURCE).not.toMatch(/nav-efood-partner/);
    const afterMemo = SOURCE.slice(SOURCE.indexOf('// State for upgrade modal'));
    // Every remaining mention belongs to the icon/colour maps and the entry
    // itself, never to a second rendered button.
    for (const match of afterMemo.matchAll(/EFOOD_PARTNER_VIEW/g)) {
      const context = afterMemo.slice(Math.max(0, match.index! - 200), match.index!);
      expect(context).not.toMatch(/<button/);
    }
  });

  it('appears only where this register manages a purchased, enabled efood', () => {
    const memo = navigationModulesMemo();
    expect(memo).toMatch(/if \(!efoodPartnerAvailable\) return modules;/);
    // `available` is useEfoodPartner's: the plugin_integrations module plus the
    // server's `controllable` answer for efood on this terminal.
    expect(SOURCE).toMatch(/const \{ available: efoodPartnerAvailable \} = useEfoodPartner\(\)/);
  });

  it('carries the shop icon the rail knows how to draw', () => {
    const memo = navigationModulesMemo();
    expect(memo).toMatch(/icon: 'Store'/);
    // An icon with no case falls through to the Package placeholder and logs a
    // warning, which is what the rail did for efood before this case existed.
    expect(SOURCE).toMatch(/case 'Store':\s*\n\s*return <Store className=\{iconClass\}/);
  });
});
