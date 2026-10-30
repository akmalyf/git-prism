// Pure Git Log query logic (no vscode/node imports): log filters → `git rev-list` arguments, rev-list output
// parsing, hash-like text detection, author patterns for the User filter and merging several repositories' commit
// lists into one table (IntelliJ shows all roots in one log).
import type { LogFilters, SortType, UserIdentity } from './protocol';

/** IntelliJ VcsLogUtil hash pattern: a text filter made of such words also matches commits by hash prefix. */
const HASH_WORD = /^[0-9a-fA-F]{7,40}$/;

export interface QuerySpec {
  sort: SortType;
  firstParent: boolean;
  /** full ref names / 'HEAD' to start from; undefined = all branches, remotes, tags (+ HEAD when it exists) */
  refs?: string[];
  hasHead: boolean;
  /** author patterns (extended regex) built by authorPatterns() */
  authors: string[];
  since?: number;
  until?: number;
  text?: string;
  regex?: boolean;
  matchCase?: boolean;
  /** repo-relative paths */
  paths: string[];
  /** file history semantics (--full-history --simplify-merges) instead of the default simplified history */
  history: boolean;
  /** max commits (-n), 0 = all */
  limit: number;
}

/** Text/user/date filters change the graph structure: the matching commits are shown as a plain line. */
export function isStructureChanging(f: LogFilters): boolean {
  return !!(f.text?.trim() || f.users?.length || f.since || f.until);
}

export function hasAnyFilter(f: LogFilters): boolean {
  return !!(isStructureChanging(f) || f.branches?.length || f.paths?.length || f.roots?.length);
}

/** Words of a text filter if ALL of them look like (abbreviated) hashes, else []. */
export function hashWords(text: string | undefined): string[] {
  const words = (text ?? '').split(/[\s,;]+/).filter(Boolean);
  return words.length && words.every((w) => HASH_WORD.test(w)) ? words.map((w) => w.toLowerCase()) : [];
}

/** Escapes a literal for a POSIX extended regular expression. */
export function escapeRegex(s: string): string {
  return s.replace(/[\\^$.|?*+()[\]{}]/g, '\\$&');
}

/**
 * `--author` patterns for the User filter (git ORs several --author options). A value is 'me', a name,
 * an email or 'Name <email>'; names and emails must match exactly (as IntelliJ's user filter does).
 */
export function authorPatterns(users: readonly string[], me: UserIdentity): string[] {
  const out = new Set<string>();
  const add = (v: string) => {
    const s = v.trim();
    if (!s) return;
    const full = /^(.*?)\s*<([^>]*)>$/.exec(s);
    if (full) {
      if (full[1]) out.add(`^${escapeRegex(full[1])} <${escapeRegex(full[2])}>`);
      else out.add(`<${escapeRegex(full[2])}>`);
    } else if (s.includes('@')) out.add(`<${escapeRegex(s)}>`);
    else out.add(`^${escapeRegex(s)} <`);
  };
  for (const u of users) {
    if (u === 'me') {
      if (me.name) add(me.name);
      if (me.email) add(me.email);
    } else add(u);
  }
  return [...out];
}

/** Arguments of `git rev-list` printing "<commit time> <hash> <parents…>" lines in table order. */
export function revListArgs(q: QuerySpec): string[] {
  // both orders load the newest commits by date; 'topological' is then reordered by IntelliSort (intellisort.ts)
  const args = ['rev-list', '--timestamp', '--parents', '--date-order'];
  if (q.firstParent) args.push('--first-parent');
  if (q.limit > 0) args.push(`--max-count=${q.limit}`);
  if (q.since) args.push(`--since=@${Math.floor(q.since)}`);
  if (q.until) args.push(`--until=@${Math.floor(q.until)}`);
  const text = q.text?.trim();
  const literal = !q.regex;
  if (q.authors.length || text) {
    // -F cannot be combined with anchored author patterns: escape the text instead
    if (literal && !q.authors.length) args.push('--fixed-strings');
    else args.push('--extended-regexp');
    if (!q.matchCase) args.push('--regexp-ignore-case');
    for (const a of q.authors) args.push(`--author=${a}`);
    if (text) args.push(`--grep=${literal && q.authors.length ? escapeRegex(text) : text}`);
  }
  if (q.refs) args.push(...q.refs);
  else {
    args.push('--branches', '--remotes', '--tags');
    if (q.hasHead) args.push('HEAD');
  }
  if (q.paths.length && q.history) args.push('--full-history', '--simplify-merges');
  args.push('--');
  args.push(...q.paths);
  return args;
}

export interface Topology {
  hashes: string[];
  parents: string[][];
  /** commit time, unix seconds */
  times: number[];
}

/** Parses `git rev-list --timestamp [--parents]` output. */
export function parseRevList(out: string): Topology {
  const hashes: string[] = [];
  const parents: string[][] = [];
  const times: number[] = [];
  let start = 0;
  while (start < out.length) {
    let end = out.indexOf('\n', start);
    if (end < 0) end = out.length;
    if (end > start) {
      const f = out.slice(start, end).split(' ');
      if (f.length >= 2) {
        times.push(+f[0]);
        hashes.push(f[1]);
        parents.push(f.slice(2));
      }
    }
    start = end + 1;
  }
  return { hashes, parents, times };
}

/**
 * Merges the commit lists of several repositories into one sequence ordered by commit time while keeping each
 * list's own (topological) order. Returns [listIndex, positionInList] pairs.
 */
export function interleave(lists: readonly { times: readonly number[] }[]): { list: Int32Array; pos: Int32Array } {
  const total = lists.reduce((s, l) => s + l.times.length, 0);
  const list = new Int32Array(total);
  const pos = new Int32Array(total);
  if (lists.length === 1) {
    for (let i = 0; i < total; i++) pos[i] = i;
    return { list, pos };
  }
  const at = lists.map(() => 0);
  for (let k = 0; k < total; k++) {
    let best = -1;
    for (let i = 0; i < lists.length; i++) {
      if (at[i] >= lists[i].times.length) continue;
      if (best < 0 || lists[i].times[at[i]] > lists[best].times[at[best]]) best = i;
    }
    list[k] = best;
    pos[k] = at[best]++;
  }
  return { list, pos };
}

const FULL_HASH = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;

/** Start points of a branch filter: refs by full or short name, 'HEAD', or full commit hashes. */
export function resolveBranchFilter(values: readonly string[], refs: readonly { name: string; short: string }[], hasHead: boolean): string[] {
  const out: string[] = [];
  for (const v of values) {
    if (v === 'HEAD') {
      if (hasHead) out.push('HEAD');
      continue;
    }
    const exact = refs.find((r) => r.name === v) ?? refs.find((r) => r.short === v && r.name.startsWith('refs/heads/')) ?? refs.find((r) => r.short === v);
    if (exact && !out.includes(exact.name)) out.push(exact.name);
    // a full commit hash is a revision filter ("History Up to Here")
    else if (!exact && FULL_HASH.test(v) && !out.includes(v.toLowerCase())) out.push(v.toLowerCase());
  }
  return out;
}

/** Repo-relative paths of absolute filter paths that lie inside `root` (both with forward slashes). */
export function pathsInRoot(paths: readonly string[], root: string): string[] {
  const r = root.replace(/\\/g, '/').replace(/\/+$/, '');
  const out: string[] = [];
  for (const p0 of paths) {
    const p = p0.replace(/\\/g, '/').replace(/\/+$/, '');
    if (p === r) out.push('.');
    else if (p.startsWith(r + '/')) out.push(p.slice(r.length + 1));
  }
  return out;
}

/** Text search inside loaded rows (Find in the log table): subject, author or hash prefix. */
export function rowMatcher(text: string, regex?: boolean, matchCase?: boolean): ((subject: string, author: string, hash: string) => boolean) | undefined {
  const t = text.trim();
  if (!t) return undefined;
  let re: RegExp;
  try {
    re = new RegExp(regex ? t : t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), matchCase ? '' : 'i');
  } catch {
    return undefined;
  }
  const hashPrefix = /^[0-9a-f]{4,40}$/i.test(t) ? t.toLowerCase() : undefined;
  return (subject, author, hash) => re.test(subject) || re.test(author) || (!!hashPrefix && hash.startsWith(hashPrefix));
}

/** Recently checked out branches from `git reflog --format=%gs` lines, newest first, unique. */
export function recentBranches(reflog: string, existing: ReadonlySet<string>, max = 5): string[] {
  const out: string[] = [];
  for (const line of reflog.split('\n')) {
    const m = /^checkout: moving from (.+) to (.+)$/.exec(line.trim());
    if (!m) continue;
    for (const b of [m[2], m[1]]) {
      if (existing.has(b) && !out.includes(b)) out.push(b);
      if (out.length >= max) return out;
    }
  }
  return out;
}

/** `git shortlog -sne` → authors, merged by email (case-insensitive), most commits first. */
export function parseShortlog(out: string): { name: string; email: string; count: number }[] {
  const map = new Map<string, { name: string; email: string; count: number }>();
  for (const line of out.split('\n')) {
    const m = /^\s*(\d+)\t(.*?)\s*<([^>]*)>\s*$/.exec(line);
    if (!m) continue;
    const key = m[3].toLowerCase() || m[2];
    const cur = map.get(key);
    if (cur) cur.count += +m[1];
    else map.set(key, { name: m[2], email: m[3], count: +m[1] });
  }
  return [...map.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

/** Older names of a file from `git log --follow -z --name-only --format= -- <path>` (NUL separated), without `current`. */
export function parseFollowNames(out: string, current: string): string[] {
  const names = out.split('\0').map((n) => n.replace(/^\n+|\n+$/g, '')).filter(Boolean);
  return [...new Set(names)].filter((n) => n !== current);
}
