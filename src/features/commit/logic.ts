// Pure helpers of the Commit tool window: git argument lists, rollback / conflict plans, diff sides, .gitignore
// entries, notification texts and the commit message history. Unit tested in logic.test.ts.
import type { ContentRef, DiffFile } from '../../core/contracts';
import type { ChangeKind, OperationState } from '../../core/types';
import type { CommitOptions, Item } from './protocol';

export { validateCommit, validateStagedCommit } from './protocol';

/** Operations during which git refuses partial commits (`--only <paths>`): the whole index must be committed. */
export function partialCommitImpossible(op: OperationState): boolean {
  return op === 'merge' || op === 'cherry-pick' || op === 'revert';
}

/** `git commit` arguments of the temporary "amend!" commit (changelist mode: --only the paths; staging area: the index). */
export function amendBangCommitArgs(msgFile: string, o: { options: CommitOptions; hasPaths: boolean; index: boolean }): string[] {
  const args = ['commit', '--allow-empty'];
  if (!o.index) args.push('--only');
  args.push(...commitOptionArgs(o.options), '-F', msgFile);
  if (o.hasPaths && !o.index) args.push('--pathspec-from-file=-', '--pathspec-file-nul');
  return args;
}

/** True when `git checkout --ours/--theirs` failed because that side of the conflict has no version (deleted / not added). */
export function isMissingSideError(stderr: string): boolean {
  return /does not have (our|their) version/.test(stderr);
}

/** Option flags of `git commit` (author, sign-off, GPG, hooks). */
export function commitOptionArgs(o: CommitOptions): string[] {
  const args: string[] = [];
  if (o.author.trim()) args.push(`--author=${o.author.trim()}`);
  if (o.signOff) args.push('--signoff');
  if (o.gpgSign) args.push('--gpg-sign');
  if (!o.runHooks) args.push('--no-verify');
  return args;
}

/** Paths a changelist commit has to pass to `git commit --only`: both sides of renames. */
export function commitPaths(items: readonly Item[]): string[] {
  const out = new Set<string>();
  for (const it of items) {
    out.add(it.path);
    if (it.oldPath) out.add(it.oldPath);
  }
  return [...out];
}

/**
 * `git commit` arguments for a changelist commit. `paths` is fed on stdin (NUL separated) to stay below the
 * command line limit; an amend without paths only rewrites the message.
 */
export function changelistCommitArgs(msgFile: string, o: { amend: boolean; options: CommitOptions; hasPaths: boolean; merge: boolean }): string[] {
  const args = ['commit'];
  if (!o.merge) args.push('--only');
  if (o.amend) args.push('--amend');
  args.push(...commitOptionArgs(o.options), '-F', msgFile);
  if (o.hasPaths && !o.merge) args.push('--pathspec-from-file=-', '--pathspec-file-nul');
  return args;
}

/** `git commit` arguments for the staging area mode. */
export function stagingCommitArgs(msgFile: string, o: { amend: boolean; options: CommitOptions; all: boolean }): string[] {
  const args = ['commit'];
  if (o.all) args.push('--all');
  if (o.amend) args.push('--amend');
  args.push(...commitOptionArgs(o.options), '-F', msgFile);
  return args;
}

/** Message of an "amend!" commit that `rebase --autosquash` folds into the target, replacing its message. */
export function amendBangMessage(targetSubject: string, message: string): string {
  return `amend! ${targetSubject}\n\n${message.trim()}\n`;
}

export function subjectOf(message: string): string {
  return message.trim().split('\n')[0]?.trim() ?? '';
}

export function filesCommittedText(n: number, subject: string): string {
  return `${n === 0 ? 'No files' : n === 1 ? '1 file' : `${n} files`} committed: ${subject}`;
}

/** Commit message history: newest first, unique, at most `max`. */
export function pushHistory(history: readonly string[], message: string, max = 30): string[] {
  const m = message.trim();
  if (!m) return [...history];
  return [m, ...history.filter((h) => h.trim() !== m)].slice(0, max);
}

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

/** Accept Theirs / Accept Yours for an unmerged path: take one side, or remove the file when that side deleted it. */
export function acceptSide(conflict: string | undefined, side: 'theirs' | 'ours'): 'checkout' | 'rm' {
  const c = conflict ?? 'UU';
  // XY: X = ours ("us"), Y = theirs ("them"); D = deleted on that side
  const deleted = side === 'ours' ? c[0] === 'D' : c[1] === 'D';
  return deleted ? 'rm' : 'checkout';
}

const EMPTY: ContentRef = { empty: true };

/** Left/right sides of the diff for a Commit view item (changelist or staging area mode). */
export function diffSides(it: Item, hasHead: boolean): { left: ContentRef; right: ContentRef; leftTitle?: string; rightTitle?: string } {
  const head = (p: string): ContentRef => (hasHead ? { rev: 'HEAD', path: p } : EMPTY);
  const wt: ContentRef = { worktree: true, path: it.path };
  const idx = (p: string): ContentRef => ({ index: true, path: p });
  switch (it.area) {
    case 'untracked':
    case 'ignored':
      return { left: EMPTY, right: wt };
    case 'conflict':
      return { left: head(it.path), right: wt };
    case 'staged': {
      const left = it.kind === 'A' || it.kind === 'C' ? EMPTY : head(it.oldPath ?? it.path);
      return { left, right: it.kind === 'D' ? EMPTY : idx(it.path), leftTitle: hasHead ? 'HEAD' : undefined, rightTitle: 'Staged' };
    }
    case 'unstaged':
      return { left: idx(it.path), right: it.kind === 'D' ? EMPTY : wt, leftTitle: 'Staged', rightTitle: 'Local' };
    default: {
      const left = it.kind === 'A' || it.kind === 'C' ? EMPTY : head(it.oldPath ?? it.path);
      return { left, right: it.kind === 'D' ? EMPTY : wt };
    }
  }
}

/** Staging area compare actions: Compare with Staged Version (local ↔ staged), with Local Version (staged ↔ local), with HEAD Version (HEAD ↔ staged). */
export function stageDiffFile(it: Item, op: 'compareLocalStaged' | 'compareStagedLocal' | 'compareStagedHead', hasHead: boolean): DiffFile {
  const idx: ContentRef = { index: true, path: it.path };
  const wt: ContentRef = { worktree: true, path: it.path };
  const file = { repoRoot: it.repo, path: it.path, oldPath: it.oldPath, kind: it.kind as ChangeKind };
  if (op === 'compareStagedHead') {
    const left: ContentRef = hasHead && it.kind !== 'A' && it.kind !== 'C' ? { rev: 'HEAD', path: it.oldPath ?? it.path } : EMPTY;
    return { ...file, left, right: it.kind === 'D' && it.area === 'staged' ? EMPTY : idx, leftTitle: 'HEAD', rightTitle: 'Staged' };
  }
  const deletedLocally = it.area === 'unstaged' && it.kind === 'D';
  const stagedGone = it.area === 'staged' && it.kind === 'D';
  return { ...file, oldPath: undefined, left: stagedGone ? EMPTY : idx, right: deletedLocally ? EMPTY : wt, leftTitle: 'Staged', rightTitle: 'Local' };
}

export function diffFile(it: Item, hasHead: boolean): DiffFile {
  return { repoRoot: it.repo, path: it.path, oldPath: it.oldPath, kind: it.kind as ChangeKind, ...diffSides(it, hasHead) };
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
