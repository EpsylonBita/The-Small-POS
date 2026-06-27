import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  isViewAccessDenied,
  resolveViewModuleId,
} from '../../src/renderer/utils/module-view-access';

const layoutSource = readFileSync(
  path.join(process.cwd(), 'src', 'renderer', 'components', 'RefactoredMainLayout.tsx'),
  'utf8',
);

test('Services sidebar id resolves to the service catalog view', () => {
  assert.match(layoutSource, /services:\s*ServiceCatalogView,/);
  assert.match(layoutSource, /service_catalog:\s*ServiceCatalogView,/);
  assert.match(layoutSource, /housekeeping:\s*HousekeepingView,/);
});

test('service catalog access uses the real services module id', () => {
  const serviceCatalogOrg = [{ module: { id: 'service_catalog' } }];
  const servicesOrg = [{ module: { id: 'services' } }];
  const housekeepingOrg = [{ module: { id: 'housekeeping' } }];

  assert.equal(resolveViewModuleId('services'), 'service_catalog');
  assert.equal(resolveViewModuleId('service_catalog'), 'service_catalog');

  assert.equal(isViewAccessDenied(serviceCatalogOrg, 'services'), false);
  assert.equal(isViewAccessDenied(serviceCatalogOrg, 'service_catalog'), false);
  assert.equal(isViewAccessDenied(servicesOrg, 'services'), false);
  assert.equal(isViewAccessDenied(servicesOrg, 'service_catalog'), false);
  assert.equal(isViewAccessDenied(housekeepingOrg, 'services'), true);
});
