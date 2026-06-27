import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const projectRoot = process.cwd();

const readPage = (file: string) =>
  readFileSync(path.join(projectRoot, 'src', 'renderer', 'pages', file), 'utf8');

const headerPages = [
  {
    file: 'CouponsPage.tsx',
    oldIcon: /<Ticket className=\{`w-6 h-6/,
    hasRefresh: true,
  },
  {
    file: 'LoyaltyPage.tsx',
    oldIcon: /<Award className=\{`w-6 h-6/,
    hasRefresh: true,
  },
  {
    file: 'AnalyticsPage.tsx',
    oldIcon: /<BarChart3 className="w-6 h-6 text-cyan-500"/,
    hasRefresh: true,
  },
  {
    file: 'IntegrationsPage.tsx',
    oldIcon: /<Plug size=\{24\}/,
    hasRefresh: true,
  },
  {
    file: 'KioskManagementPage.tsx',
    oldIcon: /<Monitor className=\{`w-6 h-6/,
    hasRefresh: true,
  },
  {
    file: 'DeliveryPage.tsx',
    oldIcon: /<Truck className=\{`w-6 h-6/,
    hasRefresh: true,
  },
  {
    file: 'TablesPage.tsx',
    oldIcon: /<Utensils className="w-6 h-6 text-blue-500"/,
    hasRefresh: true,
  },
  {
    file: 'PaymentTerminalsPage.tsx',
    oldIcon: /<CreditCard size=\{24\}/,
    hasRefresh: true,
  },
  {
    file: 'UsersPage.tsx',
    oldIcon: null,
    hasRefresh: true,
  },
  {
    file: 'AboutPage.tsx',
    oldIcon: /<Info\s/,
    hasRefresh: false,
  },
];

test('remaining top-level pages use the shared page header treatment', () => {
  for (const page of headerPages) {
    const source = readPage(page.file);

    assert.match(
      source,
      /truncate text-3xl font-bold tracking-tight/,
      `${page.file} should use the shared page title style`,
    );

    if (page.oldIcon) {
      assert.doesNotMatch(source, page.oldIcon, `${page.file} should not render the old leading icon wrapper`);
    }

    if (page.hasRefresh) {
      // Genuinely-shared invariant: every page's refresh exposes an accessible name (no native title
      // tooltip on this touch POS). The refresh button CHROME is intentionally NOT asserted here anymore:
      // pages have diverged in palette across rounds -- amber-glass on IntegrationsPage/LoyaltyPage/
      // UsersPage/PaymentTerminalsPage/CouponsPage/Kiosk, and a hover-less
      // inverted variant on Analytics/Delivery/Tables. The old hardcoded `bg-white text-black hover:...`
      // assertion was stale (failing for the migrated pages). Each page's specific refresh palette is now
      // guarded by its own focused test (e.g. integrations-page-ui.test.ts, payment-terminals-ui.test.ts).
      assert.match(source, /aria-label=\{t\('common\.refresh'/, `${page.file} refresh should be accessible`);
    }
  }
});

test('IntegrationsPage groups title actions and stats in a loyalty-style header card', () => {
  const source = readPage('IntegrationsPage.tsx');

  assert.match(source, /Header \+ Stats Card/);
  assert.match(source, /rounded-2xl border mb-5 px-4 py-4/);
  assert.match(source, /flex flex-wrap items-center justify-between gap-3 mb-4/);
  assert.match(source, /grid grid-cols-2 md:grid-cols-4 gap-3/);
  assert.doesNotMatch(source, /sticky top-0 z-10 px-4 py-4 border-b/);
});

test('IntegrationsPage uses neutral stat icon wrappers with colored status icons', () => {
  const source = readPage('IntegrationsPage.tsx');

  assert.match(source, /bg-zinc-800' : 'bg-gray-100'/);
  assert.doesNotMatch(source, /style=\{\{ backgroundColor: `\$\{color\}20` \}\}/);
  assert.match(source, /color="#facc15"/);
  assert.match(source, /color="#22c55e"/);
  assert.match(source, /color="#ef4444"/);
  assert.match(source, /color="#f59e0b"/);
});

test('IntegrationsPage renders plugin status chips without pill wrappers', () => {
  const source = readPage('IntegrationsPage.tsx');

  assert.match(source, /className="flex items-center gap-1\.5 text-xs font-medium"/);
  assert.doesNotMatch(source, /backgroundColor: `\$\{statusColor\}20`/);
  assert.doesNotMatch(source, /px-2 py-1 rounded-full text-xs font-medium/);
});

test('IntegrationsPage renders online status without a pill wrapper', () => {
  const source = readPage('IntegrationsPage.tsx');

  assert.match(source, /className=\{`flex items-center gap-2 \$\{/);
  assert.doesNotMatch(source, /bg-green-500\/20 text-green-400/);
  assert.doesNotMatch(source, /bg-green-100 text-green-600/);
  assert.doesNotMatch(source, /bg-red-500\/20 text-red-400/);
  assert.doesNotMatch(source, /bg-red-100 text-red-600/);
});

test('IntegrationsPage keeps the page mounted during background refreshes', () => {
  const source = readPage('IntegrationsPage.tsx');

  assert.match(source, /const \[hasLoadedIntegrations, setHasLoadedIntegrations\] = useState\(false\)/);
  assert.match(source, /const hasLoadedIntegrationsRef = useRef\(false\)/);
  assert.match(source, /const shouldShowLoading = !hasLoadedIntegrationsRef\.current/);
  assert.match(source, /const isInitialPageLoading = !hasLoadedIntegrations && \(loading \|\| modulesLoading\);/);
  assert.doesNotMatch(source, /if \(loading \|\| modulesLoading\)/);
});
