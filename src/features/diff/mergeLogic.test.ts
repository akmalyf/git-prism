// Unit tests for mergeLogic.ts (node --test).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { conflictType, discardConfirmation, mergeMsgRef, mergeTitles, parseUnmerged, pickBranch, sideStages, unprocessedMessage } from './mergeLogic';

test('parseUnmerged reads ls-files -u -z', () => {
  const out = '100644 587be6b 1\tdel.txt\0' + '100644 975fbec 2\tdel.txt\0';
  const s = parseUnmerged(out);
  assert.deepEqual(Object.keys(s), ['1', '2']);
  assert.equal(s[2]!.hash, '975fbec');
  const glob = '100644 aaa 1\ta.txt\0' + '100644 bbb 2\t[a].txt\0';
  assert.deepEqual(Object.keys(parseUnmerged(glob, '[a].txt')), ['2']);
  assert.equal(parseUnmerged('100644 ccc 3\tdir/ü ñ.txt\0', 'dir/ü ñ.txt')[3]!.hash, 'ccc');
});

test('conflict types, reversed during rebase', () => {
  assert.equal(conflictType({ 1: 1, 2: 1, 3: 1 }, false), 'both modified');
  assert.equal(conflictType({ 2: 1, 3: 1 }, false), 'both added');
  assert.equal(conflictType({ 1: 1, 2: 1 }, false), 'deleted by them');
  assert.equal(conflictType({ 1: 1, 2: 1 }, true), 'deleted by you');
  assert.equal(conflictType({ 3: 1 }, false), 'added by them');
  assert.equal(conflictType({ 1: 1 }, false), 'both deleted');
  assert.deepEqual(sideStages(true), { left: 3, right: 2 });
});

test('merge window titles', () => {
  assert.deepEqual(mergeTitles({ operation: 'merge', currentBranch: 'main', otherBranch: 'feat', otherHash: 'abc' }), { left: 'Changes from main', right: 'Changes from feat' });
  assert.deepEqual(mergeTitles({ operation: 'rebase', currentBranch: 'feat', otherBranch: 'main', otherHash: 'f125a386', rebaseHead: 'eb5fd33991eb804287d0' }), {
    left: 'Rebasing eb5fd339 from feat',
    right: 'Already rebased commits and commits from main',
  });
  assert.equal(mergeTitles({ operation: 'rebase', rebaseHead: 'abcdef0123', otherHash: 'f125a386' }).right, 'Already rebased commits');
  assert.deepEqual(mergeTitles({ operation: 'rebase', rebaseHead: 'abcdef0123' }), { left: 'Your version', right: 'Changes from server' });
  assert.deepEqual(mergeTitles({ operation: 'merge', currentBranch: 'a1b2c3d4', otherHash: '0123456789abcdef' }), { left: 'Changes from a1b2c3d4', right: 'Changes from 01234567' });
  assert.deepEqual(mergeTitles({ operation: 'revert', otherHash: '0123' }), { left: 'Your version', right: 'Changes from server' });
  assert.deepEqual(mergeTitles({ operation: 'cherry-pick', otherHash: '0123456789abc' }), { left: 'Local Changes', right: 'Changes from cherry-pick 01234567' });
});

test('unprocessed message (IntelliJ choice format)', () => {
  assert.equal(unprocessedMessage(0, 1), 'There is one conflict left unprocessed.');
  assert.equal(unprocessedMessage(0, 3), 'There are 3 conflicts left unprocessed.');
  assert.equal(unprocessedMessage(1, 0), 'There is one change left unprocessed.');
  assert.equal(unprocessedMessage(1, 2), 'There is one change and 2 conflicts left unprocessed.');
  assert.equal(unprocessedMessage(4, 1), 'There are 4 changes and one conflict left unprocessed.');
});

test('branch name resolution', () => {
  assert.equal(mergeMsgRef("Merge branch 'feat' into main\n"), 'feat');
  assert.equal(pickBranch(['a'], ['origin/a']), 'a');
  assert.equal(pickBranch([], ['origin/x']), 'origin/x');
  assert.equal(pickBranch(['a', 'b'], [], 'b'), 'b');
  assert.equal(pickBranch(['a', 'b'], []), undefined);
});

test('discard confirmation texts', () => {
  assert.deepEqual(discardConfirmation('Cancel Merge'), {
    title: 'Cancel Merge',
    message: 'There are unsaved changes in the result file. Discard changes and cancel merge anyway?',
    yes: 'Discard Changes and Cancel Merge',
    no: 'Continue Merge',
  });
});
