// Unit tests for logic.ts and changelists.ts (node --test).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ChangelistModel } from './changelists';
import {
  acceptSide,
  amendBangCommitArgs,
  amendBangMessage,
  appendIgnoreLines,
  changelistCommitArgs,
  commitPaths,
  commonIgnoreDirs,
  diffSides,
  stageDiffFile,
  escapeIgnore,
  filesCommittedText,
  ignoreEntry,
  isMissingSideError,
  partialCommitImpossible,
  pushHistory,
  rollbackPlan,
  stagingCommitArgs,
  validateCommit,
  validateStagedCommit,
} from './logic';
import type { Item } from './protocol';

const opts = { author: '', signOff: false, gpgSign: false, runHooks: true };
const item = (p: Partial<Item> & { path: string }): Item => ({ key: p.path, repo: '/r', kind: 'M', area: 'changes', ...p });

test('commit arguments', () => {
  assert.deepEqual(changelistCommitArgs('/m', { amend: false, options: opts, hasPaths: true, merge: false }), [
    'commit', '--only', '-F', '/m', '--pathspec-from-file=-', '--pathspec-file-nul',
  ]);
  assert.deepEqual(changelistCommitArgs('/m', { amend: true, options: { author: 'A <a@b>', signOff: true, gpgSign: true, runHooks: false }, hasPaths: false, merge: false }), [
    'commit', '--only', '--amend', '--author=A <a@b>', '--signoff', '--gpg-sign', '--no-verify', '-F', '/m',
  ]);
  assert.deepEqual(changelistCommitArgs('/m', { amend: false, options: opts, hasPaths: true, merge: true }), ['commit', '-F', '/m']);
  assert.deepEqual(stagingCommitArgs('/m', { amend: false, options: opts, all: true }), ['commit', '--all', '-F', '/m']);
});

test('commit paths include both sides of renames', () => {
  assert.deepEqual(commitPaths([item({ path: 'b', oldPath: 'a', kind: 'R' }), item({ path: 'c' }), item({ path: 'c' })]), ['b', 'a', 'c']);
});

test('validation texts', () => {
  assert.equal(validateCommit({ message: '', hasChanges: false, amend: false }), 'Select files to commit and specify commit message');
  assert.equal(validateCommit({ message: 'x', hasChanges: false, amend: false }), 'Select files to commit');
  assert.equal(validateCommit({ message: ' ', hasChanges: true, amend: false }), 'Specify commit message');
  assert.equal(validateCommit({ message: 'x', hasChanges: false, amend: true }), undefined);
});

test('texts and history', () => {
  assert.equal(filesCommittedText(1, 'Fix'), '1 file committed: Fix');
  assert.equal(filesCommittedText(3, 'Fix'), '3 files committed: Fix');
  assert.equal(amendBangMessage('Old', ' New\n\nbody \n'), 'amend! Old\n\nNew\n\nbody\n');
  assert.deepEqual(pushHistory(['b', 'a'], 'a'), ['a', 'b']);
  assert.deepEqual(pushHistory(['a'], '  '), ['a']);
  assert.equal(pushHistory(Array.from({ length: 40 }, (_, i) => `m${i}`), 'new').length, 30);
});

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

test('accept side of conflicts', () => {
  assert.equal(acceptSide('UU', 'theirs'), 'checkout');
  assert.equal(acceptSide('UD', 'theirs'), 'rm');
  assert.equal(acceptSide('UD', 'ours'), 'checkout');
  assert.equal(acceptSide('DU', 'ours'), 'rm');
  assert.equal(acceptSide('DD', 'theirs'), 'rm');
});

test('diff sides', () => {
  assert.deepEqual(diffSides(item({ path: 'a' }), true), { left: { rev: 'HEAD', path: 'a' }, right: { worktree: true, path: 'a' } });
  assert.deepEqual(diffSides(item({ path: 'a', kind: 'A' }), true).left, { empty: true });
  assert.deepEqual(diffSides(item({ path: 'a', kind: 'D' }), true).right, { empty: true });
  assert.deepEqual(diffSides(item({ path: 'b', oldPath: 'a', kind: 'R' }), true).left, { rev: 'HEAD', path: 'a' });
  assert.deepEqual(diffSides(item({ path: 'a' }), false).left, { empty: true });
  const st = diffSides(item({ path: 'a', area: 'staged' }), true);
  assert.deepEqual([st.left, st.right], [{ rev: 'HEAD', path: 'a' }, { index: true, path: 'a' }]);
  const un = diffSides(item({ path: 'a', area: 'unstaged' }), true);
  assert.deepEqual([un.left, un.right], [{ index: true, path: 'a' }, { worktree: true, path: 'a' }]);
  assert.deepEqual(diffSides(item({ path: 'a', kind: '?', area: 'untracked' }), true).left, { empty: true });
});

test('staging area compare actions', () => {
  const st = item({ path: 'b', oldPath: 'a', kind: 'R', area: 'staged' });
  const head = stageDiffFile(st, 'compareStagedHead', true);
  assert.deepEqual([head.left, head.right, head.leftTitle, head.rightTitle], [{ rev: 'HEAD', path: 'a' }, { index: true, path: 'b' }, 'HEAD', 'Staged']);
  assert.deepEqual(stageDiffFile(item({ path: 'a', kind: 'A', area: 'staged' }), 'compareStagedHead', true).left, { empty: true });
  assert.deepEqual(stageDiffFile(item({ path: 'a', area: 'staged' }), 'compareStagedHead', false).left, { empty: true });
  assert.deepEqual(stageDiffFile(item({ path: 'a', kind: 'D', area: 'staged' }), 'compareStagedHead', true).right, { empty: true });
  const local = stageDiffFile(st, 'compareStagedLocal', true);
  assert.deepEqual([local.left, local.right, local.oldPath, local.rightTitle], [{ index: true, path: 'b' }, { worktree: true, path: 'b' }, undefined, 'Local']);
  const un = stageDiffFile(item({ path: 'a', kind: 'D', area: 'unstaged' }), 'compareLocalStaged', true);
  assert.deepEqual([un.left, un.right], [{ index: true, path: 'a' }, { empty: true }]);
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

test('changelists: sync, inclusion, lists', () => {
  const m = new ChangelistModel();
  assert.equal(m.active.name, 'Changes');
  m.sync(['r\0a', 'r\0b'], ['r\0u']);
  assert.equal(m.listOf('r\0a'), m.active.id);
  assert.equal(m.isIncluded('r\0a', false), true);
  assert.equal(m.isIncluded('r\0u', true), false);
  m.setIncluded(['r\0a', 'r\0u'], false, (k) => k === 'r\0u');
  m.setIncluded(['r\0u'], true, () => true);
  assert.equal(m.isIncluded('r\0a', false), false);
  assert.equal(m.isIncluded('r\0u', true), true);

  const f = m.add('Feature', 'msg', true);
  assert.equal(m.active.id, f.id);
  assert.throws(() => m.add('Feature'), /already exists/);
  assert.throws(() => m.add(' '), /empty name/);
  m.sync(['r\0a', 'r\0b', 'r\0c'], []);
  assert.equal(m.listOf('r\0c'), f.id);
  assert.notEqual(m.listOf('r\0a'), f.id);
  assert.equal(m.isIncluded('r\0u', true), false, 'gone unversioned file forgets its state');
  m.move(['r\0a'], f.id);
  assert.equal(m.listOf('r\0a'), f.id);
  assert.deepEqual(m.sorted().map((l) => l.name), ['Feature', 'Changes']);

  m.remove([f.id]);
  assert.equal(m.lists.length, 1);
  assert.equal(m.active.name, 'Changes');
  assert.equal(m.listOf('r\0a'), m.active.id);

  assert.equal(m.isIncluded('r\0a', false), false);
  m.sync([], []);
  m.sync(['r\0a'], []);
  assert.equal(m.isIncluded('r\0a', false), true, 'excluded state of a no longer changed file is forgotten');

  const restored = new ChangelistModel(JSON.parse(JSON.stringify(m.toJSON())));
  assert.deepEqual(restored.toJSON(), m.toJSON());

  m.includeOnly(['r\0x'], ['r\0a', 'r\0x'], ['r\0u']);
  assert.equal(m.isIncluded('r\0a', false), false);
  assert.equal(m.isIncluded('r\0x', false), true);
  assert.equal(m.isIncluded('r\0u', true), false);
});

test('staging area validation texts', () => {
  assert.equal(validateStagedCommit({ message: '', hasStaged: false, amend: false }), 'Stage files to commit and specify commit message');
  assert.equal(validateStagedCommit({ message: 'x', hasStaged: false, amend: false }), 'Stage files to commit');
  assert.equal(validateStagedCommit({ message: '', hasStaged: true, amend: false }), 'Specify commit message');
  assert.equal(validateStagedCommit({ message: 'x', hasStaged: false, amend: true }), undefined);
});

test('partial commits are impossible only during merge / cherry-pick / revert', () => {
  assert.deepEqual(
    (['none', 'merge', 'rebase', 'cherry-pick', 'revert', 'bisect', 'am'] as const).filter(partialCommitImpossible),
    ['merge', 'cherry-pick', 'revert'],
  );
});

test('amend! commit arguments', () => {
  assert.deepEqual(amendBangCommitArgs('/m', { options: opts, hasPaths: true, index: false }), [
    'commit', '--allow-empty', '--only', '-F', '/m', '--pathspec-from-file=-', '--pathspec-file-nul',
  ]);
  assert.deepEqual(amendBangCommitArgs('/m', { options: { ...opts, signOff: true }, hasPaths: true, index: true }), ['commit', '--allow-empty', '--signoff', '-F', '/m']);
  assert.equal(isMissingSideError("error: path 'f' does not have their version"), true);
  assert.equal(isMissingSideError('fatal: something else'), false);
});
