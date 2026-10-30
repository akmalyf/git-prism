// Unit tests for the sync dialogs' pure logic: option exclusivity, git arguments, push output parsing and texts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MERGE_OPTIONS,
  mergeArgs,
  mergeOptionEnabled,
  pullArgs,
  pullOptionEnabled,
  rebaseArgs,
  rebaseOptionEnabled,
  splitRemoteRef,
  toggleOption,
} from './options';
import {
  describePush,
  isNonFastForward,
  isProtected,
  parseDiffTreeStdin,
  parsePatterns,
  parsePushPorcelain,
  prunedRefs,
  pushedTags,
  squashChanges,
  updatedText,
} from './pushLogic';

test('merge options exclude each other like IntelliJ', () => {
  assert.equal(mergeOptionEnabled('ff-only', ['no-ff']), false);
  assert.equal(mergeOptionEnabled('squash', ['no-ff']), false);
  assert.equal(mergeOptionEnabled('m', ['ff-only']), false);
  assert.equal(mergeOptionEnabled('no-commit', ['m']), false);
  assert.equal(mergeOptionEnabled('no-verify', ['m', 'no-ff']), true);
  assert.equal(mergeOptionEnabled('no-ff', ['no-ff']), true, 'selected stays enabled');
});

test('pull options exclude each other like IntelliJ', () => {
  assert.equal(pullOptionEnabled('rebase', ['no-commit']), false);
  assert.equal(pullOptionEnabled('squash', ['rebase']), false);
  assert.equal(pullOptionEnabled('no-verify', ['rebase']), true);
  assert.equal(pullOptionEnabled('no-commit', ['squash']), true);
});

test('rebase autosquash pair', () => {
  assert.equal(rebaseOptionEnabled('autosquash', ['no-autosquash']), false);
  assert.equal(rebaseOptionEnabled('interactive', ['rebase-merges'], false), false);
  assert.equal(rebaseOptionEnabled('interactive', ['rebase-merges'], true), true);
});

test('toggleOption keeps definition order', () => {
  assert.deepEqual(toggleOption(MERGE_OPTIONS, ['no-verify'], 'no-ff'), ['no-ff', 'no-verify']);
  assert.deepEqual(toggleOption(MERGE_OPTIONS, ['no-ff', 'no-verify'], 'no-ff'), ['no-verify']);
});

test('git arguments', () => {
  assert.deepEqual(mergeArgs({ ref: 'feature', options: ['no-ff'] }), ['merge', '--no-ff', '--no-edit', '--autostash', 'feature']);
  assert.deepEqual(mergeArgs({ ref: 'feature', options: ['m'], message: 'Msg' }), ['merge', '-m', 'Msg', '--autostash', 'feature']);
  assert.deepEqual(mergeArgs({ ref: 'feature', options: ['squash'] }), ['merge', '--squash', '--no-edit', 'feature'], 'no --autostash for an uncommitted result');
  assert.deepEqual(pullArgs({ remote: 'origin', branches: ['main'], options: ['rebase'] }), ['pull', '--no-edit', '--rebase', '--autostash', 'origin', 'main']);
  assert.deepEqual(pullArgs({ remote: 'origin', branches: ['main'], options: [] }), ['pull', '--no-edit', '--no-rebase', '--autostash', 'origin', 'main']);
  assert.deepEqual(pullArgs({ remote: 'origin', branches: ['a', 'b'], options: ['no-commit'] }), ['pull', '--no-edit', '--no-rebase', '--no-commit', 'origin', 'a', 'b']);
  assert.deepEqual(rebaseArgs({ upstream: 'main', options: ['keep-empty'] }), ['rebase', '--autostash', '--keep-empty', 'main']);
  assert.deepEqual(rebaseArgs({ upstream: 'old', onto: 'new', options: ['onto', 'switch-branch'], branch: 'topic' }), ['rebase', '--autostash', '--onto', 'new', 'old', 'topic']);
  assert.deepEqual(rebaseArgs({ upstream: 'x', options: ['root'] }), ['rebase', '--autostash', '--root']);
});

test('splitRemoteRef prefers the longest remote', () => {
  assert.deepEqual(splitRemoteRef('origin/feature/x', ['origin']), { remote: 'origin', branch: 'feature/x' });
  assert.deepEqual(splitRemoteRef('up/stream/main', ['up', 'up/stream']), { remote: 'up/stream', branch: 'main' });
  assert.deepEqual(splitRemoteRef('main', ['origin']), { branch: 'main' });
});

const OUT = `To /tmp/remote.git
*\tHEAD:refs/heads/main\t[new branch]
 \trefs/heads/dev:refs/heads/dev\tfdc3d23..1802b17
!\trefs/heads/x:refs/heads/x\t[rejected] (fetch first)
+\trefs/heads/y:refs/heads/y\t1802b17...03adaef (forced update)
=\trefs/tags/v0:refs/tags/v0\t[up to date]
*\trefs/tags/v1:refs/tags/v1\t[new tag]
Done
`;

test('parsePushPorcelain', () => {
  const r = parsePushPorcelain(OUT);
  assert.equal(r.length, 6);
  assert.deepEqual(r[0], { flag: 'new', from: 'HEAD', to: 'refs/heads/main', summary: '[new branch]', reason: undefined });
  assert.equal(r[2].flag, 'rejected');
  assert.equal(r[2].reason, 'fetch first');
  assert.equal(isNonFastForward(r[2]), true);
  assert.equal(r[3].reason, 'forced update');
  assert.deepEqual(pushedTags(r), ['v1']);
  assert.equal(isNonFastForward({ flag: 'rejected', from: 'a', to: 'b', summary: '[rejected]', reason: 'stale info' }), false);
});

test('describePush texts', () => {
  const base = { target: 'origin/main', remote: 'origin', count: 2, tags: [] as string[], force: false };
  assert.equal(describePush({ ...base, branch: { flag: 'ff', from: 'refs/heads/main', to: 'refs/heads/main', summary: 'a..b' } }), 'Pushed 2 commits to origin/main');
  assert.equal(describePush({ ...base, count: 1, branch: { flag: 'new', from: 'refs/heads/main', to: 'refs/heads/main', summary: '' } }), 'Pushed 1 commit to new branch origin/main');
  assert.equal(describePush({ ...base, tags: ['v1'], branch: { flag: 'ff', from: 'refs/heads/main', to: 'refs/heads/main', summary: '' } }), 'Pushed 2 commits to origin/main, and tag v1 to origin');
  assert.equal(describePush({ ...base, branch: { flag: 'uptodate', from: 'x', to: 'x', summary: '' } }), 'Everything is up to date');
  assert.equal(describePush({ ...base, force: true, branch: { flag: 'forced', from: 'refs/heads/main', to: 'refs/heads/main', summary: '' } }), 'Force pushed main to origin/main');
  assert.equal(describePush({ ...base, branch: { flag: 'rejected', from: 'refs/heads/main', to: 'refs/heads/main', summary: '[rejected]', reason: 'fetch first' } }), 'Push to origin/main was rejected');
});

test('protected branches', () => {
  const p = parsePatterns('master, main');
  assert.deepEqual(p, ['master', 'main']);
  assert.equal(isProtected('main', p), true);
  assert.equal(isProtected('maintenance', p), false);
  assert.equal(isProtected('release/1', ['release/.*']), true);
  assert.equal(isProtected('(', ['(']), true, 'invalid regex falls back to equality');
});

test('prunedRefs and updatedText', () => {
  assert.deepEqual(prunedRefs(' - [deleted]         (none)     -> origin/old\n   abc..def  main -> origin/main\n'), ['origin/old']);
  assert.equal(updatedText(1, 1), '1 file updated in 1 commit');
  assert.equal(updatedText(11, 3), '11 files updated in 3 commits');
});

test('parseDiffTreeStdin', () => {
  const h1 = 'c807b1aae0283f48ed992c3a6943d4e67f0d2ac4';
  const h2 = '19cdf3576aab3b5aa0d8f5289a6a84356128b480';
  const h3 = '646462a416d8507cff65897b960a65d19f89b368';
  const out = `${h1}\0${h2}\0M\0dir/fé ü.txt\0${h3}\0R100\0f.txt\0dir/fé ü.txt\0`;
  const m = parseDiffTreeStdin(out);
  assert.deepEqual(m.get(h1), []);
  assert.deepEqual(m.get(h2), [{ kind: 'M', path: 'dir/fé ü.txt' }]);
  assert.deepEqual(m.get(h3), [{ kind: 'R', oldPath: 'f.txt', path: 'dir/fé ü.txt' }]);
});

test('squashChanges nets out several commits', () => {
  const c = (hash: string, files: { kind: 'A' | 'M' | 'D' | 'R'; path: string; oldPath?: string }[], root = false) => ({ hash, root, files });
  const pick = (r: ReturnType<typeof squashChanges>) => r.map((x) => [x.kind, x.oldPath ?? '', x.path, x.first, x.last].join(' '));
  // modify then rename keeps the original path
  assert.deepEqual(pick(squashChanges([c('1', [{ kind: 'M', path: 'a' }]), c('2', [{ kind: 'R', oldPath: 'a', path: 'b' }])])), ['R a b 1 2']);
  // rename then modify stays a rename
  assert.deepEqual(pick(squashChanges([c('1', [{ kind: 'R', oldPath: 'a', path: 'b' }]), c('2', [{ kind: 'M', path: 'b' }])])), ['R a b 1 2']);
  // added then deleted disappears; deleted then re-added is a modification
  assert.deepEqual(pick(squashChanges([c('1', [{ kind: 'A', path: 'x' }, { kind: 'D', path: 'y' }]), c('2', [{ kind: 'D', path: 'x' }, { kind: 'A', path: 'y' }])])), ['M  y 1 2']);
  // added then renamed is an addition at the new path; renamed then deleted deletes the original
  assert.deepEqual(pick(squashChanges([c('1', [{ kind: 'A', path: 'n' }, { kind: 'R', oldPath: 'o', path: 'p' }]), c('2', [{ kind: 'R', oldPath: 'n', path: 'n2' }, { kind: 'D', path: 'p' }])])), ['A  n2 1 2', 'D  o 1 2']);
  // renamed back and forth is a modification
  assert.deepEqual(pick(squashChanges([c('1', [{ kind: 'R', oldPath: 'a', path: 'b' }]), c('2', [{ kind: 'R', oldPath: 'b', path: 'a' }])])), ['M  a 1 2']);
});
