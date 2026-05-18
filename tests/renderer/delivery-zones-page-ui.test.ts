import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const projectRoot = process.cwd();
const deliveryZonesPagePath = path.join(projectRoot, 'src', 'renderer', 'pages', 'DeliveryZonesPage.tsx');

const source = () => readFileSync(deliveryZonesPagePath, 'utf8');

test('DeliveryZonesPage hides native scrollbars while preserving vertical scroll', () => {
  const page = source();

  assert.match(
    page,
    /h-full overflow-y-auto overflow-x-hidden scrollbar-hide p-4 md:p-5/,
    'delivery zones page should keep vertical scroll but hide the visible native scrollbar',
  );
  assert.doesNotMatch(
    page,
    /h-full overflow-auto p-4 md:p-5/,
    'delivery zones page should avoid generic overflow-auto because it exposes native scrollbars',
  );
});
