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

test('users page loads the POS customer directory and uses page-local filter translation', () => {
  const source = readFileSync(usersPagePath, 'utf8');

  assert.match(source, /pos\/customers\?page=\$\{page\}&limit=\$\{pageSize\}/);
  assert.match(source, /bridge\.customers\.search\(''\)/);
  assert.match(source, /native-customer-sync/);
  assert.match(source, /sort\(\(left, right\) => right\.users\.length - left\.users\.length\)/);
  assert.match(source, /users\.filterAll/);
  assert.doesNotMatch(source, /filters\.all/);
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
