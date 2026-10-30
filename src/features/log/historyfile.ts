// File History (pure): which change of a commit is "the file" of a history tab (following renames), and the
// change between two revisions of that file for "Compare" (two rows selected).
import type { ChangeKind, FileChange } from '../../core/types';

/** Whether `p` is one of `paths` or lies inside one of them ('.' = the whole repository). */
export function insidePaths(p: string | undefined, paths: readonly string[]): boolean {
  if (!p) return false;
  return paths.some((a) => a === '.' || p === a || p.startsWith(a + '/'));
}

/** Changes of a commit limited to the history paths (old and new names both count). */
export function affectedFiles(files: readonly FileChange[], paths: readonly string[]): FileChange[] {
  return files.filter((f) => insidePaths(f.path, paths) || insidePaths(f.oldPath, paths));
}

/**
 * The change of the single history file in a commit. `names` are the file's names, current first, then older names
 * (git log --follow). Returns undefined when the commit doesn't touch the file (e.g. a merge).
 */
export function historyChange(files: readonly FileChange[], names: readonly string[]): FileChange | undefined {
  for (const n of names) {
    const f = files.find((x) => x.path === n) ?? files.find((x) => x.oldPath === n);
    if (f) return f;
  }
  return undefined;
}

/** Path of the file at the revision: the changed path, else the first of `present` (names existing there). */
export function pathAtRevision(change: FileChange | undefined, present: readonly string[]): { path?: string; deleted: boolean } {
  if (change) return { path: change.path, deleted: change.kind === 'D' };
  return present.length ? { path: present[0], deleted: false } : { deleted: true };
}

/** The file between an older and a newer revision ("Compare" of two history rows). */
export function compareChange(older: string | undefined, newer: string | undefined): FileChange | undefined {
  if (!older && !newer) return undefined;
  let kind: ChangeKind = 'M';
  if (!older) kind = 'A';
  else if (!newer) kind = 'D';
  else if (older !== newer) kind = 'R';
  const path = (newer ?? older)!;
  const out: FileChange = { path, kind };
  if (kind === 'R') out.oldPath = older;
  return out;
}
