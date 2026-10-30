// Git operations behind the file-level commit actions (Add, Rollback…, Add to .gitignore). All mutating calls go
// through repo.exec.
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import type { RunOptions } from '../../core/git';
import type { Repository } from '../../core/repository';
import { appendIgnoreLines, commonIgnoreDirs, ignoreEntry, relativeTo, rollbackPlan } from './logic';
import type { Item } from './protocol';

/** Pathspecs are always literal (file names may contain glob characters). */
const LITERAL: RunOptions = { env: { GIT_LITERAL_PATHSPECS: '1' } };
const CHUNK = 400;

/** Runs `args -- <paths>` in chunks so long path lists don't exceed the command line limit. */
export async function execPaths(repo: Repository, args: string[], paths: readonly string[]): Promise<void> {
  for (let i = 0; i < paths.length; i += CHUNK) await repo.exec([...args, '--', ...paths.slice(i, i + CHUNK)], LITERAL);
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
