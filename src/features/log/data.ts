// The commit list of one log view: runs the rev-list query of every visible repository, merges the lists into one
// table, builds the commit graph and serves rows (commit metadata is fetched lazily in chunks and cached).
import type { Repository } from '../../core/repository';
import { LOG_FORMAT, LOG_FORMAT_NO_BODY, parseLog } from '../../core/parse';
import type { Commit, Ref } from '../../core/types';
import { CommitGraph, stringHash } from './graph';
import type { CommitDetails, ContainingBranches, LogFilters, LogRow, LogSettings, RefLabel, RootInfo } from './protocol';
import {
  authorPatterns,
  hashWords,
  interleave,
  isStructureChanging,
  parseRevList,
  pathsInRoot,
  resolveBranchFilter,
  revListArgs,
  rowMatcher,
  type Topology,
} from './query';
import { colorName, headPriority, isDefaultFavorite, labelsByHash } from './refs';

/** commits loaded first; loadMore() adds MORE_PAGE more each time */
export const FIRST_PAGE = 20000;
export const MORE_PAGE = 50000;
const META_CHUNK = 1000;
const META_CACHE_MAX = 250000;

/** Paths given to git are file names, not glob patterns (Next.js "app/[id]/page.tsx" must not match "app/i/…"). */
export const LITERAL_PATHSPECS = { GIT_LITERAL_PATHSPECS: '1' };

export interface LoadRequest {
  repos: Repository[];
  filters: LogFilters;
  settings: LogSettings;
  /** file history semantics for the path filter */
  history: boolean;
  /** extra repo-relative paths per root (older names of a file in its history) */
  extraPaths?: Map<string, string[]>;
  favorites: (root: string) => Set<string> | undefined;
}

export interface RootData {
  repo: Repository;
  info: RootInfo;
  refs: Ref[];
  labels: Map<string, RefLabel[]>;
  favorites: Set<string>;
  topo: Topology;
  truncated: boolean;
  /** repo-relative path filter of this root */
  paths: string[];
}

export class LogData {
  version = 0;
  roots: RootData[] = [];
  visible: RootData[] = [];
  linear = false;
  graph = new CommitGraph({ count: 0, parentStart: new Int32Array(1), parentRows: new Int32Array(0) });
  graphWidth = 0;
  private rowRoot = new Int32Array(0);
  private rowPos = new Int32Array(0);
  private rowOf: Map<string, number>[] = [];
  private limit = FIRST_PAGE;
  private readonly meta = new Map<string, Commit>();
  private currentMark: Uint8Array | undefined;
  private containsCache = new Map<string, Promise<ContainingBranches>>();
  private signature = '';

  get count(): number {
    return this.rowRoot.length;
  }

  get hasMore(): boolean {
    return this.visible.some((r) => r.truncated);
  }

  rootOf(row: number): RootData {
    return this.roots[this.rowRoot[row]];
  }

  hashOf(row: number): string {
    return this.rootOf(row).topo.hashes[this.rowPos[row]];
  }

  /** Row of a commit in the current list, or -1. */
  row(root: string, hash: string): number {
    const r = this.roots.find((x) => x.repo.root === root);
    if (!r) return -1;
    return this.rowOf[r.info.index]?.get(hash) ?? -1;
  }

  /** Empties the list (after a failed load: "Error loading commits"). */
  clear(): void {
    this.visible = [];
    this.rowRoot = new Int32Array(0);
    this.rowPos = new Int32Array(0);
    this.rowOf = this.roots.map(() => new Map());
    this.graph = new CommitGraph({ count: 0, parentStart: new Int32Array(1), parentRows: new Int32Array(0) });
    this.currentMark = undefined;
    this.signature = '';
    this.version++;
  }

  /** A cheap fingerprint of refs + HEAD of every repository: unchanged → the log needn't be reloaded. */
  static async signature(repos: Repository[]): Promise<string> {
    const parts = await Promise.all(
      repos.map(async (repo) => {
        const [refs, head, sym] = await Promise.all([
          repo.run(['for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads', 'refs/remotes', 'refs/tags'], { quiet: true, allowFail: true }),
          repo.run(['rev-parse', '--verify', '--quiet', 'HEAD'], { quiet: true, allowFail: true }),
          repo.run(['symbolic-ref', '--quiet', 'HEAD'], { quiet: true, allowFail: true }),
        ]);
        return `${repo.root}\n${head.stdout}${sym.stdout}${refs.stdout}${repo.operationState()}`;
      }),
    );
    return parts.join('\0');
  }

  /** True when refs/HEAD changed since the last load (or the last call). */
  async changedSince(repos: Repository[]): Promise<boolean> {
    const s = await LogData.signature(repos);
    return s !== this.signature;
  }

  async loadMore(req: LoadRequest): Promise<void> {
    this.limit += MORE_PAGE;
    await this.load(req, true);
  }

  /** (Re)loads the commit list. `keepLimit` keeps the number of loaded commits (refresh, load more). */
  async load(req: LoadRequest, keepLimit = false): Promise<void> {
    if (!keepLimit) this.limit = FIRST_PAGE;
    const { filters, settings } = req;
    const signature = await LogData.signature(req.repos);
    const roots = await Promise.all(req.repos.map((repo, index) => this.loadRoot(repo, index, req)));
    const linear = isStructureChanging(filters);
    const visible = roots.filter((r) => r.info && this.isVisible(r, filters));

    // merge the per-root lists
    const lists = visible.map((r) => r.topo);
    const { list, pos } = interleave(lists);
    const n = list.length;
    const rowRoot = new Int32Array(n);
    const rowPos = new Int32Array(n);
    const rowOf: Map<string, number>[] = roots.map(() => new Map());
    for (let k = 0; k < n; k++) {
      const r = visible[list[k]];
      rowRoot[k] = r.info.index;
      rowPos[k] = pos[k];
      rowOf[r.info.index].set(r.topo.hashes[pos[k]], k);
    }
    // graph parents (linear chain per root for structure-changing filters)
    const parentStart = new Int32Array(n + 1);
    const parentRows: number[] = [];
    const lastRowOfRoot = new Map<number, number>();
    const linearNext = new Int32Array(n).fill(-1);
    if (linear) {
      for (let k = n - 1; k >= 0; k--) {
        const ri = rowRoot[k];
        linearNext[k] = lastRowOfRoot.get(ri) ?? -1;
        lastRowOfRoot.set(ri, k);
      }
    }
    for (let k = 0; k < n; k++) {
      parentStart[k] = parentRows.length;
      if (linear) {
        if (linearNext[k] >= 0) parentRows.push(linearNext[k]);
        continue;
      }
      const r = roots[rowRoot[k]];
      const ps = r.topo.parents[rowPos[k]];
      const map = rowOf[rowRoot[k]];
      const count = settings.firstParent ? Math.min(1, ps.length) : ps.length;
      for (let j = 0; j < count; j++) parentRows.push(map.get(ps[j]) ?? -1);
    }
    parentStart[n] = parentRows.length;
    // layout priority: HEAD of every root first, then branch heads
    const headOrder: number[] = [];
    for (const r of visible) if (r.info.head) headOrder.push(rowOf[r.info.index].get(r.info.head) ?? -1);
    for (const r of visible) for (const h of headPriority(r.labels, r.info.head)) headOrder.push(rowOf[r.info.index].get(h) ?? -1);
    const graph = new CommitGraph({
      count: n,
      parentStart,
      parentRows: Int32Array.from(parentRows),
      headOrder: headOrder.filter((x) => x >= 0),
      headColor: (row) => {
        const r = roots[rowRoot[row]];
        const hash = r.topo.hashes[rowPos[row]];
        return stringHash(colorName(r.labels.get(hash), hash));
      },
    });

    this.roots = roots;
    this.visible = visible;
    this.linear = linear;
    this.rowRoot = rowRoot;
    this.rowPos = rowPos;
    this.rowOf = rowOf;
    this.graph = graph;
    this.graphWidth = 0;
    this.currentMark = undefined;
    this.containsCache.clear();
    this.signature = signature;
    this.version++;
  }

  private isVisible(r: RootData, f: LogFilters): boolean {
    if (f.roots?.length && !f.roots.includes(r.repo.root)) return false;
    if (f.paths?.length && !r.paths.length) return false;
    return true;
  }

  private async loadRoot(repo: Repository, index: number, req: LoadRequest): Promise<RootData> {
    const { filters, settings } = req;
    const [branch, head, refs, name, email] = await Promise.all([
      repo.currentBranch(),
      repo.headHash(),
      repo.refs(),
      repo.config('user.name'),
      repo.config('user.email'),
    ]);
    const favorites = req.favorites(repo.root) ?? new Set(refs.filter((r) => r.type !== 'tag' && isDefaultFavorite(r.short)).map((r) => r.short));
    const info: RootInfo = {
      index,
      root: repo.root,
      name: repo.name,
      branch,
      head,
      detached: !!head && !branch,
      empty: !head && !refs.length,
      operation: repo.operationState(),
      me: { name, email },
    };
    const labels = labelsByHash(refs, head, branch, favorites);
    const paths = filters.paths?.length ? [...pathsInRoot(filters.paths, repo.root), ...(req.extraPaths?.get(repo.root) ?? [])] : [];
    const data: RootData = { repo, info, refs, labels, favorites, topo: { hashes: [], parents: [], times: [] }, truncated: false, paths: [...new Set(paths)] };
    if (filters.roots?.length && !filters.roots.includes(repo.root)) return data;
    if (filters.paths?.length && !data.paths.length) return data;

    let startRefs: string[] | undefined;
    if (filters.branches?.length) {
      startRefs = resolveBranchFilter(filters.branches, refs, !!head);
      if (!startRefs.length) return data;
    }
    if (!head && !refs.length) return data;
    const authors = filters.users?.length ? authorPatterns(filters.users, info.me) : [];
    if (filters.users?.length && !authors.length) return data;
    const args = revListArgs({
      sort: settings.sortType,
      firstParent: settings.firstParent,
      refs: startRefs,
      hasHead: !!head,
      authors,
      since: filters.since,
      until: filters.until,
      text: filters.text,
      regex: filters.regex,
      matchCase: filters.matchCase,
      paths: data.paths.filter((p) => p !== '.').length ? data.paths.filter((p) => p !== '.') : [],
      history: req.history,
      limit: this.limit,
    });
    let topo = parseRevList((await repo.run(args, { quiet: true, env: LITERAL_PATHSPECS })).stdout);
    data.truncated = topo.hashes.length >= this.limit;
    // a text filter made of hashes also matches commits by hash (IntelliJ: text OR hash)
    const words = hashWords(filters.text);
    if (words.length) {
      const extra = await hashCandidates(repo, words);
      const known = new Set(topo.hashes);
      const add = extra.filter((h) => !known.has(h));
      if (add.length) {
        const all = [...topo.hashes, ...add].join('\n') + '\n';
        topo = parseRevList((await repo.run(['rev-list', '--no-walk=sorted', '--timestamp', '--parents', '--stdin'], { quiet: true, input: all })).stdout);
      }
    }
    data.topo = topo;
    return data;
  }

  /** Commit metadata of rows [from, to), fetched as needed. */
  async ensureMeta(from: number, to: number): Promise<void> {
    from = Math.max(0, from);
    to = Math.min(this.count, to);
    const missing = new Map<number, string[]>();
    for (let k = from; k < to; k++) {
      const r = this.roots[this.rowRoot[k]];
      const hash = r.topo.hashes[this.rowPos[k]];
      if (!this.meta.has(metaKey(r.repo.root, hash))) {
        const list = missing.get(r.info.index) ?? [];
        list.push(hash);
        missing.set(r.info.index, list);
      }
    }
    const jobs: Promise<void>[] = [];
    for (const [ri, hashes] of missing) {
      const r = this.roots[ri];
      for (let i = 0; i < hashes.length; i += META_CHUNK) {
        const chunk = hashes.slice(i, i + META_CHUNK);
        jobs.push(
          r.repo.run(['log', '--no-show-signature', '--no-walk=unsorted', '--stdin', LOG_FORMAT_NO_BODY], { quiet: true, input: chunk.join('\n') + '\n' }).then((res) => {
            for (const c of parseLog(res.stdout)) this.meta.set(metaKey(r.repo.root, c.hash), c);
          }),
        );
      }
    }
    await Promise.all(jobs);
    if (this.meta.size > META_CACHE_MAX) {
      let drop = this.meta.size - META_CACHE_MAX;
      for (const k of this.meta.keys()) {
        if (drop-- <= 0) break;
        this.meta.delete(k);
      }
    }
  }

  commitAt(row: number): Commit | undefined {
    const r = this.rootOf(row);
    return this.meta.get(metaKey(r.repo.root, r.topo.hashes[this.rowPos[row]]));
  }

  async rows(from: number, to: number, settings: LogSettings): Promise<LogRow[]> {
    from = Math.max(0, from);
    to = Math.min(this.count, to);
    if (from >= to) return [];
    const version = this.version;
    await this.ensureMeta(from, to);
    if (version !== this.version) return [];
    const prints = this.graph.print(from, to, { showLongEdges: settings.showLongEdges });
    const mark = await this.currentBranchMark();
    if (version !== this.version) return [];
    const out: LogRow[] = [];
    for (let k = from; k < to; k++) {
      const r = this.rootOf(k);
      const p = this.rowPos[k];
      const hash = r.topo.hashes[p];
      const c = this.meta.get(metaKey(r.repo.root, hash));
      const g = prints[k - from];
      this.graphWidth = Math.max(this.graphWidth, g.width);
      const me = r.info.me;
      const row: LogRow = {
        index: k,
        root: r.info.index,
        hash,
        parents: c?.parents ?? r.topo.parents[p],
        childRows: this.graph.children(k),
        parentRows: this.graph.parents(k),
        subject: c?.subject ?? '',
        author: c?.author ?? '',
        authorEmail: c?.authorEmail ?? '',
        authorDate: c?.authorDate ?? r.topo.times[p],
        committer: c?.committer ?? '',
        committerEmail: c?.committerEmail ?? '',
        commitDate: c?.commitDate ?? r.topo.times[p],
        refs: r.labels.get(hash) ?? [],
        graph: g,
      };
      if (hash === r.info.head) row.head = true;
      if (c && ((me.email && c.authorEmail.toLowerCase() === me.email.toLowerCase()) || (!me.email && me.name && c.author === me.name))) row.mine = true;
      if (mark?.[k]) row.onCurrentBranch = true;
      out.push(row);
    }
    return out;
  }

  /**
   * Rows reachable from HEAD of their repository ("Current Branch" highlighter, history-rewriting actions). The
   * graph answers it when it is the real topology and contains HEAD; otherwise (text/user/date filters, a branch
   * filter without HEAD) `git rev-list HEAD` does.
   */
  private async currentBranchMark(): Promise<Uint8Array | undefined> {
    if (this.currentMark || !this.count) return this.currentMark;
    const version = this.version;
    const mark = new Uint8Array(this.count);
    for (const r of this.visible) {
      if (!r.info.head) continue;
      const row = this.rowOf[r.info.index].get(r.info.head);
      if (!this.linear && row !== undefined) {
        const a = this.graph.ancestors(row);
        for (let i = 0; i < a.length; i++) if (a[i]) mark[i] = 1;
        continue;
      }
      const res = await r.repo.run(['rev-list', 'HEAD'], { quiet: true, allowFail: true });
      if (version !== this.version) return undefined;
      const rows = this.rowOf[r.info.index];
      for (const h of res.stdout.split('\n')) {
        const k = rows.get(h);
        if (k !== undefined) mark[k] = 1;
      }
    }
    if (version !== this.version) return undefined;
    return (this.currentMark = mark);
  }

  /** Full details (message body) of commits. */
  async details(commits: { root: string; hash: string }[]): Promise<CommitDetails[]> {
    const byRoot = new Map<string, string[]>();
    for (const c of commits) byRoot.set(c.root, [...(byRoot.get(c.root) ?? []), c.hash]);
    const out = new Map<string, CommitDetails>();
    await Promise.all(
      [...byRoot].map(async ([root, hashes]) => {
        const r = this.roots.find((x) => x.repo.root === root);
        if (!r) return;
        const res = await r.repo.run(['log', '--no-show-signature', '--no-walk=unsorted', '--stdin', LOG_FORMAT], { quiet: true, input: hashes.join('\n') + '\n' });
        for (const c of parseLog(res.stdout)) {
          out.set(metaKey(root, c.hash), {
            root,
            hash: c.hash,
            parents: c.parents,
            subject: c.subject,
            message: c.body ? `${c.subject}\n\n${c.body}` : c.subject,
            author: c.author,
            authorEmail: c.authorEmail,
            authorDate: c.authorDate,
            committer: c.committer,
            committerEmail: c.committerEmail,
            commitDate: c.commitDate,
            refs: r.labels.get(c.hash) ?? [],
          });
        }
      }),
    );
    return commits.map((c) => out.get(metaKey(c.root, c.hash))).filter((d): d is CommitDetails => !!d);
  }

  /** Branches containing a commit (`git branch -a --contains`), cached until the next reload. */
  containingBranches(root: string, hash: string): Promise<ContainingBranches> {
    const key = metaKey(root, hash);
    let p = this.containsCache.get(key);
    if (!p) {
      p = (async () => {
        const r = this.roots.find((x) => x.repo.root === root);
        if (!r) return { root, hash, branches: [], current: false };
        const res = await r.repo.run(['branch', '-a', '--contains', hash, '--format=%(refname)'], { quiet: true, allowFail: true });
        const local: string[] = [];
        const remote: string[] = [];
        for (const line of res.stdout.split('\n')) {
          if (line.startsWith('refs/heads/')) local.push(line.slice(11));
          else if (line.startsWith('refs/remotes/') && !line.endsWith('/HEAD')) remote.push(line.slice(13));
        }
        return { root, hash, branches: [...local, ...remote], current: !!r.info.branch && local.includes(r.info.branch) };
      })();
      this.containsCache.set(key, p);
      p.catch(() => this.containsCache.delete(key));
    }
    return p;
  }

  /** Row of a hash prefix among the loaded commits (first match in table order), or -1. */
  findHashPrefix(prefix: string): number {
    const p = prefix.toLowerCase();
    for (let k = 0; k < this.count; k++) if (this.hashOf(k).startsWith(p)) return k;
    return -1;
  }

  /** Next row (after `from`, or before it when backward) whose subject, author or hash matches. */
  async search(text: string, from: number, backward: boolean, regex?: boolean, matchCase?: boolean): Promise<number> {
    const m = rowMatcher(text, regex, matchCase);
    if (!m) return -1;
    const version = this.version;
    const step = 2000;
    if (!backward) {
      for (let a = from + 1; a < this.count; a += step) {
        const b = Math.min(this.count, a + step);
        await this.ensureMeta(a, b);
        if (version !== this.version) return -1;
        for (let k = a; k < b; k++) {
          const c = this.commitAt(k);
          if (c && m(c.subject, c.author, c.hash)) return k;
        }
      }
    } else {
      for (let b = (from < 0 ? this.count : from); b > 0; b -= step) {
        const a = Math.max(0, b - step);
        await this.ensureMeta(a, b);
        if (version !== this.version) return -1;
        for (let k = b - 1; k >= a; k--) {
          const c = this.commitAt(k);
          if (c && m(c.subject, c.author, c.hash)) return k;
        }
      }
    }
    return -1;
  }
}

function metaKey(root: string, hash: string): string {
  return `${root}\0${hash}`;
}

/** Full hashes of commits whose hash starts with one of `words`. */
async function hashCandidates(repo: Repository, words: string[]): Promise<string[]> {
  const objs: string[] = [];
  for (const w of words) {
    const r = await repo.run(['rev-parse', `--disambiguate=${w}`], { quiet: true, allowFail: true });
    if (r.code === 0) objs.push(...r.stdout.split('\n').filter(Boolean));
  }
  if (!objs.length) return [];
  const r = await repo.run(['cat-file', '--batch-check=%(objectname) %(objecttype)'], { quiet: true, allowFail: true, input: objs.join('\n') + '\n' });
  return r.stdout
    .split('\n')
    .map((l) => l.split(' '))
    .filter((f) => f[1] === 'commit')
    .map((f) => f[0]);
}
