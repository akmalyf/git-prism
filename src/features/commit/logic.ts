// Pure helpers of the file-level commit actions: rollback plans and .gitignore entries. Unit tested in logic.test.ts.
import type { Item } from './protocol';

export interface RollbackPlan {
  /** `git restore --source=HEAD --staged --worktree` */
  restore: string[];
  /** `git restore --worktree` (back to the index; staging area "Unstaged" items) */
  restoreWorktree: string[];
  /** `git rm --cached -f` (added files) */
  unstageAdded: string[];
  /** files to delete from disk afterwards */
  remove: string[];
}

/** How to roll back changes of one repository. */
export function rollbackPlan(items: readonly Item[], o: { hasHead: boolean; deleteAdded: boolean }): RollbackPlan {
  const plan: RollbackPlan = { restore: [], restoreWorktree: [], unstageAdded: [], remove: [] };
  const add = (list: string[], p: string) => {
    if (!list.includes(p)) list.push(p);
  };
  for (const it of items) {
    if (it.area === 'untracked' || it.area === 'ignored') continue;
    if (it.area === 'unstaged') {
      add(plan.restoreWorktree, it.path);
      continue;
    }
    const added = !o.hasHead || it.kind === 'A' || it.kind === 'C';
    if (it.kind === 'R' && o.hasHead) {
      if (it.oldPath) add(plan.restore, it.oldPath);
      add(plan.unstageAdded, it.path);
      add(plan.remove, it.path);
    } else if (added) {
      add(plan.unstageAdded, it.path);
      if (o.deleteAdded) add(plan.remove, it.path);
    } else {
      add(plan.restore, it.path);
    }
  }
  return plan;
}

/** Escapes a path for a .gitignore line (leading '#'/'!', glob characters, trailing spaces). */
export function escapeIgnore(p: string): string {
  let s = p.replace(/[\\*?[\]]/g, (c) => '\\' + c);
  if (/^[#!]/.test(s)) s = '\\' + s;
  s = s.replace(/ +$/, (m) => m.replace(/ /g, '\\ '));
  return s;
}

/** .gitignore line for a path relative to the ignore file's directory (anchored with a leading '/'). */
export function ignoreEntry(relToIgnoreDir: string, isDir = false): string {
  const p = relToIgnoreDir.replace(/\/+$/, '');
  return `/${escapeIgnore(p)}${isDir || relToIgnoreDir.endsWith('/') ? '/' : ''}`;
}

/** Appends lines to ignore file content, skipping lines that are already present. */
export function appendIgnoreLines(existing: string, lines: readonly string[]): string {
  const have = new Set(existing.split(/\r?\n/).map((l) => l.trim()));
  const add = lines.filter((l, i) => !have.has(l) && lines.indexOf(l) === i);
  if (!add.length) return existing;
  const eol = existing.includes('\r\n') ? '\r\n' : '\n';
  const base = existing.length && !existing.endsWith('\n') ? existing + eol : existing;
  return base + add.join(eol) + eol;
}

/** Directories (repo-relative, '' = root) whose .gitignore could hold an entry for every given path. */
export function commonIgnoreDirs(paths: readonly string[]): string[] {
  if (!paths.length) return [''];
  const dirsOf = (p: string) => {
    const segs = p.replace(/\/+$/, '').split('/').slice(0, -1);
    const out = [''];
    for (let i = 1; i <= segs.length; i++) out.push(segs.slice(0, i).join('/'));
    return out;
  };
  let common = dirsOf(paths[0]);
  for (const p of paths.slice(1)) {
    const d = new Set(dirsOf(p));
    common = common.filter((x) => d.has(x));
  }
  return common;
}

/** Path relative to a repo-relative directory ('' = root). */
export function relativeTo(dir: string, path: string): string {
  return dir ? path.slice(dir.length + 1) : path;
}
