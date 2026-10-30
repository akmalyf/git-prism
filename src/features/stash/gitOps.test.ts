// Integration tests of the stash / shelf git plumbing against a real git in throw-away repositories (node --test):
// patches of local changes (untracked, renames, CRLF, latin1, non-ASCII paths), removing and re-applying them, stash files.
import { after, test } from 'node:test';
import * as assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { parseNameStatus, parseStatusV2 } from '../../core/parse';
import type { Repository } from '../../core/repository';
import * as ops from './gitOps';
import { filterPatchBytes, parsePatch } from './patch';

const ENV = { ...process.env, LC_ALL: 'C.UTF-8', GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1', HOME: os.tmpdir() };

function run(cwd: string, args: string[], opts: { input?: string | Buffer; env?: Record<string, string>; allowFail?: boolean } = {}) {
  const r = spawnSync('git', args, { cwd, input: opts.input, env: { ...ENV, ...opts.env }, maxBuffer: 1 << 28 });
  if (r.status !== 0 && !opts.allowFail) throw new Error(`git ${args.join(' ')}: ${r.stderr.toString()}`);
  return { stdout: r.stdout, stderr: r.stderr.toString(), code: r.status ?? -1 };
}

/** The part of Repository the stash plumbing uses. */
function fakeRepo(root: string): Repository {
  const gitDir = path.join(root, '.git');
  const r = {
    root,
    gitDir,
    commonDir: gitDir,
    name: path.basename(root),
    abs: (rel: string) => path.join(root, ...rel.split('/')),
    rel: (abs: string) => path.relative(root, abs).split(path.sep).join('/'),
    fireChanged: () => undefined,
    async run(args: string[], o: { input?: string | Buffer; env?: Record<string, string>; allowFail?: boolean } = {}) {
      const x = run(root, args, o);
      return { stdout: x.stdout.toString('utf8'), stderr: x.stderr, code: x.code };
    },
    async exec(args: string[], o: { input?: string | Buffer; env?: Record<string, string>; allowFail?: boolean } = {}) {
      return r.run(args, o);
    },
    async buffer(args: string[], o: { input?: string | Buffer; env?: Record<string, string>; allowFail?: boolean } = {}) {
      return run(root, args, o).stdout;
    },
    async status() {
      return parseStatusV2((await r.run(['status', '--porcelain=v2', '-z', '--branch', '--untracked-files=all', '--find-renames'])).stdout);
    },
    async headHash() {
      const x = run(root, ['rev-parse', '--verify', '--quiet', 'HEAD'], { allowFail: true });
      return x.code === 0 ? x.stdout.toString().trim() : undefined;
    },
    async stashes() {
      const out = (await r.run(['stash', 'list', '--format=%gd%x1f%H%x1f%gs%x1f%ct'], { allowFail: true })).stdout;
      return out.split('\n').filter(Boolean).map((l) => {
        const [ref, hash, message, date] = l.split('\x1f');
        return { index: +ref.replace(/\D/g, ''), ref, hash, message, date: +date };
      });
    },
    async changes(from: string, to?: string) {
      return parseNameStatus((await r.run(['diff', '--name-status', '-z', '-M', from, ...(to ? [to] : [])])).stdout);
    },
    async commitChanges(hash: string) {
      return parseNameStatus((await r.run(['diff-tree', '--no-commit-id', '--name-status', '-z', '-r', '-M', '--root', hash])).stdout);
    },
  };
  return r as unknown as Repository;
}

const roots: string[] = [];
after(() => {
  for (const r of roots) fs.rmSync(r, { recursive: true, force: true });
});

function newRepo(commit = true): { root: string; repo: Repository } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jbgit-stash-test-'));
  roots.push(root);
  run(root, ['init', '-q', '-b', 'main']);
  run(root, ['config', 'user.email', 't@t']);
  run(root, ['config', 'user.name', 't']);
  run(root, ['config', 'core.autocrlf', 'false']);
  if (commit) {
    fs.writeFileSync(path.join(root, 'a.txt'), '1\n2\n3\n');
    fs.writeFileSync(path.join(root, 'crlf.txt'), 'x\r\ny\r\nz\r\n');
    fs.writeFileSync(path.join(root, 'latin.txt'), Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a, 0x6f, 0x6b, 0x0a]));
    fs.writeFileSync(path.join(root, 'old name.txt'), 'rename me\n');
    run(root, ['add', '-A']);
    run(root, ['commit', '-qm', 'init']);
  }
  return { root, repo: fakeRepo(root) };
}

const read = (root: string, p: string) => fs.readFileSync(path.join(root, p));
const indexState = (root: string) => run(root, ['diff', '--cached', '--name-status']).stdout.toString() + run(root, ['ls-files']).stdout.toString();

test('local changes patch: untracked, staged rename, CRLF, latin1, non-ASCII; remove and re-apply restores bytes', async () => {
  const { root, repo } = newRepo();
  fs.writeFileSync(path.join(root, 'a.txt'), '1\nTWO\n3\n');
  fs.writeFileSync(path.join(root, 'crlf.txt'), 'x\r\nY\r\nz\r\n');
  fs.writeFileSync(path.join(root, 'latin.txt'), Buffer.from([0x63, 0x61, 0x66, 0xc8, 0x0a, 0x6f, 0x6b, 0x0a]));
  fs.mkdirSync(path.join(root, 'dir/sub'), { recursive: true });
  fs.writeFileSync(path.join(root, 'dir/sub/ü file.txt'), 'new\n');
  run(root, ['mv', 'old name.txt', 'new name.txt']);
  const before = indexState(root);
  const entries = await ops.changedEntries(repo);
  const want = new Map(['a.txt', 'crlf.txt', 'latin.txt', 'dir/sub/ü file.txt', 'new name.txt'].map((p) => [p, read(root, p)]));
  const patch = await ops.localChangesPatch(repo, []);
  assert.equal(indexState(root), before, 'the real index is untouched');
  assert.deepEqual(parsePatch(patch.toString('utf8')).files.map((f) => f.path).sort(), ['a.txt', 'crlf.txt', 'dir/sub/ü file.txt', 'latin.txt', 'new name.txt']);
  assert.ok(await ops.patchMatchesWorkingTree(repo, patch));

  await ops.removeLocalChanges(repo, entries);
  assert.equal((await repo.status()).entries.length, 0, 'working tree clean');
  assert.ok(!fs.existsSync(path.join(root, 'dir')), 'emptied directories removed');

  const res = await ops.applyPatch(repo, patch, 1, async () => false);
  assert.equal(res.outcome, 'ok', res.stderr);
  for (const [p, bytes] of want) assert.deepEqual(read(root, p), bytes, p);
  assert.ok(!fs.existsSync(path.join(root, 'old name.txt')));
});

test('filterPatchBytes keeps CRLF and latin1 bytes of the chosen files', async () => {
  const { root, repo } = newRepo();
  fs.writeFileSync(path.join(root, 'crlf.txt'), 'x\r\nY\r\nz\r\n');
  fs.writeFileSync(path.join(root, 'latin.txt'), Buffer.from([0x63, 0x61, 0x66, 0xc8, 0x0a, 0x6f, 0x6b, 0x0a]));
  fs.writeFileSync(path.join(root, 'a.txt'), '1\n2\n3\n4\n');
  const patch = await ops.localChangesPatch(repo, []);
  const part = filterPatchBytes(patch, ['crlf.txt', 'latin.txt']);
  assert.deepEqual(parsePatch(part.toString('utf8')).files.map((f) => f.path), ['crlf.txt', 'latin.txt']);
  run(root, ['checkout', '-q', '--', '.']);
  assert.equal((await ops.applyPatch(repo, part, 1, async () => false)).outcome, 'ok');
  assert.deepEqual(read(root, 'crlf.txt'), Buffer.from('x\r\nY\r\nz\r\n'));
  assert.deepEqual(read(root, 'latin.txt'), Buffer.from([0x63, 0x61, 0x66, 0xc8, 0x0a, 0x6f, 0x6b, 0x0a]));
  assert.equal(read(root, 'a.txt').toString(), '1\n2\n3\n');
});

test('path-limited patch and unborn branch', async () => {
  const { root, repo } = newRepo(false);
  fs.writeFileSync(path.join(root, 'staged.txt'), 's\n');
  run(root, ['add', 'staged.txt']);
  fs.writeFileSync(path.join(root, 'other.txt'), 'o\n');
  const patch = await ops.localChangesPatch(repo, ['staged.txt']);
  assert.deepEqual(parsePatch(patch.toString('utf8')).files.map((f) => [f.path, f.kind]), [['staged.txt', 'A']]);
  const entries = (await ops.changedEntries(repo, ['staged.txt']));
  assert.ok(await ops.patchMatchesWorkingTree(repo, patch));
  await ops.removeLocalChanges(repo, entries);
  assert.ok(!fs.existsSync(path.join(root, 'staged.txt')));
  assert.ok(fs.existsSync(path.join(root, 'other.txt')));
  assert.equal((await ops.applyPatch(repo, patch, 1, async () => false)).outcome, 'ok');
  assert.equal(read(root, 'staged.txt').toString(), 's\n');
});

test('stash files include index-only and untracked changes; apply conflicts are classified', async () => {
  const { root, repo } = newRepo();
  fs.writeFileSync(path.join(root, 'a.txt'), '1\n2\n3\nstaged\n');
  run(root, ['add', 'a.txt']);
  fs.writeFileSync(path.join(root, 'u ü.txt'), 'u\n');
  run(root, ['rm', '-q', 'crlf.txt']);
  const r = await ops.createStash(repo, { message: 'msg', keepIndex: false, untracked: true });
  assert.ok(r.created);
  const [s] = await repo.stashes();
  const files = await ops.stashFiles(repo, s.hash);
  assert.deepEqual(files.map((f) => [f.path, f.kind, f.source]), [['a.txt', 'M', 'tracked'], ['crlf.txt', 'D', 'tracked'], ['u ü.txt', '?', 'untracked']]);
  const patch = await ops.stashPatch(repo, s.hash, files);
  assert.deepEqual(parsePatch(patch.toString('utf8')).files.map((f) => f.path).sort(), ['a.txt', 'crlf.txt', 'u ü.txt']);

  fs.writeFileSync(path.join(root, 'u ü.txt'), 'exists\n');
  assert.equal((await ops.unstash(repo, s.hash, { pop: false, index: false })).outcome, 'untracked');
  run(root, ['reset', '-q', '--hard']);
  fs.rmSync(path.join(root, 'u ü.txt'));
  fs.writeFileSync(path.join(root, 'a.txt'), '1\n2\n3\nother\n');
  execFileSync('git', ['commit', '-qam', 'conflicting'], { cwd: root, env: ENV });
  assert.equal((await ops.unstash(repo, s.hash, { pop: true, index: false })).outcome, 'conflict');
  assert.equal((await repo.stashes()).length, 1, 'pop with conflicts keeps the stash');
});
