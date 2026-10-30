// Unit tests for logic.ts (node --test).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { appendIgnoreLines, commonIgnoreDirs, escapeIgnore, ignoreEntry, rollbackPlan } from './logic';
import type { Item } from './protocol';

const item = (p: Partial<Item> & { path: string }): Item => ({ key: p.path, repo: '/r', kind: 'M', area: 'changes', ...p });

test('rollback plan', () => {
  const items = [
    item({ path: 'm' }),
    item({ path: 'd', kind: 'D' }),
    item({ path: 'n', kind: 'A' }),
    item({ path: 'to', oldPath: 'from', kind: 'R' }),
    item({ path: 'u', kind: '?', area: 'untracked' }),
    item({ path: 'w', area: 'unstaged' }),
  ];
  assert.deepEqual(rollbackPlan(items, { hasHead: true, deleteAdded: false }), {
    restore: ['m', 'd', 'from'], restoreWorktree: ['w'], unstageAdded: ['n', 'to'], remove: ['to'],
  });
  assert.deepEqual(rollbackPlan([item({ path: 'n', kind: 'A' })], { hasHead: true, deleteAdded: true }).remove, ['n']);
  assert.deepEqual(rollbackPlan([item({ path: 'x', kind: 'A' })], { hasHead: false, deleteAdded: false }), {
    restore: [], restoreWorktree: [], unstageAdded: ['x'], remove: [],
  });
});

test('ignore entries', () => {
  assert.equal(escapeIgnore('a*b?[c]'), 'a\\*b\\?\\[c\\]');
  assert.equal(ignoreEntry('#x'), '/\\#x');
  assert.equal(ignoreEntry('dir/', false), '/dir/');
  assert.equal(ignoreEntry('a/b.txt'), '/a/b.txt');
  assert.equal(ignoreEntry('t '), '/t\\ ');
  assert.equal(appendIgnoreLines('a', ['/b', '/b', 'a']), 'a\n/b\n');
  assert.equal(appendIgnoreLines('', ['/b']), '/b\n');
  assert.equal(appendIgnoreLines('x\r\n', ['/y']), 'x\r\n/y\r\n');
  assert.deepEqual(commonIgnoreDirs(['a/b/c.txt', 'a/b/d/e.txt']), ['', 'a', 'a/b']);
  assert.deepEqual(commonIgnoreDirs(['x.txt', 'a/y']), ['']);
});
