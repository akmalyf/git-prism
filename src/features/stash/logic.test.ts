// Unit tests for the stash / shelf pure helpers (node --test).
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { branchNameError, classifyApply, firstLine, mergeStashFiles, newShelfId, overwrittenPaths, patchFileName, uniqueName } from './logic';

test('classifies git stash apply / git apply output (real git 2.54 messages)', () => {
  assert.equal(classifyApply(0, '', ''), 'ok');
  assert.equal(classifyApply(1, 'Auto-merging f.txt\nCONFLICT (content): Merge conflict in f.txt\n', ''), 'conflict');
  assert.equal(classifyApply(1, '', 'error: patch failed: f.txt:1\nerror: conflicts in index. Try without --index.\n'), 'index-conflict');
  assert.equal(classifyApply(1, 'Already up to date.\n', 'untracked.txt already exists, no checkout\nerror: could not restore untracked files from stash\n'), 'untracked');
  const lc = 'error: Your local changes to the following files would be overwritten by merge:\n\tf.txt\n\tdir/g.txt\nPlease commit your changes or stash them before you merge.\nAborting\n';
  assert.equal(classifyApply(1, '', lc), 'local-changes');
  assert.deepEqual(overwrittenPaths(lc), ['f.txt', 'dir/g.txt']);
  assert.equal(classifyApply(1, '', 'error: f.txt: does not match index\n'), 'local-changes');
  assert.equal(classifyApply(1, '', 'Applied patch to \'f.txt\' with conflicts.\nU f.txt\n'), 'conflict');
  assert.equal(classifyApply(128, '', 'fatal: bad revision'), 'error');
});

test('merges the files of the stash commits', () => {
  const files = mergeStashFiles(
    [{ path: 'b.txt', kind: 'M' }, { path: 'a.txt', kind: 'D' }],
    [{ path: 'b.txt', kind: 'A' }, { path: 'c.txt', kind: 'M' }],
    [{ path: 'u.txt', kind: 'A' }],
  );
  assert.deepEqual(files, [
    { path: 'a.txt', kind: 'D', source: 'tracked' },
    { path: 'b.txt', kind: 'M', source: 'tracked' },
    { path: 'c.txt', kind: 'M', source: 'index' },
    { path: 'u.txt', kind: '?', source: 'untracked' },
  ]);
});

test('unique shelf names, ids, file names', () => {
  assert.equal(uniqueName('Changes', []), 'Changes');
  assert.equal(uniqueName('Changes', ['changes', 'Changes (2)']), 'Changes (3)');
  assert.equal(uniqueName('  ', []), 'Changes');
  assert.equal(newShelfId(new Date(2026, 9, 29, 11, 5, 9), () => 0), '20261029-110509-000000');
  assert.equal(firstLine('\n  Fix login  \nbody'), 'Fix login');
  assert.equal(patchFileName('Fix: a/b "c"'), 'Fix_a_b_c_.patch');
  assert.equal(patchFileName(''), 'Changes.patch');
});

test('validates branch names', () => {
  assert.equal(branchNameError(''), undefined);
  assert.equal(branchNameError('feature/x'), undefined);
  assert.ok(branchNameError('a b'));
  assert.ok(branchNameError('a..b'));
  assert.ok(branchNameError('x.lock'));
  assert.ok(branchNameError('-x'));
});
