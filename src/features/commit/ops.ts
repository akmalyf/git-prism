// Git operations behind the Commit tool window: commit (changelists / staging area / amend of a specific commit /
// partial commit of changed lines through a temporary index),
// rollback, stage / unstage, accept theirs / yours, add, .gitignore, patches. All mutating calls go through repo.exec.
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { GitError, type RunOptions } from '../../core/git';
import type { Repository } from '../../core/repository';
import {
  acceptSide,
  amendBangCommitArgs,
  amendBangMessage,
  appendIgnoreLines,
  changelistCommitArgs,
  commitPaths,
  commonIgnoreDirs,
  ignoreEntry,
  isMissingSideError,
  relativeTo,
  rollbackPlan,
  stagingCommitArgs,
  subjectOf,
} from './logic';
import { buildPartialPatch, parseZeroDiff, type FileDiff } from './partial';
import type { CommitInfo, CommitOptions, Item } from './protocol';

/** Pathspecs are always literal (file names may contain glob characters). */
const LITERAL: RunOptions = { env: { GIT_LITERAL_PATHSPECS: '1' } };
const CHUNK = 400;

/** Runs `args -- <paths>` in chunks so long path lists don't exceed the command line limit. */
export async function execPaths(repo: Repository, args: string[], paths: readonly string[]): Promise<void> {
  for (let i = 0; i < paths.length; i += CHUNK) await repo.exec([...args, '--', ...paths.slice(i, i + CHUNK)], LITERAL);
}

async function withMessageFile<T>(message: string, fn: (file: string) => Promise<T>): Promise<T> {
  const file = path.join(os.tmpdir(), `jbgit-commit-${crypto.randomBytes(6).toString('hex')}.txt`);
  await fsp.writeFile(file, message, 'utf8');
  try {
    return await fn(file);
  } finally {
    await fsp.rm(file, { force: true });
  }
}

/**
 * Changelist commit of one repository: exactly the given items' working tree state (`git commit --only`).
 * During a merge (partial commits are impossible) the items are staged and the whole index is committed.
 */
export async function commitItems(
  repo: Repository,
  items: readonly Item[],
  o: { message: string; amend: boolean; options: CommitOptions; merge: boolean; hasHead: boolean; excluded?: ReadonlyMap<string, ReadonlySet<string>> },
): Promise<void> {
  if (!o.merge && o.excluded?.size) {
    await withMessageFile(o.message, (file) =>
      commitThroughTempIndex(repo, items, o.excluded!, o.hasHead, stagingCommitArgs(file, { amend: o.amend, options: o.options, all: false })),
    );
    return;
  }
  const untracked = items.filter((i) => i.area === 'untracked').map((i) => i.path);
  await withAddedUntracked(repo, untracked, o.hasHead, async () => {
    const paths = commitPaths(items);
    if (o.merge && paths.length) await execPaths(repo, ['add', '-A'], paths);
    await withMessageFile(o.message, (file) =>
      repo.exec(changelistCommitArgs(file, { amend: o.amend, options: o.options, hasPaths: paths.length > 0, merge: o.merge }), {
        ...LITERAL,
        input: paths.length && !o.merge ? paths.join('\0') + '\0' : undefined,
      }),
    );
  });
}

/** Adds unversioned files for a commit; when the commit fails they are removed from the index again (stay unversioned). */
async function withAddedUntracked(repo: Repository, untracked: readonly string[], hasHead: boolean, fn: () => Promise<void>): Promise<void> {
  if (untracked.length) await execPaths(repo, ['add'], untracked);
  try {
    await fn();
  } catch (e) {
    if (untracked.length) {
      await execPaths(repo, hasHead ? ['reset', '-q'] : ['rm', '--cached', '-q', '--ignore-unmatch'], untracked).catch(() => undefined);
    }
    throw e;
  }
}

/** `git diff -U0` of a file's working tree against HEAD, parsed into hunks (partial commit). */
export async function fileDiff(repo: Repository, rel: string): Promise<FileDiff> {
  const r = await repo.run(['diff', '-U0', '--no-color', '--no-ext-diff', '--no-renames', 'HEAD', '--', rel], { ...LITERAL, quiet: true });
  return parseZeroDiff(r.stdout);
}

/**
 * Partial commit: builds a temporary index from HEAD plus the included changes (whole files with `git add -A`, files
 * with excluded lines with `git apply --cached --unidiff-zero` of the included lines), commits it with `commitArgs`
 * and then resets the real index entries of the committed paths to the new HEAD, so the excluded lines stay as local
 * changes and other staged files are untouched.
 */
export async function commitThroughTempIndex(
  repo: Repository,
  items: readonly Item[],
  excluded: ReadonlyMap<string, ReadonlySet<string>>,
  hasHead: boolean,
  commitArgs: string[],
): Promise<void> {
  const index = path.join(repo.gitDir, `jbgit-index-${crypto.randomBytes(6).toString('hex')}`);
  const env = { GIT_INDEX_FILE: index, GIT_LITERAL_PATHSPECS: '1' };
  const partial = items.filter((i) => excluded.get(i.path)?.size && i.area === 'changes' && i.kind === 'M');
  const whole = items.filter((i) => !partial.includes(i));
  try {
    await repo.run(hasHead ? ['read-tree', 'HEAD'] : ['read-tree', '--empty'], { env });
    const paths = commitPaths(whole);
    for (let i = 0; i < paths.length; i += CHUNK) await repo.run(['add', '-A', '--', ...paths.slice(i, i + CHUNK)], { env });
    for (const it of partial) {
      const patch = buildPartialPatch(await fileDiff(repo, it.path), excluded.get(it.path)!);
      if (patch) await repo.run(['apply', '--cached', '--unidiff-zero', '--whitespace=nowarn', '-'], { env, input: patch });
    }
    await repo.exec(commitArgs, { env });
  } finally {
    await fsp.rm(index, { force: true });
    await fsp.rm(`${index}.lock`, { force: true });
  }
  const all = commitPaths(items);
  for (let i = 0; i < all.length; i += CHUNK) await repo.exec(['reset', '-q', '--', ...all.slice(i, i + CHUNK)], { ...LITERAL, allowFail: true });
}

/** Staging area commit of one repository (the index, or all tracked changes with `all`). */
export async function commitIndex(repo: Repository, o: { message: string; amend: boolean; options: CommitOptions; all: boolean }): Promise<void> {
  await withMessageFile(o.message, (file) => repo.exec(stagingCommitArgs(file, o)));
}

export class AmendConflictError extends Error {}

/**
 * Amends a commit below HEAD: creates an "amend!" commit with the items and runs `rebase -i --autosquash` (with
 * autostash) from its parent. On conflicts the rebase is aborted and AmendConflictError is thrown; the amend!
 * commit stays (the caller may undo it with undoLastCommit).
 */
export async function amendSpecific(
  repo: Repository,
  target: string,
  items: readonly Item[],
  o: { message: string; options: CommitOptions; index: boolean; excluded?: ReadonlyMap<string, ReadonlySet<string>> },
): Promise<void> {
  const commit = await repo.commit(target);
  if (!o.index && o.excluded?.size) {
    await withMessageFile(amendBangMessage(commit.subject, o.message), (file) =>
      commitThroughTempIndex(repo, items, o.excluded!, true, amendBangCommitArgs(file, { options: o.options, hasPaths: false, index: true })),
    );
  } else {
    const untracked = o.index ? [] : items.filter((i) => i.area === 'untracked').map((i) => i.path);
    const paths = o.index ? [] : commitPaths(items);
    await withAddedUntracked(repo, untracked, true, () =>
      withMessageFile(amendBangMessage(commit.subject, o.message), async (file) => {
        await repo.exec(amendBangCommitArgs(file, { options: o.options, hasPaths: paths.length > 0, index: o.index }), {
          ...LITERAL,
          input: paths.length ? paths.join('\0') + '\0' : undefined,
        });
      }),
    );
  }
  const base = commit.parents.length ? [`${target}~1`] : ['--root'];
  const r = await repo.exec(['rebase', '-i', '--autosquash', '--autostash', ...base], { allowFail: true });
  if (r.code !== 0) {
    await repo.exec(['rebase', '--abort'], { allowFail: true });
    throw new AmendConflictError('Cannot amend commit due to conflicts. You can create an “amend!” commit and resolve conflicts manually during interactive rebase.');
  }
}

/** Undoes the last commit keeping its changes staged (used to drop an "amend!" commit). */
export async function undoLastCommit(repo: Repository): Promise<void> {
  await repo.exec(['reset', '--soft', 'HEAD~1']);
}

/** Full message of HEAD (for Amend). */
export async function headMessage(repo: Repository): Promise<string> {
  const r = await repo.run(['log', '-1', '--format=%B', 'HEAD'], { allowFail: true, quiet: true });
  return r.code === 0 ? r.stdout.replace(/\s+$/, '') : '';
}

/** Commits that can be amended: HEAD and its first-parent ancestors down to (excluding) the first merge commit. */
export async function amendableCommits(repo: Repository, max = 20): Promise<CommitInfo[]> {
  const r = await repo.run(['log', '--first-parent', `-n${max}`, '--format=%H%x1f%P%x1f%an%x1f%at%x1f%s', 'HEAD'], { allowFail: true, quiet: true });
  if (r.code !== 0) return [];
  const out: CommitInfo[] = [];
  for (const line of r.stdout.split('\n').filter(Boolean)) {
    const [hash, parents, author, date, subject] = line.split('\x1f');
    const merge = parents.split(' ').filter(Boolean).length > 1;
    out.push({ hash, subject, author, date: +date, merge });
    if (merge) break;
  }
  return out;
}

/** Rollback of changes (see rollbackPlan). */
export async function rollback(repo: Repository, items: readonly Item[], deleteAdded: boolean, hasHead: boolean): Promise<void> {
  const plan = rollbackPlan(items, { hasHead, deleteAdded });
  if (plan.restore.length) await execPaths(repo, ['restore', '--source=HEAD', '--staged', '--worktree'], plan.restore);
  if (plan.restoreWorktree.length) await execPaths(repo, ['restore', '--worktree'], plan.restoreWorktree);
  if (plan.unstageAdded.length) await execPaths(repo, ['rm', '--cached', '-f', '-q'], plan.unstageAdded);
  for (const p of plan.remove) await fsp.rm(repo.abs(p), { force: true, recursive: true });
  if (plan.remove.length) repo.fireChanged();
}

export async function stage(repo: Repository, paths: readonly string[]): Promise<void> {
  await execPaths(repo, ['add', '-A'], paths);
}

export async function unstage(repo: Repository, items: readonly Item[], hasHead: boolean): Promise<void> {
  const paths = commitPaths(items);
  if (hasHead) await execPaths(repo, ['restore', '--staged'], paths);
  else await execPaths(repo, ['rm', '--cached', '-r', '-q'], paths);
}

export async function stageAll(repo: Repository, trackedOnly: boolean): Promise<void> {
  await repo.exec(['add', trackedOnly ? '-u' : '-A']);
}

export async function unstageAll(repo: Repository, hasHead: boolean): Promise<void> {
  if (hasHead) await repo.exec(['reset', '-q']);
  else await repo.exec(['rm', '--cached', '-r', '-q', '--ignore-unmatch', '.']);
}

export async function acceptConflictSide(repo: Repository, items: readonly Item[], side: 'theirs' | 'ours'): Promise<void> {
  for (const it of items) {
    if (acceptSide(it.conflict, side) === 'rm') {
      await execPaths(repo, ['rm', '-q'], [it.path]);
      continue;
    }
    try {
      await execPaths(repo, ['checkout', `--${side}`], [it.path]);
    } catch (e) {
      // e.g. AU / UA: the chosen side has no version of the file → accepting it means removing the file
      if (e instanceof GitError && isMissingSideError(e.stderr)) {
        await execPaths(repo, ['rm', '-q', '-f'], [it.path]);
        continue;
      }
      throw e;
    }
    await execPaths(repo, ['add'], [it.path]);
  }
}

/** Unified diff of the items (working tree vs HEAD, or the staged / unstaged part in staging area mode). */
export async function patchText(repo: Repository, items: readonly Item[], hasHead: boolean): Promise<string> {
  const base = hasHead ? 'HEAD' : '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
  const opts = ['diff', '--no-color', '--no-ext-diff', '--binary', '-M'];
  const run = async (args: string[], paths: string[]) => {
    let out = '';
    for (let i = 0; i < paths.length; i += CHUNK) out += (await repo.run([...args, '--', ...paths.slice(i, i + CHUNK)], { ...LITERAL, allowFail: true })).stdout;
    return out;
  };
  const tracked = items.filter((i) => i.area === 'changes' || i.area === 'conflict');
  const staged = items.filter((i) => i.area === 'staged');
  const unstagedItems = items.filter((i) => i.area === 'unstaged');
  let out = '';
  if (tracked.length) out += await run([...opts, base], commitPaths(tracked));
  if (staged.length) out += await run([...opts, '--cached', base], commitPaths(staged));
  if (unstagedItems.length) out += await run(opts, commitPaths(unstagedItems));
  for (const it of items.filter((i) => i.area === 'untracked' || i.area === 'ignored')) {
    if (!fs.existsSync(repo.abs(it.path)) || fs.statSync(repo.abs(it.path)).isDirectory()) continue;
    out += (await repo.run(['diff', '--no-color', '--no-ext-diff', '--binary', '--no-index', '--', '/dev/null', it.path], { allowFail: true })).stdout;
  }
  return out;
}

export interface IgnoreTarget {
  label: string;
  /** absolute path of the ignore file */
  file: string;
  /** repo-relative directory the entries are relative to ('' = root) */
  dir: string;
  exists: boolean;
}

/** .gitignore files that can hold entries for all paths (existing ones up the tree + the root one) and .git/info/exclude. */
export function ignoreTargets(repo: Repository, paths: readonly string[]): IgnoreTarget[] {
  const out: IgnoreTarget[] = [];
  for (const dir of commonIgnoreDirs(paths).reverse()) {
    const rel = dir ? `${dir}/.gitignore` : '.gitignore';
    const file = repo.abs(rel);
    const exists = fs.existsSync(file);
    if (exists || !dir) out.push({ label: rel, file, dir, exists });
  }
  out.push({ label: '.git/info/exclude', file: path.join(repo.commonDir, 'info', 'exclude'), dir: '', exists: true });
  return out;
}

/** Appends ignore entries for `paths` to an ignore file (creating it and its directory when needed). */
export async function addToIgnore(repo: Repository, target: IgnoreTarget, paths: readonly string[]): Promise<void> {
  const lines = paths.map((p) => {
    let isDir = p.endsWith('/');
    try {
      isDir ||= fs.statSync(repo.abs(p)).isDirectory();
    } catch {
      /* deleted */
    }
    return ignoreEntry(relativeTo(target.dir, p), isDir);
  });
  let existing = '';
  try {
    existing = await fsp.readFile(target.file, 'utf8');
  } catch {
    await fsp.mkdir(path.dirname(target.file), { recursive: true });
  }
  const next = appendIgnoreLines(existing, lines);
  if (next !== existing) await fsp.writeFile(target.file, next, 'utf8');
  repo.fireChanged();
}

/** Author suggestions for the Commit Options "Author" field. */
export async function knownAuthors(repo: Repository): Promise<string[]> {
  const r = await repo.run(['log', '-n1000', '--format=%an <%ae>'], { allowFail: true, quiet: true });
  return [...new Set(r.stdout.split('\n').filter(Boolean))].slice(0, 200);
}

/** Subjects of the latest commits (shown under the recorded messages in Commit Message History). */
export async function recentMessages(repo: Repository, n = 30): Promise<string[]> {
  const r = await repo.run(['log', `-n${n}`, '--format=%B%x00'], { allowFail: true, quiet: true });
  return r.code === 0 ? r.stdout.split('\0').map((m) => m.trim()).filter(Boolean) : [];
}

export { subjectOf };

/** Moves files to the trash (Delete action). */
export async function deleteFiles(repo: Repository, paths: readonly string[]): Promise<void> {
  for (const p of paths) {
    const uri = vscode.Uri.file(repo.abs(p));
    try {
      await vscode.workspace.fs.delete(uri, { recursive: true, useTrash: true });
    } catch (e) {
      if (fs.existsSync(uri.fsPath)) throw new Error(`Cannot delete file: ${p}${e instanceof Error ? ` (${e.message})` : ''}`);
    }
  }
  repo.fireChanged();
}

/** Mode and blob of the stage-0 index entry of a path (undefined: not in the index or conflicted). */
export async function indexEntry(repo: Repository, rel: string): Promise<{ mode: string; hash: string } | undefined> {
  const out = (await repo.run(['ls-files', '-s', '-z', '--', rel], { ...LITERAL, quiet: true })).stdout;
  for (const line of out.split('\0')) {
    const m = /^(\d{6}) ([0-9a-f]+) (\d)\t(.*)$/.exec(line);
    if (m && m[3] === '0' && m[4] === rel) return { mode: m[1], hash: m[2] };
  }
  return undefined;
}

/** Replaces the staged content of a path (the index entry keeps its mode); clean filters apply through --path. */
export async function writeIndexContent(repo: Repository, rel: string, text: string): Promise<void> {
  const entry = await indexEntry(repo, rel);
  if (!entry) throw new Error(`${rel} is not in the index`);
  const hash = (await repo.run(['hash-object', '-w', '--stdin', `--path=${rel}`], { input: text })).stdout.trim();
  if (hash === entry.hash) return;
  await repo.exec(['update-index', '--cacheinfo', `${entry.mode},${hash},${rel}`]);
}
