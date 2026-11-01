import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { DELIVERY_NAV_ICON, moduleNavIconName } from '../../../shared/pos/module-nav-icon.ts';

// Founder 31/10 («Ναι, παντού»): wherever the till shows delivery, a delivery driver or pickup, it draws
// his two glyphs (icons/OrderTypeGlyphs): the scooter rider and the hand holding the bag. Status icon
// sets, supplier deliveries, platform placeholders and the bags that mean "orders/products" keep theirs.
const read = (rel: string) => readFileSync(path.join(process.cwd(), 'src', 'renderer', rel), 'utf8');

const SPOTS: Array<[string, RegExp[]]> = [
  ['components/CustomerInfoForm.tsx', [/<PickupHandBagIcon className="h-7 w-7" \/>/, /<DeliveryScooterIcon className="h-7 w-7" \/>/]],
  ['components/forms/OrderTypeSelector.tsx', [/<PickupHandBagIcon className="h-7 w-7" \/>/, /<DeliveryScooterIcon className="h-7 w-7" \/>/]],
  ['pages/NewOrderPage.tsx', [/<PickupHandBagIcon\s+className=\{`w-12 h-12/, /<DeliveryScooterIcon\s+className=\{`w-12 h-12/]],
  ['components/modals/CustomerOrderHistoryModal.tsx', [/case 'delivery': return <DeliveryScooterIcon/, /case 'pickup': return <PickupHandBagIcon/]],
  ['components/modals/OrderDetailsModal.tsx', [/isDeliveryOrder \? <DeliveryScooterIcon className="h-7 w-7" \/> : isPickupOrder \? <PickupHandBagIcon/, /<DeliveryScooterIcon className="h-5 w-5" \/>/]],
  ['components/pricing/SimplePricingModal.tsx', [/<PickupHandBagIcon className="h-5 w-5/, /<DeliveryScooterIcon className="h-5 w-5/]],
  ['components/modals/EditOptionsModal.tsx', [/<DeliveryScooterIcon className="h-7 w-7 shrink-0 text-sky-700 dark:text-sky-300" \/>/]],
  ['pages/DeliveryPage.tsx', [/<DeliveryScooterIcon className=\{`h-5 w-5/, /<DeliveryScooterIcon className=\{`w-16 h-16 mb-4/]],
  ['pages/OrdersPage.tsx', [/<DeliveryScooterIcon className="h-5 w-5" \/>/]],
  ['components/tables/TablesDashboard.tsx', [/<DeliveryScooterIcon className="h-5 w-5" \/>/]],
  ['components/modals/RefundAttributionFields.tsx', [/<DeliveryScooterIcon className="h-5 w-5" \/>/]],
  ['pages/DeliveryZonesPage.tsx', [/<DeliveryScooterIcon className="h-6 w-6 text-emerald-500" \/>/]],
  ['components/order/OrderCard.tsx', [/<DeliveryScooterIcon className="h-5 w-5" \/>/]],
];

// The navigation rail picks module icons by name, and "Truck" is also the Suppliers module's icon (Delivery
// Pro brings MapPin): a by-name swap drew a scooter on Suppliers. Founder 31/10 («Ναι, βάλτο»): the delivery
// modules get the scooter by module, through shared/pos/module-nav-icon; Suppliers keeps the truck.
test('the navigation rail draws the scooter for the delivery modules, chosen by module', () => {
  const rail = read('components/NavigationSidebar.tsx');
  assert.match(rail, /case 'Truck':\s*return <Truck className=\{iconClass\} strokeWidth=\{2\} \/>;/);
  assert.match(rail, /case DELIVERY_NAV_ICON:\s*\/\/[^\n]*\n\s*return <DeliveryScooterIcon className="h-6 w-6" \/>;/);
  assert.equal((rail.match(/getModuleIcon\(moduleNavIconName\(module\.id, module\.icon\)\)/g) ?? []).length, 2);
  assert.doesNotMatch(rail, /getModuleIcon\(module\.icon/);

  assert.equal(moduleNavIconName('delivery_zones', 'MapPin'), DELIVERY_NAV_ICON);
  assert.equal(moduleNavIconName('delivery', 'Truck'), DELIVERY_NAV_ICON);
  assert.equal(moduleNavIconName('suppliers', 'Truck'), 'Truck');
  assert.equal(moduleNavIconName('loyalty', null), 'Package');
});

test('every delivery, driver and pickup spot draws the founder glyphs', () => {
  for (const [rel, patterns] of SPOTS) {
    const source = read(rel);
    assert.match(source, /from '[./]+(?:components\/)?icons\/OrderTypeGlyphs'|from "[./]+icons\/OrderTypeGlyphs"/, `${rel} imports the glyphs`);
    for (const pattern of patterns) assert.match(source, pattern, `${rel}: ${pattern}`);
    // The lucide truck and bag are gone from these spots (status maps and the "products" bag aside).
    assert.doesNotMatch(source, /<Truck className="(?:w-3 h-3|w-3\.5 h-3\.5|w-4 h-4|w-6 h-6|h-4 w-4)"/, `${rel} has no small lucide truck`);
  }
  // The lucide bag wrapper is gone: nothing draws the old pickup bag any more.
  assert.equal(existsSync(path.join(process.cwd(), 'src', 'renderer', 'components', 'icons', 'PickupOrderIcon.tsx')), false);
});
