// Pure helpers of the stash / shelf feature: classifying git output of unstash / apply, merging the file lists of
// a stash's commits, shelf naming and ids.
import type { FileChange } from '../../core/types';
import type { StashFile } from './protocol';

export type ApplyOutcome = 'ok' | 'conflict' | 'index-conflict' | 'local-changes' | 'untracked' | 'error';

/** What happened in `git stash apply|pop|branch` / `git apply --3way`, judged from exit code and output. */
export function classifyApply(code: number, stdout: string, stderr: string): ApplyOutcome {
  const out = `${stdout}\n${stderr}`;
  if (/Conflicts in index\. Try without --index/i.test(out)) return 'index-conflict';
  if (/^CONFLICT \(/m.test(out) || /with conflicts\.?$/m.test(out) || /^U .+$/m.test(stderr)) return 'conflict';
  if (code === 0) return 'ok';
  if (/untracked working tree files? would be overwritten|already exists, no checkout|could not restore untracked files/i.test(out)) return 'untracked';
  if (/local changes to the following files would be overwritten|does not match index|needs merge/i.test(out)) return 'local-changes';
  return 'error';
}

/** Paths listed by git after "would be overwritten" errors (tab indented lines). */
export function overwrittenPaths(stderr: string): string[] {
  return stderr
    .split('\n')
    .filter((l) => /^\t\S/.test(l))
    .map((l) => l.trim());
}

/**
 * Files of a stash: working tree changes (stash^1..stash), changes that only live in the index (stash^1..stash^2)
 * and untracked files (the root commit stash^3). Tracked changes win over index-only entries of the same path.
 */
export function mergeStashFiles(tracked: FileChange[], index: FileChange[], untracked: FileChange[]): StashFile[] {
  const out = new Map<string, StashFile>();
  for (const c of tracked) out.set(c.path, { ...c, source: 'tracked' });
  for (const c of index) if (!out.has(c.path)) out.set(c.path, { ...c, source: 'index' });
  for (const c of untracked) if (!out.has(c.path)) out.set(c.path, { path: c.path, kind: '?', source: 'untracked' });
  return [...out.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/** "Changes" → "Changes (2)" … unique among existing names (case-insensitive), like IntelliJ's shelf names. */
export function uniqueName(name: string, existing: Iterable<string>): string {
  const taken = new Set([...existing].map((n) => n.toLowerCase()));
  const base = name.trim() || 'Changes';
  if (!taken.has(base.toLowerCase())) return base;
  for (let i = 2; ; i++) {
    const n = `${base} (${i})`;
    if (!taken.has(n.toLowerCase())) return n;
  }
}

/** Directory name of a new shelf: sortable timestamp + random suffix. */
export function newShelfId(now: Date = new Date(), rnd: () => number = Math.random): string {
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  const stamp = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
  return `${stamp}-${Math.floor(rnd() * 0xffffff).toString(16).padStart(6, '0')}`;
}

/** First line of a (multi-line) message, trimmed; used as the shelf name. */
export function firstLine(text: string): string {
  return (text.split('\n').find((l) => l.trim()) ?? '').trim();
}

/** File name for a patch: the name with characters that are invalid in file names replaced. */
export function patchFileName(name: string): string {
  const base = firstLine(name).replace(/[\\/:*?"<>|\x00-\x1f\s]+/g, '_').replace(/^\.+/, '').slice(0, 80);
  return `${base || 'Changes'}.patch`;
}

/** Git branch name check (subset of git check-ref-format rules used to validate "As new branch"). */
export function branchNameError(name: string): string | undefined {
  const n = name.trim();
  if (!n) return undefined;
  if (/[\s~^:?*[\\\x00-\x1f\x7f]/.test(n) || n.includes('..') || n.includes('@{') || n.startsWith('-') || n.startsWith('/') || n.endsWith('/') || n.endsWith('.') || n.endsWith('.lock') || n.includes('//') || n === '@') {
    return `Invalid branch name: ${n}`;
  }
  return undefined;
}
