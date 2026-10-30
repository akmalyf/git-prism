// Pure helpers of the branches feature (no vscode imports): ref-name validation like `git check-ref-format`,
// branch classification, recent checkouts from the reflog, worktree/merge-status parsing, popup grouping.
import type { Ref } from '../../core/types';

/** Why `name` is not a valid ref name component sequence (git check-ref-format rules), or undefined if it is. */
export function refFormatProblem(name: string): string | undefined {
  if (!name) return 'empty';
  if (name === '@') return 'reserved';
  if (name.startsWith('-')) return 'starts with -';
  if (name.endsWith('/') || name.endsWith('.')) return 'bad end';
  if (name.includes('..') || name.includes('@{') || name.includes('//')) return 'bad sequence';
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x20\x7f~^:?*[\\]/.test(name)) return 'bad character';
  for (const part of name.split('/')) {
    if (!part || part.startsWith('.') || part.endsWith('.lock')) return 'bad component';
  }
  return undefined;
}

/** Replaces characters git forbids in branch names with `symbol` (IntelliJ's "Branch name cleanup symbol"). */
export function cleanupBranchName(name: string, symbol = '_'): string {
  // eslint-disable-next-line no-control-regex
  let s = name.trim().replace(/[\x00-\x20\x7f~^:?*[\\]+/g, symbol);
  s = s.replace(/\.{2,}/g, '.').replace(/@\{/g, `@${symbol}`).replace(/\/{2,}/g, '/');
  s = s
    .split('/')
    .map((p) => p.replace(/^\.+/, '').replace(/\.lock$/, `${symbol}lock`))
    .join('/');
  return s.replace(/^-+/, '').replace(/[/.]+$/, '');
}

export interface BranchNameContext {
  /** existing local branch names */
  locals: string[];
  /** existing remote branch short names (origin/main) */
  remotes: string[];
  /** the name being replaced (rename) — never reported as existing */
  current?: string;
}

export type BranchNameCheck = { error: string } | { exists: true } | { ok: true };

/** Validates a new branch name with IntelliJ's messages (new.branch.dialog.error.*). */
export function checkBranchName(name: string, c: BranchNameContext): BranchNameCheck {
  if (!name) return { error: 'Specify name for the new branch' };
  if (name === 'HEAD') return { error: 'HEAD is a reserved keyword' };
  if (refFormatProblem(name)) return { error: `Branch name ${name} is not valid` };
  if (name === c.current) return { ok: true };
  if (c.locals.includes(name)) return { exists: true };
  if (c.remotes.includes(name)) return { error: `Branch name ${name} conflicts with remote branch with the same name` };
  for (const l of c.locals) {
    if (l === c.current) continue;
    if (l.startsWith(name + '/') || name.startsWith(l + '/')) {
      return { error: `Branch name ${name} conflicts with local branch directory with the same name` };
    }
  }
  return { ok: true };
}

export type RefKind = 'local' | 'remote' | 'tag' | 'revision';

export interface ClassifiedRef {
  kind: RefKind;
  /** short name (main, origin/main, v1.0) or the revision as given */
  name: string;
  ref?: Ref;
}

/** Resolves a user/contract supplied ref (short or full name) against the repository's refs. Local wins over remote over tag. */
export function classifyRef(input: string, refs: Ref[]): ClassifiedRef {
  const byFull = refs.find((r) => r.name === input);
  if (byFull) return { kind: kindOf(byFull), name: byFull.short, ref: byFull };
  for (const type of ['head', 'remote', 'tag'] as const) {
    const r = refs.find((x) => x.type === type && x.short === input);
    if (r) return { kind: kindOf(r), name: r.short, ref: r };
  }
  return { kind: 'revision', name: input };
}

function kindOf(r: Ref): RefKind {
  return r.type === 'head' ? 'local' : r.type === 'remote' ? 'remote' : r.type === 'tag' ? 'tag' : 'revision';
}

/** 'origin/feature/x' → { remote: 'origin', branch: 'feature/x' } (remote names may not contain '/', like IntelliJ assumes). */
export function splitRemoteBranch(short: string, remotes: string[] = []): { remote: string; branch: string } {
  const known = remotes.filter((r) => short.startsWith(r + '/')).sort((a, b) => b.length - a.length)[0];
  if (known) return { remote: known, branch: short.slice(known.length + 1) };
  const i = short.indexOf('/');
  return i < 0 ? { remote: '', branch: short } : { remote: short.slice(0, i), branch: short.slice(i + 1) };
}

/** Branch names checked out recently (newest first) from `git reflog --format=%gs` output. */
export function parseRecentCheckouts(reflog: string): string[] {
  const res: string[] = [];
  for (const line of reflog.split('\n')) {
    const m = /^checkout: moving from (.+) to (.+)$/.exec(line.trim());
    if (!m) continue;
    for (const name of [m[2], m[1]]) if (!res.includes(name)) res.push(name);
  }
  return res;
}

/** Recent branches for the popup: existing local branches from the reflog, without the current one. */
export function recentBranches(reflog: string, locals: string[], current: string | undefined, limit = 5): string[] {
  return parseRecentCheckouts(reflog)
    .filter((b) => b !== current && locals.includes(b))
    .slice(0, limit);
}

export interface Worktree {
  path: string;
  head?: string;
  /** short branch name; undefined when detached */
  branch?: string;
  bare?: boolean;
  detached?: boolean;
  locked?: string;
  prunable?: string;
  /** the first entry = the main worktree */
  main: boolean;
}

/** Parses `git worktree list --porcelain`. */
export function parseWorktrees(out: string): Worktree[] {
  const res: Worktree[] = [];
  for (const block of out.split(/\n\n+/)) {
    const lines = block.split('\n').filter(Boolean);
    if (!lines.length || !lines[0].startsWith('worktree ')) continue;
    const w: Worktree = { path: lines[0].slice(9), main: res.length === 0 };
    for (const l of lines.slice(1)) {
      const sp = l.indexOf(' ');
      const key = sp < 0 ? l : l.slice(0, sp);
      const val = sp < 0 ? '' : l.slice(sp + 1);
      if (key === 'HEAD') w.head = val;
      else if (key === 'branch') w.branch = val.replace(/^refs\/heads\//, '');
      else if (key === 'bare') w.bare = true;
      else if (key === 'detached') w.detached = true;
      else if (key === 'locked') w.locked = val || 'locked';
      else if (key === 'prunable') w.prunable = val || 'prunable';
    }
    res.push(w);
  }
  return res;
}

/** File list from git's "Your local changes to the following files would be overwritten by checkout:" style errors. */
export function parseOverwrittenFiles(stderr: string): { kind: 'local' | 'untracked'; files: string[] } | undefined {
  const m = /(local changes to the following files|untracked working tree files) would be (?:overwritten|removed) by \w+:\n((?:\t.*\n?)+)/.exec(stderr);
  if (!m) return undefined;
  const files = m[2]
    .split('\n')
    .map((l) => unquotePath(l.trim()))
    .filter(Boolean);
  return { kind: m[1].startsWith('untracked') ? 'untracked' : 'local', files };
}

/** Undoes git's C-style path quoting (core.quotePath): "\"d\\303\\251j\\303\\240.txt\"" → "déjà.txt". */
export function unquotePath(p: string): string {
  if (p.length < 2 || !p.startsWith('"') || !p.endsWith('"')) return p;
  const bytes: number[] = [];
  const body = p.slice(1, -1);
  const esc: Record<string, number> = { n: 10, t: 9, r: 13, a: 7, b: 8, f: 12, v: 11, '"': 34, '\\': 92 };
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch === '\\' && i + 1 < body.length) {
      const o = /^[0-7]{3}/.exec(body.slice(i + 1));
      if (o) {
        bytes.push(parseInt(o[0], 8));
        i += 3;
        continue;
      }
      const e = esc[body[i + 1]];
      if (e !== undefined) {
        bytes.push(e);
        i++;
        continue;
      }
    }
    for (const b of new TextEncoder().encode(ch)) bytes.push(b);
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
}

/** "↑2 ↓1" (outgoing, incoming) like the branch popup / status bar; empty when in sync. */
export function syncText(ahead?: number, behind?: number): string {
  return [ahead ? `↑${ahead}` : '', behind ? `↓${behind}` : ''].filter(Boolean).join(' ');
}

/** IntelliJ-style tooltip for incoming/outgoing commits. */
export function syncTooltip(ahead?: number, behind?: number): string | undefined {
  const pl = (n: number) => (n === 1 ? 'commit' : 'commits');
  if (ahead && behind) return `${behind} incoming and ${ahead} outgoing commits`;
  if (behind) return `${behind} incoming ${pl(behind)}`;
  if (ahead) return `${ahead} outgoing ${pl(ahead)}`;
  return undefined;
}

export interface StatusBarInput {
  repoName: string;
  multiRepo: boolean;
  branch?: string;
  head?: string;
  ahead?: number;
  behind?: number;
}

/** Text of the status bar branch widget. */
export function statusBarText(s: StatusBarInput): string {
  const name = s.branch ?? (s.head ? s.head.slice(0, 8) : 'HEAD');
  const sync = syncText(s.ahead, s.behind);
  return `$(git-branch) ${s.multiRepo ? `${s.repoName} / ` : ''}${name}${sync ? ` ${sync}` : ''}`;
}

/** Directory of a branch name for grouping ('feature/a/b' → 'feature/a'; '' for top-level). */
export function branchDir(name: string): string {
  const i = name.lastIndexOf('/');
  return i < 0 ? '' : name.slice(0, i);
}

/** Sorts names so that each directory's entries are contiguous: top-level names first, then directories alphabetically. */
export function sortForGrouping(names: string[]): string[] {
  return [...names].sort((a, b) => {
    const da = branchDir(a);
    const db = branchDir(b);
    if (da !== db) {
      if (!da) return -1;
      if (!db) return 1;
      return da.localeCompare(db);
    }
    return a.localeCompare(b);
  });
}

/** Favorite state of a full ref name: explicit marks win, else main/master branches are favorites by default (like IntelliJ). */
export function isFavorite(fullName: string, fav: { add: string[]; remove: string[] }): boolean {
  if (fav.remove.includes(fullName)) return false;
  if (fav.add.includes(fullName)) return true;
  return /^refs\/heads\/(main|master)$/.test(fullName) || /^refs\/remotes\/[^/]+\/(main|master)$/.test(fullName);
}

/** Toggles a favorite and returns the new marks. */
export function toggleFavorite(fullName: string, fav: { add: string[]; remove: string[] }): { add: string[]; remove: string[] } {
  const now = isFavorite(fullName, fav);
  const add = fav.add.filter((n) => n !== fullName);
  const remove = fav.remove.filter((n) => n !== fullName);
  if (now) remove.push(fullName);
  else add.push(fullName);
  return { add, remove };
}

export interface CleanupCandidate {
  name: string;
  merged: boolean;
  gone: boolean;
  upstream?: string;
  date?: number;
}

/**
 * Local branches worth cleaning up: merged into the target branch or whose upstream is gone.
 * `forEachRef` = `git for-each-ref --format=%(refname:short)%1f%(upstream:short)%1f%(upstream:track)%1f%(committerdate:unix) refs/heads`
 * `merged` = names from `git for-each-ref --merged <target> --format=%(refname:short) refs/heads`.
 */
export function cleanupCandidates(forEachRef: string, merged: string[], exclude: string[]): CleanupCandidate[] {
  const res: CleanupCandidate[] = [];
  for (const line of forEachRef.split('\n')) {
    if (!line) continue;
    const [name, upstream, track, date] = line.split('\x1f');
    if (exclude.includes(name)) continue;
    const isMerged = merged.includes(name);
    const gone = track === '[gone]';
    if (!isMerged && !gone) continue;
    res.push({ name, merged: isMerged, gone, upstream: upstream || undefined, date: +date || undefined });
  }
  return res.sort((a, b) => a.name.localeCompare(b.name));
}

/** Directory name for a clone of `url` ("https://h/x/repo.git" → "repo"). */
export function cloneDirName(url: string): string {
  const s = url.trim().replace(/[\\/]+$/, '').replace(/\.git$/, '');
  const m = /[\\/:]([^\\/:]+)$/.exec(s);
  return (m ? m[1] : s) || 'repository';
}

/** Default worktree folder name for a branch: "<repo>-<branch with / → ->". */
export function worktreeDirName(repoName: string, ref: string): string {
  return `${repoName}-${ref.replace(/[\\/:*?"<>|\s]+/g, '-').replace(/^-+|-+$/g, '')}`;
}

/** Remote name validation with IntelliJ's messages (remotes.define.*). */
export function checkRemoteName(name: string, existing: string[], current?: string): string | undefined {
  if (!name.trim()) return 'Remote name cannot be empty';
  if (name.includes('/') || refFormatProblem(name)) return 'Remote name contains illegal characters';
  if (name !== current && existing.includes(name)) return `Remote name '${name}' is already used`;
  return undefined;
}
