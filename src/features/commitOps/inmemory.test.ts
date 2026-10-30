// Tests for raw commit rewriting and the in-memory reword/squash, against a real git repository in a temp dir.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { isConsecutiveChain, parseRawCommit, rewriteCommit } from './objects';
import { dropChangesCommit, extractChangesInMemory, rewordInMemory, splitCommit, SplitError, squashChainInMemory, type ObjectGit } from './inmemory';

const RAW =
  'tree aaaa\nparent p1\nparent p2\nauthor A <a@x> 1 +0000\ncommitter C <c@x> 2 +0000\nencoding ISO-8859-1\n' +
  'gpgsig -----BEGIN PGP SIGNATURE-----\n \n abc\n -----END PGP SIGNATURE-----\n\nsubj\n\nbody\n';

test('rewriteCommit replaces parents/committer/message and drops signatures', () => {
  const out = rewriteCommit(RAW, { parents: ['n1'], committer: 'Me <m@x> 3 +0100', message: 'new é' });
  assert.equal(out, 'tree aaaa\nparent n1\nauthor A <a@x> 1 +0000\ncommitter Me <m@x> 3 +0100\n\nnew \xc3\xa9\n');
  const kept = rewriteCommit(RAW, { tree: 'bbbb' });
  assert.match(kept, /^tree bbbb\nparent p1\nparent p2\n/);
  assert.match(kept, /encoding ISO-8859-1/);
  assert.ok(!kept.includes('gpgsig'));
  assert.equal(parseRawCommit(kept).message, 'subj\n\nbody\n');
  const root = rewriteCommit('tree t\nauthor A <a> 1 +0000\ncommitter C <c> 1 +0000\n\nm\n', { parents: ['x'] });
  assert.equal(root, 'tree t\nparent x\nauthor A <a> 1 +0000\ncommitter C <c> 1 +0000\n\nm\n');
});

test('consecutive chain', () => {
  assert.ok(isConsecutiveChain([{ hash: 'a', parents: ['z'] }, { hash: 'b', parents: ['a'] }]));
  assert.ok(!isConsecutiveChain([{ hash: 'a', parents: ['z'] }, { hash: 'c', parents: ['b'] }]));
  assert.ok(!isConsecutiveChain([{ hash: 'a', parents: ['z', 'y'] }, { hash: 'b', parents: ['a'] }]));
});

function repo(): { dir: string; sh: (...args: string[]) => string; git: ObjectGit } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jbgit-inmem-'));
  const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@x', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@x' };
  const sh = (...args: string[]) => {
    const r = spawnSync('git', args, { cwd: dir, env, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
    return r.stdout.trim();
  };
  const git: ObjectGit = {
    run: async (args, input, extra) => {
      const r = spawnSync('git', args, { cwd: dir, env: { ...env, ...extra }, input: input === undefined ? undefined : Buffer.from(input, 'latin1') });
      if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
      return r.stdout.toString('latin1');
    },
  };
  sh('init', '-q', '-b', 'main');
  return { dir, sh, git };
}

const commit = (r: ReturnType<typeof repo>, file: string, text: string, msg: string) => {
  fs.writeFileSync(path.join(r.dir, file), text);
  r.sh('add', file);
  r.sh('commit', '-q', '-m', msg);
  return r.sh('rev-parse', 'HEAD');
};

test('reword an older commit keeps trees, later merges and the working tree', async () => {
  const r = repo();
  const c1 = commit(r, 'a', '1', 'c1');
  const c2 = commit(r, 'a', '2', 'c2 ünï');
  r.sh('checkout', '-q', '-b', 'side');
  commit(r, 'b', 'side', 'side');
  r.sh('checkout', '-q', 'main');
  commit(r, 'c', 'main', 'c3');
  r.sh('merge', '-q', '--no-ff', 'side', '-m', 'merge side');
  const head = r.sh('rev-parse', 'HEAD');
  fs.writeFileSync(path.join(r.dir, 'a'), 'dirty');
  const newHead = await rewordInMemory(r.git, c2, head, 'reworded ü\n\nbody');
  assert.equal(r.sh('rev-parse', `${newHead}^{tree}`), r.sh('rev-parse', `${head}^{tree}`));
  assert.equal(r.sh('log', '--format=%s', '-1', `${newHead}~2`), 'reworded ü');
  assert.equal(r.sh('rev-list', '--count', newHead), '5');
  assert.equal(r.sh('rev-parse', `${newHead}~3`), c1);
  assert.equal(r.sh('rev-list', '--merges', '--count', newHead), '1');
  // the side branch forked from the reworded commit: re-parented onto the new one
  assert.equal(r.sh('log', '--format=%s', '-1', `${newHead}^2`), 'side');
  assert.equal(r.sh('rev-parse', `${newHead}^2^`), r.sh('rev-parse', `${newHead}~2`));
  assert.equal(fs.readFileSync(path.join(r.dir, 'a'), 'utf8'), 'dirty');
  fs.rmSync(r.dir, { recursive: true, force: true });
});

test('squash a consecutive chain in memory', async () => {
  const r = repo();
  const c1 = commit(r, 'a', '1', 'c1');
  const c2 = commit(r, 'b', '2', 'c2');
  const c3 = commit(r, 'c', '3', 'c3');
  commit(r, 'd', '4', 'c4');
  const head = r.sh('rev-parse', 'HEAD');
  const newHead = await squashChainInMemory(r.git, [c2, c3], head, 'c2+c3');
  assert.equal(r.sh('log', '--format=%s', newHead), 'c4\nc2+c3\nc1');
  assert.equal(r.sh('rev-parse', `${newHead}^{tree}`), r.sh('rev-parse', `${head}^{tree}`));
  assert.equal(r.sh('rev-parse', `${newHead}~2`), c1);
  assert.deepEqual(r.sh('show', '--name-only', '--format=', `${newHead}~1`).split('\n').sort(), ['b', 'c']);
  // the root commit can be squashed too
  const root = await squashChainInMemory(r.git, [c1, c2], head, 'root');
  assert.equal(r.sh('log', '--format=%s', root), 'c4\nc3\nroot');
  fs.rmSync(r.dir, { recursive: true, force: true });
});

test('split a commit: drop and extract selected changes', async () => {
  const r = repo();
  fs.mkdirSync(path.join(r.dir, 'd'));
  fs.writeFileSync(path.join(r.dir, 'd', 'b'), '1');
  r.sh('add', '-A');
  commit(r, 'a', '1', 'c1');
  fs.writeFileSync(path.join(r.dir, 'd', 'b'), '2');
  fs.writeFileSync(path.join(r.dir, 'd', 'nëw'), 'n');
  r.sh('add', '-A');
  const c2 = commit(r, 'a', '2', 'c2');
  r.sh('checkout', '-q', '-b', 'side');
  commit(r, 'e', 'side', 'side');
  r.sh('checkout', '-q', 'main');
  commit(r, 'a', '3', 'c3');
  r.sh('merge', '-q', '--no-ff', 'side', '-m', 'merge side');
  const head = r.sh('rev-parse', 'HEAD');
  const idx = path.join(r.dir, '.git', 'jbgit-split-index');
  const split = await splitCommit(r.git, c2, ['d/b', 'd/nëw'], idx);
  // selected paths are back at the parent's state: d/b = 1, d/nëw removed
  assert.deepEqual(r.sh('-c', 'core.quotepath=false', 'ls-tree', '-r', '--name-only', split.remaining).split('\n'), ['a', 'd/b']);
  assert.equal(r.sh('show', `${split.remaining}:d/b`), '1');
  assert.equal(r.sh('show', `${split.remaining}:a`), '2');
  // the repository's own index is untouched
  assert.equal(r.sh('status', '--porcelain'), '');

  const dropped = await dropChangesCommit(r.git, split);
  assert.equal(r.sh('rev-parse', `${dropped}^`), r.sh('rev-parse', `${c2}^`));
  assert.equal(r.sh('log', '--format=%s%n%an', '-1', dropped), 'c2\nT');
  assert.equal(r.sh('show', '--name-only', '--format=', dropped), 'a');

  const res = await extractChangesInMemory(r.git, c2, head, split, 'extracted ü');
  assert.equal(r.sh('rev-parse', `${res.head}^{tree}`), r.sh('rev-parse', `${head}^{tree}`));
  assert.equal(r.sh('log', '--first-parent', '--format=%s', res.head), 'merge side\nc3\nextracted ü\nc2\nc1');
  assert.equal(r.sh('rev-parse', `${res.head}~2`), res.extracted);
  assert.deepEqual(r.sh('-c', 'core.quotepath=false', 'show', '--name-only', '--format=', res.extracted).split('\n'), ['d/b', 'd/nëw']);
  assert.equal(r.sh('show', '--name-only', '--format=', `${res.extracted}^`), 'a');
  // the side branch forked from c2 is re-parented onto the extracted commit
  assert.equal(r.sh('rev-parse', `${res.head}^2^`), res.extracted);
  fs.rmSync(r.dir, { recursive: true, force: true });
});

test('split a root commit and reject mixed file/directory changes', async () => {
  const r = repo();
  fs.writeFileSync(path.join(r.dir, 'b'), 'b');
  r.sh('add', 'b');
  const c1 = commit(r, 'a', '1', 'c1');
  const split = await splitCommit(r.git, c1, ['b'], path.join(r.dir, '.git', 'idx1'));
  assert.equal(r.sh('ls-tree', '--name-only', split.remaining), 'a');
  assert.equal(split.parentTree, '4b825dc642cb6eb9a060e54bf8d69288fbee4904');
  // 'x' file → 'x/y' directory: restoring only the file 'x' would leave a file/directory conflict
  commit(r, 'x', 'file', 'c2');
  r.sh('rm', '-q', 'x');
  fs.mkdirSync(path.join(r.dir, 'x'));
  const c3 = commit(r, 'x/y', 'dir', 'c3');
  await assert.rejects(splitCommit(r.git, c3, ['x'], path.join(r.dir, '.git', 'idx2')), SplitError);
  const both = await splitCommit(r.git, c3, ['x', 'x/y'], path.join(r.dir, '.git', 'idx3'));
  assert.equal(both.remaining, both.parentTree);
  fs.rmSync(r.dir, { recursive: true, force: true });
});
