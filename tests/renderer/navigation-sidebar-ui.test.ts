import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const projectRoot = process.cwd();
const sidebarPath = path.join(projectRoot, 'src', 'renderer', 'components', 'NavigationSidebar.tsx');

function getLogoutBlock(source: string): string {
  const start = source.indexOf('{/* Logout Button */}');
  assert.notEqual(start, -1, 'logout button block should exist');

  const end = source.indexOf('</button>', start);
  assert.notEqual(end, -1, 'logout button should close');

  return source.slice(start, end);
}

test('navigation sidebar logout button uses transparent red outline without hover fill', () => {
  const source = readFileSync(sidebarPath, 'utf8');
  const logoutBlock = getLogoutBlock(source);

  assert.match(logoutBlock, /border border-red-500\/70 bg-transparent text-red-500/);
  assert.match(logoutBlock, /<LogOut className="w-5 h-5 text-red-500" strokeWidth=\{2\} \/>/);
  assert.doesNotMatch(logoutBlock, /hover:bg-red/);
  assert.doesNotMatch(logoutBlock, /hover:border-red/);
  assert.doesNotMatch(logoutBlock, /hover:text-red/);
  assert.doesNotMatch(logoutBlock, /hover:scale/);
});

test('navigation sidebar opens settings through the modal callback without shift gating', () => {
  const source = readFileSync(sidebarPath, 'utf8');

  assert.match(
    source,
    /if \(id === 'settings'\) \{\s*onOpenSettings && onOpenSettings\(\);\s*return;\s*\}/,
  );
});
