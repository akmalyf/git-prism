// Pure push helpers: `git push --porcelain` parsing, protected-branch matching and IntelliJ's push result texts
// (GitBundle push.notification.*). No vscode imports (unit-tested).
import type { ChangeKind } from '../../core/types';

export type PushFlag = 'ff' | 'forced' | 'deleted' | 'new' | 'rejected' | 'uptodate';

export interface PushRefResult {
  flag: PushFlag;
  from: string;
  to: string;
  /** "fdc3d23..1802b17", "[new branch]", "[rejected]", "[up to date]" */
  summary: string;
  /** text in parentheses: "fetch first", "non-fast-forward", "stale info", "forced update" */
  reason?: string;
}

const FLAGS: Record<string, PushFlag> = { ' ': 'ff', '+': 'forced', '-': 'deleted', '*': 'new', '!': 'rejected', '=': 'uptodate' };

/** Parses the ref lines of `git push --porcelain` (`<flag>\t<from>:<to>\t<summary> (<reason>)`). */
export function parsePushPorcelain(out: string): PushRefResult[] {
  const res: PushRefResult[] = [];
  for (const line of out.split('\n')) {
    const m = /^([ +\-*!=])\t([^\t]*)\t(.*)$/.exec(line);
    if (!m) continue;
    const [from, to] = splitRefspec(m[2]);
    const s = /^(.*?)(?: \((.*)\))?$/.exec(m[3].trim())!;
    res.push({ flag: FLAGS[m[1]], from, to, summary: s[1], reason: s[2] });
  }
  return res;
}

function splitRefspec(spec: string): [string, string] {
  const i = spec.lastIndexOf(':');
  return i < 0 ? [spec, spec] : [spec.slice(0, i), spec.slice(i + 1)];
}

/** Rejected because the remote has commits we don't have (needs update), as opposed to hooks / permissions. */
export function isNonFastForward(r: PushRefResult): boolean {
  return r.flag === 'rejected' && /fetch first|non-fast-forward|rejected/.test(`${r.summary} ${r.reason ?? ''}`) && !/stale info/.test(r.reason ?? '');
}

/** Protected branch patterns from the setting ("master, main" or an array); each is a regular expression of the whole name. */
export function parsePatterns(v: string | readonly string[] | undefined): string[] {
  const list = Array.isArray(v) ? v : String(v ?? '').split(/[,;]/);
  return list.map((s) => s.trim()).filter(Boolean);
}

export function isProtected(branch: string, patterns: readonly string[]): boolean {
  return patterns.some((p) => {
    try {
      return new RegExp(`^(?:${p})$`).test(branch);
    } catch {
      return p === branch;
    }
  });
}

const commits = (n: number) => `${n} ${n === 1 ? 'commit' : 'commits'}`;

export interface PushSummary {
  /** "origin/main" */
  target: string;
  remote: string;
  /** commits pushed (outgoing count computed before pushing) */
  count: number;
  branch: PushRefResult | undefined;
  tags: string[];
  force: boolean;
}

/** One line of the success notification, like IntelliJ's GitPushResultNotification. */
export function describePush(s: PushSummary): string {
  const b = s.branch;
  const tags = s.tags;
  const tagPart = tags.length === 1 ? `, and tag ${tags[0]} to ${s.remote}` : tags.length > 1 ? `, and ${tags.length} tags to ${s.remote}` : '';
  if (b?.flag === 'rejected') {
    if (s.force && /stale info/.test(b.reason ?? '')) return `Force-with-lease push ${refName(b.from)} to ${s.target} was rejected`;
    return isNonFastForward(b) ? `Push to ${s.target} was rejected` : `Push ${refName(b.from)} to ${s.target} was rejected by the remote`;
  }
  if (!b || b.flag === 'uptodate') {
    if (tags.length === 1) return `Pushed tag ${tags[0]} to ${s.remote}`;
    if (tags.length > 1) return `Pushed ${tags.length} tags to ${s.remote}`;
    return 'Everything is up to date';
  }
  if (b.flag === 'forced') return `Force pushed ${refName(b.from)} to ${s.target}`;
  if (b.flag === 'new') return `Pushed ${commits(s.count)} to new branch ${s.target}${tagPart}`;
  return `Pushed ${commits(s.count)} to ${s.target}${tagPart}`;
}

/** refs/heads/main → main; a hash → its first 8 chars. */
export function refName(ref: string): string {
  if (ref.startsWith('refs/heads/')) return ref.slice(11);
  if (ref.startsWith('refs/tags/')) return ref.slice(10);
  if (/^[0-9a-f]{40,64}$/.test(ref)) return ref.slice(0, 8);
  return ref;
}

/** Tags actually transferred in a push (new or updated, not up to date). */
export function pushedTags(results: readonly PushRefResult[]): string[] {
  return results.filter((r) => r.to.startsWith('refs/tags/') && r.flag !== 'uptodate' && r.flag !== 'rejected').map((r) => r.to.slice(10));
}

/** `git fetch` stderr lines " - [deleted]  (none) -> origin/x" → pruned refs. */
export function prunedRefs(stderr: string): string[] {
  const res: string[] = [];
  for (const line of stderr.split('\n')) {
    const m = /^\s*-\s+\[deleted\]\s+.*->\s+(\S+)\s*$/.exec(line);
    if (m) res.push(m[1]);
  }
  return res;
}

/** "3 files updated in 2 commits" (GitBundle git.update.files.updated.in.commits). */
export function updatedText(files: number, commitCount: number): string {
  return `${files} ${files === 1 ? 'file' : 'files'} updated in ${commits(commitCount)}`;
}

export interface CommitFile {
  path: string;
  oldPath?: string;
  kind: ChangeKind;
}

/** `git diff-tree --stdin -z --name-status -r -M --root` output → files per commit hash. */
export function parseDiffTreeStdin(out: string): Map<string, CommitFile[]> {
  const res = new Map<string, CommitFile[]>();
  const t = out.split('\0');
  let cur: CommitFile[] | undefined;
  let i = 0;
  while (i < t.length) {
    const tok = t[i].replace(/^\n/, '');
    if (!tok) {
      i++;
      continue;
    }
    if (/^[0-9a-f]{40,64}$/.test(tok)) {
      cur = [];
      res.set(tok, cur);
      i++;
      continue;
    }
    const kind = tok[0] as ChangeKind;
    if (kind === 'R' || kind === 'C') {
      cur?.push({ kind, oldPath: t[i + 1], path: t[i + 2] });
      i += 3;
    } else {
      cur?.push({ kind, path: t[i + 1] });
      i += 2;
    }
  }
  return res;
}

export interface SquashedChange extends CommitFile {
  /** oldest commit touching the file (left side = its first parent) */
  first: string;
  /** newest commit touching the file (right side) */
  last: string;
  /** `first` is a root commit (no left side) */
  firstRoot: boolean;
}

/**
 * Combines the per-commit changes of several commits (oldest first) into the net change of each file, like
 * IntelliJ's "changes of the selected commits": A then D → gone, D then A → M, M then R → R from the original path, …
 */
export function squashChanges(commits: readonly { hash: string; root: boolean; files: readonly CommitFile[] }[]): SquashedChange[] {
  const map = new Map<string, SquashedChange>();
  for (const c of commits) {
    for (const f of c.files) {
      const key = f.kind === 'R' && f.oldPath !== undefined ? f.oldPath : f.path;
      const prev = map.get(key);
      if (!prev) {
        map.set(f.path, { ...f, first: c.hash, last: c.hash, firstRoot: c.root });
        continue;
      }
      map.delete(key);
      const base = { first: prev.first, last: c.hash, firstRoot: prev.firstRoot };
      // the path the file had before the first commit (undefined = it didn't exist)
      const origin = prev.kind === 'A' ? undefined : prev.oldPath ?? prev.path;
      if (f.kind === 'D') {
        if (origin !== undefined) map.set(origin, { path: origin, kind: 'D', ...base });
        continue;
      }
      if (origin === undefined) map.set(f.path, { path: f.path, kind: 'A', ...base });
      else if (prev.kind === 'D') map.set(f.path, { path: f.path, kind: 'M', ...base });
      else if (origin !== f.path) map.set(f.path, { path: f.path, oldPath: origin, kind: prev.kind === 'C' ? 'C' : 'R', ...base });
      else map.set(f.path, { path: f.path, kind: f.kind === 'R' || f.kind === 'C' ? 'M' : f.kind, ...base });
    }
  }
  return [...map.values()].sort((a, b) => a.path.localeCompare(b.path));
}
