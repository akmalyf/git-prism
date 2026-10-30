// Unit tests for conflict parsing, IntelliJ's Yours/Theirs mapping, accept plans, descriptions and operation actions.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  abortConfirmation,
  acceptPlan,
  cleanMergeMessage,
  columnTitles,
  conflictType,
  describe,
  headNameBranch,
  isEmptyPickError,
  isUnstagedChangesError,
  mergedRefName,
  messagePreview,
  opActions,
  parseUnmerged,
  pickBranchName,
  rebaseStopKind,
  toConflictFile,
  widgetText,
  type RepoOpInfo,
} from './logic';

// git ls-files -u -z output of a merge with UD, DU, UU and AA conflicts (verified in a scratch repo)
const LS = [
  '100644 587be6b4c3f93f93c489c0111bba5596147a26cb 1\tdel.txt',
  '100644 ccc9bd67dc5c467859102d53d54c5ce851273bdd 2\tdel.txt',
  '100644 975fbec8256d3e8a3797e7a3611380f27c49f4ac 1\tdel2.txt',
  '100644 b68025345d5301abad4d9ec9166f455243a0d746 3\tdel2.txt',
  '100644 de980441c3ab03a8c07dda1ad27b8a11f39deb1e 1\tsrc/f.txt',
  '100644 af703352c64a2d88d4f62818fa68e6ae91241dfd 2\tsrc/f.txt',
  '100644 ac05874137310ed3906be49fe8111cec634c4ced 3\tsrc/f.txt',
  '100644 819d99378ee35c11439a0bf5c22b623a9928d2dd 2\tnew file.txt',
  '100644 3eac62ec484a0c75051647a9b46e74cc30e292bc 3\tnew file.txt',
].join('\0') + '\0';

test('parseUnmerged groups stages per path', () => {
  const e = parseUnmerged(LS);
  assert.deepEqual(e.map((x) => x.path), ['del.txt', 'del2.txt', 'src/f.txt', 'new file.txt']);
  assert.deepEqual([...e[2].stages].sort(), [1, 2, 3]);
  assert.deepEqual(parseUnmerged(''), []);
});

test('conflict types from the user point of view', () => {
  const [ud, du, uu, aa] = parseUnmerged(LS);
  assert.equal(conflictType(ud, false), 'deleted by them');
  assert.equal(conflictType(du, false), 'deleted by you');
  assert.equal(conflictType(uu, false), 'both modified');
  assert.equal(conflictType(aa, false), 'both added');
  assert.equal(conflictType(ud, true), 'deleted by you');
  assert.equal(conflictType({ path: 'x', stages: new Set([1]) }, false), 'both deleted');
  assert.equal(conflictType({ path: 'x', stages: new Set([2]) }, false), 'added by you');
});

test('Yours/Theirs columns: merge as is, rebase swapped', () => {
  const [ud] = parseUnmerged(LS);
  assert.deepEqual(toConflictFile('/r', ud, false), { repoRoot: '/r', path: 'del.txt', yours: 'Modified', theirs: 'Deleted', type: 'deleted by them' });
  const rev = toConflictFile('/r', ud, true);
  assert.equal(rev.yours, 'Deleted');
  assert.equal(rev.theirs, 'Modified');
});

test('accept plans checkout the side or remove deleted files', () => {
  const e = parseUnmerged(LS);
  assert.deepEqual(acceptPlan(e, 'yours', false), { side: 'ours', checkout: ['del.txt', 'src/f.txt', 'new file.txt'], remove: ['del2.txt'] });
  assert.deepEqual(acceptPlan(e, 'theirs', false), { side: 'theirs', checkout: ['del2.txt', 'src/f.txt', 'new file.txt'], remove: ['del.txt'] });
  // while rebasing "Yours" is git's --theirs (the commit being replayed)
  assert.equal(acceptPlan(e, 'yours', true).side, 'theirs');
  assert.equal(acceptPlan(e, 'theirs', true).side, 'ours');
});

const merge: RepoOpInfo = { name: 'p', op: 'merge', current: 'main', mergeBranch: 'feature' };
const rebase: RepoOpInfo = {
  name: 'p',
  op: 'rebase',
  current: 'feature',
  rebasingBranch: 'feature',
  ontoHash: '88e171643003a6c43a0bbaa9e9b30c926f629be2',
  ontoBranch: 'main',
  rebaseHead: { hash: '85e6a31b988f9b91c446bc0b0c271814f47db74a', author: 'Akmal', message: 'feat change\n\nbody' },
};

test('descriptions follow GitDefaultMergeDialogCustomizer', () => {
  const s = (r: RepoOpInfo[], n = 2) => describe(r, n).parts.map((p) => p.text).join('');
  assert.equal(s([merge]), 'Merging branch feature into branch main');
  assert.equal(s([merge, { ...merge, mergeBranch: 'other' }]), 'Merging diverging branches into branch main');
  assert.equal(s([rebase]), 'Rebasing branch feature onto branch main, revision 88e17164. Current commit 85e6a31b made by Akmal:');
  assert.equal(describe([rebase], 1).message, 'feat change\n\nbody');
  assert.equal(s([{ ...rebase, ontoBranch: undefined, rebaseHead: undefined }]), 'Rebasing branch feature onto 88e17164');
  const pick: RepoOpInfo = { name: 'p', op: 'cherry-pick', current: 'main', cherryPick: { hash: 'abcdef1234567', author: 'W', message: 'fix' } };
  assert.equal(s([pick]), 'Conflicts during cherry-picking commit abcdef12 made by W');
  assert.equal(s([{ name: 'p', op: 'none' }], 1), 'The following file has conflicts:');
  assert.equal(s([{ name: 'p', op: 'revert' }], 3), 'The following files have conflicts:');
  assert.ok(describe([merge], 1).parts.some((p) => p.bold && p.text === 'feature'));
});

test('column titles carry the branch when unique', () => {
  assert.deepEqual(columnTitles([merge]), { yours: 'Yours (main)', theirs: 'Theirs (feature)' });
  assert.deepEqual(columnTitles([rebase]), { yours: 'Yours (feature)', theirs: 'Theirs (main)' });
  assert.deepEqual(columnTitles([merge, { ...merge, current: 'dev' }]), { yours: 'Yours', theirs: 'Theirs (feature)' });
  assert.deepEqual(columnTitles([{ name: 'p', op: 'none', current: 'main' }]), { yours: 'Yours (main)', theirs: 'Theirs' });
});

test('message preview keeps 3 lines', () => {
  assert.equal(messagePreview('a\nb\nc\n'), 'a\nb\nc');
  assert.equal(messagePreview('a\n\n\nd\ne'), 'a...');
  assert.equal(messagePreview('a\nb\nc\nd'), 'a\nb\nc...');
});

test('widget texts and actions', () => {
  assert.equal(widgetText('rebase', 'main'), 'Rebasing main');
  assert.equal(widgetText('merge', 'feature'), 'Merging feature');
  assert.equal(widgetText('cherry-pick', 'main'), 'Cherry-picking in main');
  assert.equal(widgetText('revert', undefined), 'Reverting in <unknown>');
  assert.equal(widgetText('none', 'main'), undefined);
  assert.deepEqual(opActions('rebase', false), ['rebaseContinue', 'rebaseSkip', 'rebaseAbort']);
  assert.deepEqual(opActions('rebase', true), ['resolve', 'rebaseContinue', 'rebaseSkip', 'rebaseAbort']);
  assert.deepEqual(opActions('merge', true), ['resolve', 'mergeAbort']);
  assert.deepEqual(opActions('merge', false), ['mergeCommit', 'mergeAbort']);
  assert.deepEqual(opActions('cherry-pick', false), ['cherryPickContinue', 'cherryPickAbort']);
  assert.deepEqual(opActions('revert', true), ['resolve', 'revertAbort']);
  assert.deepEqual(opActions('none', true), ['resolve']);
});

test('MERGE_MSG helpers', () => {
  assert.equal(cleanMergeMessage("Merge branch 'side'\n\n# Conflicts:\n#\tf.txt\n"), "Merge branch 'side'");
  assert.equal(cleanMergeMessage('Merge x\n; c\n', ';'), 'Merge x');
  assert.equal(mergedRefName("Merge branch 'main' into feature"), 'main');
  assert.equal(mergedRefName("Merge remote-tracking branch 'origin/dev'"), 'origin/dev');
  assert.equal(mergedRefName(undefined), undefined);
});

test('rebase head-name and branch picking', () => {
  assert.equal(headNameBranch('refs/heads/feature/x\n'), 'feature/x');
  assert.equal(headNameBranch('detached HEAD'), undefined);
  assert.equal(pickBranchName(['main'], []), 'main');
  assert.equal(pickBranchName([], ['origin/main']), 'origin/main');
  assert.equal(pickBranchName(['a', 'b'], [], 'b'), 'b');
  assert.equal(pickBranchName(['a', 'b'], [], 'c'), undefined);
});

test('stop / error classification', () => {
  assert.equal(rebaseStopKind(true, false, ''), 'conflicts');
  assert.equal(rebaseStopKind(false, true, ''), 'edit');
  assert.equal(rebaseStopKind(false, false, 'warning: execution failed: make test'), 'exec');
  assert.equal(rebaseStopKind(false, false, 'Stopped at 85e6a31... feat'), 'edit');
  assert.ok(isUnstagedChangesError('You must edit all merge conflicts and then\nmark them as resolved using git add'));
  assert.ok(isEmptyPickError('The previous cherry-pick is now empty, possibly due to conflict resolution.'));
  assert.ok(!isEmptyPickError('error: could not apply'));
});

test('abort confirmations follow GitRebaseAbort / GitAbortOperationAction', () => {
  assert.deepEqual(abortConfirmation('rebase', 'web', ''), { title: 'Abort Rebase', message: 'Abort rebase in web?' });
  assert.deepEqual(abortConfirmation('cherry-pick', 'web', ''), { title: 'Abort Cherry-pick', message: 'Abort cherry-pick?' });
  assert.deepEqual(abortConfirmation('merge', 'web', ' in web'), { title: 'Abort Merge', message: 'Abort merge in web?' });
  assert.deepEqual(abortConfirmation('revert', 'web', ''), { title: 'Abort Revert', message: 'Abort revert?' });
});
