// Git plumbing of the stash / shelf / patch feature: stash file lists and operations, patches of local changes that
// include untracked files (intent-to-add in a throw-away index), applying patches (plain → 3-way → with rejects) and
// removing shelved changes from the working tree.
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Repository } from '../../core/repository';
import type { StatusEntry } from '../../core/types';
import { classifyApply, mergeStashFiles, type ApplyOutcome } from './logic';
import type { StashFile, StashItem, StashRequest } from './protocol';

export const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

/** Paths are passed literally (no glob magic) to every path-limited command. */
const LIT = '--literal-pathspecs';

export async function hasUntrackedParent(repo: Repository, hash: string): Promise<boolean> {
  const r = await repo.run(['rev-parse', '--verify', '--quiet', `${hash}^3`], { allowFail: true, quiet: true });
  return r.code === 0;
}

/** Files of a stash commit: working tree + index-only changes + untracked files (3rd parent). */
export async function stashFiles(repo: Repository, hash: string): Promise<StashFile[]> {
  const [tracked, index, untracked] = await Promise.all([
    repo.changes(`${hash}^1`, hash),
    repo.changes(`${hash}^1`, `${hash}^2`).catch(() => []),
    hasUntrackedParent(repo, hash).then((has) => (has ? repo.commitChanges(`${hash}^3`) : [])),
  ]);
  return mergeStashFiles(tracked, index, untracked);
}

/** The current `stash@{n}` of a stash commit (refs shift when stashes are dropped). */
export async function stashRef(repo: Repository, hash: string): Promise<StashItem> {
  const s = (await repo.stashes()).find((x) => x.hash === hash);
  if (!s) throw new Error('The stash does not exist anymore. Refresh the list of stashes.');
  return s;
}

export async function createStash(repo: Repository, req: Omit<StashRequest, 'repoRoot'>): Promise<{ created: boolean; output: string }> {
  const args = [LIT, 'stash', 'push'];
  if (req.message.trim()) args.push('-m', req.message.trim());
  if (req.keepIndex) args.push('--keep-index');
  if (req.untracked) args.push('--include-untracked');
  if (req.paths?.length) args.push('--', ...req.paths);
  const before = (await repo.stashes()).length;
  const r = await repo.exec(args);
  const after = (await repo.stashes()).length;
  return { created: after > before, output: (r.stdout + r.stderr).trim() };
}

export interface ApplyResult {
  outcome: ApplyOutcome;
  stdout: string;
  stderr: string;
}

/** git stash apply/pop/branch; never throws for git failures, the outcome tells what happened. */
export async function unstash(repo: Repository, hash: string, opts: { pop: boolean; index: boolean; branch?: string }): Promise<ApplyResult> {
  const s = await stashRef(repo, hash);
  const args = opts.branch
    ? ['stash', 'branch', opts.branch, s.ref]
    : ['stash', opts.pop ? 'pop' : 'apply', ...(opts.index ? ['--index'] : []), opts.pop ? s.ref : hash];
  const r = await repo.exec(args, { allowFail: true });
  return { outcome: classifyApply(r.code, r.stdout, r.stderr), stdout: r.stdout, stderr: r.stderr };
}

export async function dropStash(repo: Repository, hash: string): Promise<void> {
  const s = await stashRef(repo, hash);
  await repo.exec(['stash', 'drop', s.ref]);
}

export async function clearStashes(repo: Repository): Promise<void> {
  await repo.exec(['stash', 'clear']);
}

// ------------------------------------------------------------------ patches

async function withTempIndex<T>(repo: Repository, fn: (env: Record<string, string>) => Promise<T>): Promise<T> {
  const tmp = path.join(os.tmpdir(), `gitprism-index-${crypto.randomBytes(6).toString('hex')}`);
  const real = path.join(repo.gitDir, 'index');
  try {
    if (fs.existsSync(real)) await fs.promises.copyFile(real, tmp);
    return await fn({ GIT_INDEX_FILE: tmp });
  } finally {
    await fs.promises.rm(tmp, { force: true });
    await fs.promises.rm(`${tmp}.lock`, { force: true });
  }
}

const under = (p: string, paths: string[]) => paths.some((q) => q === '.' || q === '' || p === q || p.startsWith(q.endsWith('/') ? q : `${q}/`));

/**
 * A binary git patch of local changes (HEAD → working tree) limited to `paths` (files or directories, all when empty),
 * untracked files included as new files. The real index is never touched.
 */
export async function localChangesPatch(repo: Repository, paths: string[] = [], opts: { reverse?: boolean } = {}): Promise<Buffer> {
  const base = (await repo.headHash()) ?? EMPTY_TREE;
  const status = await repo.status();
  const untracked = status.entries.filter((e) => e.kind === '?' && (!paths.length || under(e.path, paths))).map((e) => e.path);
  return withTempIndex(repo, async (env) => {
    if (untracked.length) {
      await repo.run([LIT, 'add', '--intent-to-add', '--pathspec-from-file=-', '--pathspec-file-nul'], { env, input: untracked.join('\0'), quiet: true });
    }
    const args = [LIT, 'diff', '--binary', '--full-index', '--no-ext-diff', '--no-color', '--no-textconv', '-M'];
    if (opts.reverse) args.push('-R');
    args.push(base);
    if (paths.length) args.push('--', ...paths);
    return repo.buffer(args, { env, quiet: true });
  });
}

/** A binary patch of a stash (selected files; working tree, index-only and untracked parts). */
export async function stashPatch(repo: Repository, hash: string, files: StashFile[]): Promise<Buffer> {
  const tracked = files.filter((f) => f.source === 'tracked').flatMap((f) => (f.oldPath ? [f.oldPath, f.path] : [f.path]));
  const index = files.filter((f) => f.source === 'index').map((f) => f.path);
  const untracked = files.filter((f) => f.source === 'untracked').map((f) => f.path);
  const diff = async (from: string, to: string, paths: string[]) =>
    paths.length ? repo.buffer([LIT, 'diff', '--binary', '--full-index', '--no-ext-diff', '--no-color', '--no-textconv', '-M', from, to, '--', ...paths], { quiet: true }) : Buffer.alloc(0);
  return Buffer.concat([await diff(`${hash}^1`, hash, tracked), await diff(`${hash}^1`, `${hash}^2`, index), await diff(EMPTY_TREE, `${hash}^3`, untracked)]);
}

export interface PatchApplyResult {
  outcome: ApplyOutcome | 'rejected';
  stdout: string;
  stderr: string;
  /** paths with rejected hunks (.rej files written) */
  rejected: string[];
  /** applied with --3way (changes are staged) */
  threeWay: boolean;
}

export async function checkPatch(repo: Repository, patch: Buffer, strip: number, reverse = false): Promise<boolean> {
  const r = await repo.run(['apply', '--check', `-p${strip}`, ...(reverse ? ['-R'] : []), '-'], { input: patch, allowFail: true, quiet: true });
  return r.code === 0;
}

/**
 * Applies a patch to the working tree: plain `git apply` when it applies cleanly, else `git apply --3way` (conflicts
 * end up as unmerged index entries), else — only if `allowReject` — `git apply --reject` (.rej files).
 */
export async function applyPatch(repo: Repository, patch: Buffer, strip: number, allowReject: () => Promise<boolean>): Promise<PatchApplyResult> {
  const base = ['apply', `-p${strip}`, '--whitespace=nowarn'];
  if (await checkPatch(repo, patch, strip)) {
    const r = await repo.exec([...base, '-'], { input: patch, allowFail: true });
    return { outcome: classifyApply(r.code, r.stdout, r.stderr), stdout: r.stdout, stderr: r.stderr, rejected: [], threeWay: false };
  }
  const three = await repo.exec([...base, '--3way', '-'], { input: patch, allowFail: true });
  const outcome = classifyApply(three.code, three.stdout, three.stderr);
  if (outcome === 'ok' || outcome === 'conflict') return { outcome, stdout: three.stdout, stderr: three.stderr, rejected: [], threeWay: true };
  if (!(await allowReject())) return { outcome: 'error', stdout: three.stdout, stderr: three.stderr, rejected: [], threeWay: false };
  const r = await repo.exec([...base, '--reject', '-'], { input: patch, allowFail: true });
  const rejected = [...new Set([...r.stderr.matchAll(/^Applying patch (.+?) with \d+ rejects?\.\.\.$/gm)].map((m) => m[1]))];
  return { outcome: r.code === 0 ? 'ok' : 'rejected', stdout: r.stdout, stderr: r.stderr, rejected, threeWay: false };
}

/** Files of the patch that do not apply cleanly (each checked on its own). */
export async function patchFileStatus(repo: Repository, chunks: { path: string; raw: Buffer }[], strip: number): Promise<Map<string, 'ok' | 'applied' | 'fail'>> {
  const out = new Map<string, 'ok' | 'applied' | 'fail'>();
  // common case: the whole patch applies → no per-file checks (one git process instead of one or two per file)
  if (chunks.length > 1 && (await checkPatch(repo, Buffer.concat(chunks.map((c) => c.raw)), strip))) {
    for (const c of chunks) out.set(c.path, 'ok');
    return out;
  }
  for (const c of chunks) {
    if (await checkPatch(repo, c.raw, strip)) out.set(c.path, 'ok');
    else if (await checkPatch(repo, c.raw, strip, true)) out.set(c.path, 'applied');
    else out.set(c.path, 'fail');
  }
  return out;
}

/** Reverts `paths` to HEAD in index and working tree; added / untracked files are deleted (Shelve removes them). */
export async function removeLocalChanges(repo: Repository, entries: StatusEntry[]): Promise<void> {
  const hasHead = !!(await repo.headHash());
  const checkout = new Set<string>();
  const unstage = new Set<string>();
  const unlink = new Set<string>();
  for (const e of entries) {
    if (e.kind === '?') unlink.add(e.path);
    else if (!hasHead || e.index === 'A' || e.kind === 'A' || e.index === 'C') (unstage.add(e.path), unlink.add(e.path));
    else if (e.kind === 'R' || e.index === 'R') {
      unstage.add(e.path);
      unlink.add(e.path);
      if (e.oldPath) checkout.add(e.oldPath);
    } else checkout.add(e.path);
  }
  // paths go through stdin: no command line length limit for thousands of files
  const nul = (set: Set<string>) => ({ input: [...set].join('\0') });
  if (unstage.size) await repo.exec([LIT, 'rm', '--cached', '-f', '-q', '--ignore-unmatch', '--pathspec-from-file=-', '--pathspec-file-nul'], nul(unstage));
  if (checkout.size) await repo.exec([LIT, 'checkout', 'HEAD', '--pathspec-from-file=-', '--pathspec-file-nul'], nul(checkout));
  for (const p of unlink) {
    await fs.promises.rm(repo.abs(p), { force: true });
    // remove directories that became empty, like IntelliJ does after shelving new files
    let dir = path.dirname(repo.abs(p));
    while (dir.startsWith(repo.root + path.sep)) {
      try {
        if ((await fs.promises.readdir(dir)).length) break;
        await fs.promises.rmdir(dir);
      } catch {
        break;
      }
      dir = path.dirname(dir);
    }
  }
  repo.fireChanged();
}

/** True when `patch` can be reverse-applied to the working tree, i.e. it exactly describes the local changes. */
export async function patchMatchesWorkingTree(repo: Repository, patch: Buffer, strip = 1): Promise<boolean> {
  return checkPatch(repo, patch, strip, true);
}

/** Unstages `paths` (back to HEAD) without touching the working tree. */
export async function unstagePaths(repo: Repository, paths: string[]): Promise<void> {
  if (!paths.length) return;
  await repo.exec([LIT, 'reset', '-q', '--pathspec-from-file=-', '--pathspec-file-nul'], { input: paths.join('\0'), allowFail: true });
}

/** Status entries (no ignored/conflicted) for the given files, all when `paths` is undefined. */
export async function changedEntries(repo: Repository, paths?: string[]): Promise<StatusEntry[]> {
  const st = await repo.status();
  return st.entries.filter((e) => e.kind !== '!' && e.kind !== 'U' && (!paths || under(e.path, paths) || (!!e.oldPath && under(e.oldPath, paths))));
}
