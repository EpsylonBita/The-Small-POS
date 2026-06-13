import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

const projectRoot = process.cwd();
const usersPagePath = path.join(projectRoot, 'src', 'renderer', 'pages', 'UsersPage.tsx');
const localesDir = path.join(projectRoot, 'src', 'locales');

function flattenKeys(value: unknown, prefix = '', out = new Set<string>()) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const [key, nested] of Object.entries(value)) {
      flattenKeys(nested, prefix ? `${prefix}.${key}` : key, out);
    }
    return out;
  }

  out.add(prefix);
  return out;
}

test('users page loads the POS customer directory without app-user type filtering', () => {
  const source = readFileSync(usersPagePath, 'utf8');

  assert.match(source, /pos\/customers\?page=\$\{page\}&limit=\$\{pageSize\}/);
  assert.match(source, /bridge\.customers\.search\(''\)/);
  assert.match(source, /native-customer-sync/);
  assert.match(source, /sort\(\(left, right\) => right\.users\.length - left\.users\.length\)/);
  assert.match(source, /<Filter/);
  assert.match(source, /users\.platformFilter/);
  assert.doesNotMatch(source, /typeFilter/);
  assert.doesNotMatch(source, /setTypeFilter/);
  assert.doesNotMatch(source, /filters\.all/);
});

test('users page search and filter controls use neutral grey chrome', () => {
  const source = readFileSync(usersPagePath, 'utf8');

  assert.match(source, /resolvedTheme === 'dark' \? 'bg-zinc-900\/70' : 'bg-gray-100'/);
  assert.match(source, /bg-zinc-800 text-white border-zinc-600 focus:ring-white\/40 focus:border-white\/70/);
  assert.match(source, /bg-white text-gray-900 border-gray-300 focus:ring-gray-400 focus:border-gray-500/);
  assert.match(source, /className=\{`absolute right-3 top-1\/2 h-5 w-5 -translate-y-1\/2/);
  assert.doesNotMatch(source, /bg-gray-800\/50' : 'bg-white'[\s\S]*focus:ring-blue-500 focus:border-blue-500/);
  assert.doesNotMatch(source, /<select/);
});

test('users table uses yellow header neutral rows and wrapperless chips', () => {
  const source = readFileSync(usersPagePath, 'utf8');

  assert.match(source, /<thead className="bg-yellow-400">/);
  assert.match(source, /text-xs font-semibold uppercase tracking-wider text-black/);
  assert.match(source, /resolvedTheme === 'dark' \? 'bg-zinc-950' : 'bg-gray-100'/);
  assert.match(source, /resolvedTheme === 'dark' \? 'hover:bg-zinc-900' : 'hover:bg-gray-200'/);
  assert.match(source, /let color = 'text-orange-700 dark:text-orange-500'/);
  assert.match(source, /color = 'text-yellow-500 dark:text-yellow-400'/);
  assert.match(source, /<Mail className="w-4 h-4 mr-2 text-yellow-500" \/>/);
  assert.match(source, /<Phone className="w-4 h-4 mr-2 text-yellow-500" \/>/);
  assert.match(source, /<ShoppingBag className="w-4 h-4 mr-2 text-green-500" \/>/);
  assert.match(source, /inline-flex items-center text-xs font-medium text-green-500 dark:text-green-400/);
  assert.match(source, /inline-flex items-center text-xs font-medium text-red-500 dark:text-red-400/);
  assert.match(source, /inline-flex items-center text-xs font-medium \$\{color\}/);
  assert.doesNotMatch(source, /bg-yellow-100 text-yellow-800 dark:bg-yellow-900\/20/);
  assert.doesNotMatch(source, /bg-green-100 text-green-800 dark:bg-green-900\/20/);
  assert.doesNotMatch(source, /text-blue-600 dark:text-blue-400 hover:text-blue-900/);
});

test('users table paginates the rendered rows', () => {
  const source = readFileSync(usersPagePath, 'utf8');

  assert.match(source, /const USERS_PAGE_SIZE = 10;/);
  assert.match(source, /const \[currentPage, setCurrentPage\] = useState\(1\)/);
  assert.match(source, /const filteredUsers = useMemo/);
  assert.match(source, /const paginatedUsers = useMemo/);
  assert.match(source, /filteredUsers\.slice\(start, start \+ USERS_PAGE_SIZE\)/);
  assert.match(source, /\{paginatedUsers\.map\(\(user\) => \(/);
  assert.match(source, /setCurrentPage\(page => Math\.max\(1, page - 1\)\)/);
  assert.match(source, /setCurrentPage\(page => Math\.min\(totalPages, page \+ 1\)\)/);
  assert.doesNotMatch(source, /\{filteredUsers\.map\(\(user\) => \(/);
});

test('users page translations exist in every POS locale', () => {
  const requiredUsersKeys = [
    'title',
    'description',
    'searchPlaceholder',
    'filterAll',
    'filterCustomers',
    'filterAppUsers',
    'customer',
    'contact',
    'activity',
    'loyalty',
    'status',
    'actions',
    'orders',
    'points',
    'active',
    'banned',
  ];

  const localeFiles = readdirSync(localesDir)
    .filter(file => file.endsWith('.json'))
    .sort();

  for (const file of localeFiles) {
    const locale = JSON.parse(readFileSync(path.join(localesDir, file), 'utf8'));
    const usersKeys = flattenKeys(locale.users);
    const missing = requiredUsersKeys
      .filter(key => !usersKeys.has(key))
      .map(key => `users.${key}`);

    assert.deepEqual(missing, [], `${file} is missing users page translations`);
  }
});
