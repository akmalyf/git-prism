// Unit tests for the pure branches helpers.
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import type { Ref } from '../../core/types';
import {
  checkBranchName,
  classifyRef,
  cleanupBranchName,
  cleanupCandidates,
  cloneDirName,
  checkRemoteName,
  isFavorite,
  parseOverwrittenFiles,
  parseRecentCheckouts,
  parseWorktrees,
  recentBranches,
  refFormatProblem,
  sortForGrouping,
  splitRemoteBranch,
  statusBarText,
  syncText,
  syncTooltip,
  toggleFavorite,
  unquotePath,
  worktreeDirName,
} from './logic';

test('refFormatProblem follows git check-ref-format', () => {
  for (const ok of ['main', 'feature/x', 'a.b', 'v1.0-rc', 'fix@home']) assert.equal(refFormatProblem(ok), undefined, ok);
  for (const bad of ['', '@', '-x', 'a/', 'a.', 'a..b', 'a@{1}', 'a//b', 'a b', 'a~1', 'a^', 'a:b', 'a?', 'a*', 'a[', 'a\\b', '.a', 'a/.b', 'x.lock', 'a/b.lock/c']) {
    assert.notEqual(refFormatProblem(bad), undefined, bad);
  }
});

test('cleanupBranchName produces valid names', () => {
  assert.equal(cleanupBranchName('my new  branch'), 'my_new_branch');
  assert.equal(cleanupBranchName('feat/..x'), 'feat/x');
  assert.equal(refFormatProblem(cleanupBranchName('-a b~c^d:e')), undefined);
});

test('checkBranchName uses IntelliJ messages', () => {
  const c = { locals: ['main', 'feature/a'], remotes: ['origin/main'] };
  assert.deepEqual(checkBranchName('', c), { error: 'Specify name for the new branch' });
  assert.deepEqual(checkBranchName('HEAD', c), { error: 'HEAD is a reserved keyword' });
  assert.deepEqual(checkBranchName('a b', c), { error: 'Branch name a b is not valid' });
  assert.deepEqual(checkBranchName('main', c), { exists: true });
  assert.deepEqual(checkBranchName('origin/main', c), { error: 'Branch name origin/main conflicts with remote branch with the same name' });
  assert.deepEqual(checkBranchName('feature', c), { error: 'Branch name feature conflicts with local branch directory with the same name' });
  assert.deepEqual(checkBranchName('main/x', c), { error: 'Branch name main/x conflicts with local branch directory with the same name' });
  assert.deepEqual(checkBranchName('dev', c), { ok: true });
  assert.deepEqual(checkBranchName('main', { ...c, current: 'main' }), { ok: true });
});

test('classifyRef prefers local, then remote, then tag', () => {
  const refs: Ref[] = [
    { name: 'refs/heads/main', short: 'main', type: 'head', hash: '1' },
    { name: 'refs/remotes/origin/main', short: 'origin/main', type: 'remote', hash: '2', remote: 'origin' },
    { name: 'refs/tags/v1', short: 'v1', type: 'tag', hash: '3' },
  ];
  assert.equal(classifyRef('main', refs).kind, 'local');
  assert.equal(classifyRef('origin/main', refs).kind, 'remote');
  assert.equal(classifyRef('refs/tags/v1', refs).kind, 'tag');
  assert.equal(classifyRef('v1', refs).name, 'v1');
  assert.deepEqual(classifyRef('abc123', refs), { kind: 'revision', name: 'abc123' });
});

test('splitRemoteBranch', () => {
  assert.deepEqual(splitRemoteBranch('origin/feature/x'), { remote: 'origin', branch: 'feature/x' });
  assert.deepEqual(splitRemoteBranch('my/fork/x', ['my/fork']), { remote: 'my/fork', branch: 'x' });
});

test('recent checkouts from the reflog', () => {
  const log = ['checkout: moving from dev to main', 'commit: x', 'checkout: moving from main to dev', 'checkout: moving from a1b2c3 to main'].join('\n');
  assert.deepEqual(parseRecentCheckouts(log), ['main', 'dev', 'a1b2c3']);
  assert.deepEqual(recentBranches(log, ['main', 'dev'], 'main'), ['dev']);
});

test('parseWorktrees', () => {
  const out = [
    'worktree /r',
    'HEAD 111',
    'branch refs/heads/main',
    '',
    'worktree /r-wt',
    'HEAD 222',
    'detached',
    'locked',
    '',
    'worktree /gone',
    'HEAD 333',
    'branch refs/heads/feature/x',
    'prunable gitdir file points to non-existent location',
    '',
  ].join('\n');
  const w = parseWorktrees(out);
  assert.equal(w.length, 3);
  assert.deepEqual(w[0], { path: '/r', head: '111', branch: 'main', main: true });
  assert.equal(w[1].detached, true);
  assert.equal(w[1].locked, 'locked');
  assert.equal(w[2].branch, 'feature/x');
  assert.equal(w[2].prunable, 'gitdir file points to non-existent location');
});

test('parseOverwrittenFiles', () => {
  const local = 'error: Your local changes to the following files would be overwritten by checkout:\n\tf\n\tdir/g\nPlease commit your changes or stash them before you switch branches.\nAborting\n';
  assert.deepEqual(parseOverwrittenFiles(local), { kind: 'local', files: ['f', 'dir/g'] });
  const untracked = 'error: The following untracked working tree files would be overwritten by checkout:\n\tx\nPlease move or remove them before you switch branches.\n';
  assert.deepEqual(parseOverwrittenFiles(untracked), { kind: 'untracked', files: ['x'] });
  assert.equal(parseOverwrittenFiles('fatal: invalid reference'), undefined);
});

test('sync text, tooltip and status bar text', () => {
  assert.equal(syncText(2, 1), '↑2 ↓1');
  assert.equal(syncText(0, 0), '');
  assert.equal(syncTooltip(0, 1), '1 incoming commit');
  assert.equal(syncTooltip(3, 0), '3 outgoing commits');
  assert.equal(syncTooltip(1, 2), '2 incoming and 1 outgoing commits');
  assert.equal(statusBarText({ repoName: 'r', multiRepo: false, branch: 'main', ahead: 2, behind: 1 }), '$(git-branch) main ↑2 ↓1');
  assert.equal(statusBarText({ repoName: 'r', multiRepo: true, branch: 'main' }), '$(git-branch) r / main');
  assert.equal(statusBarText({ repoName: 'r', multiRepo: false, head: '0123456789abcdef' }), '$(git-branch) 01234567');
});

test('sortForGrouping keeps directories contiguous', () => {
  assert.deepEqual(sortForGrouping(['feature/b', 'main', 'bug/x', 'dev', 'feature/a']), ['dev', 'main', 'bug/x', 'feature/a', 'feature/b']);
});

test('favorites default to main/master and toggle', () => {
  const none = { add: [], remove: [] };
  assert.equal(isFavorite('refs/heads/main', none), true);
  assert.equal(isFavorite('refs/remotes/origin/master', none), true);
  assert.equal(isFavorite('refs/heads/dev', none), false);
  const t = toggleFavorite('refs/heads/main', none);
  assert.equal(isFavorite('refs/heads/main', t), false);
  assert.equal(isFavorite('refs/heads/main', toggleFavorite('refs/heads/main', t)), true);
  assert.equal(isFavorite('refs/heads/dev', toggleFavorite('refs/heads/dev', none)), true);
});

test('cleanupCandidates', () => {
  const out = ['main\x1forigin/main\x1f\x1f100', 'old\x1f\x1f\x1f50', 'gone\x1forigin/gone\x1f[gone]\x1f60', 'wip\x1f\x1f\x1f70', ''].join('\n');
  const c = cleanupCandidates(out, ['main', 'old'], ['main']);
  assert.deepEqual(
    c.map((x) => [x.name, x.merged, x.gone]),
    [
      ['gone', false, true],
      ['old', true, false],
    ],
  );
});

test('cloneDirName / worktreeDirName / checkRemoteName', () => {
  assert.equal(cloneDirName('https://github.com/a/repo.git'), 'repo');
  assert.equal(cloneDirName('git@github.com:a/repo.git/'), 'repo');
  assert.equal(cloneDirName('/local/path/proj'), 'proj');
  assert.equal(worktreeDirName('app', 'feature/x'), 'app-feature-x');
  assert.equal(checkRemoteName('', []), 'Remote name cannot be empty');
  assert.equal(checkRemoteName('a/b', []), 'Remote name contains illegal characters');
  assert.equal(checkRemoteName('origin', ['origin']), "Remote name 'origin' is already used");
  assert.equal(checkRemoteName('origin', ['origin'], 'origin'), undefined);
});

test('unquotePath decodes git C-quoted paths', () => {
  assert.equal(unquotePath('plain.txt'), 'plain.txt');
  assert.equal(unquotePath('"d\\303\\251j\\303\\240.txt"'), 'déjà.txt');
  assert.equal(unquotePath('"a\\"b\\\\c\\td"'), 'a"b\\c\td');
  const r = parseOverwrittenFiles('error: Your local changes to the following files would be overwritten by checkout:\n\t"\\303\\251.txt"\n\tf\nPlease commit');
  assert.deepEqual(r, { kind: 'local', files: ['é.txt', 'f'] });
});
