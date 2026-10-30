// One Git Log UI (the "Log" panel view, a "Show Git Log" editor tab or a "History: <file>" tab): owns the filters
// and the commit list, answers the webview's RPC calls (see PROTOCOL.md), refreshes on repository changes keeping
// the loaded range, and persists filters/options per set of repositories in workspaceState.
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { invoke, type Commands } from '../../core/contracts';
import type { FeatureContext } from '../../core/context';
import { showGitError } from '../../core/git';
import type { Repository } from '../../core/repository';
import { RpcBridge } from '../../core/webview';
import { applySelectedChanges, computeChanges, getFromRevision, showDiff } from './actions';
import { checkoutAndRebase, cherryPicked, fileContents, pullInto, updateBranch } from './branchops';
import { LITERAL_PATHSPECS, LogData, type LoadRequest } from './data';
import { FileHistoryActions } from './history';
import type {
  ChangesRequest,
  CherryPickedRequest,
  CommitId,
  CommitOpRequest,
  FileAtRevision,
  FileContentsRequest,
  FilesAtRevision,
  GoToResult,
  HistoryActionRequest,
  HistoryUpToRequest,
  LogFilters,
  LogInit,
  LogSettingKey,
  LogState,
  LogViewOptions,
  PathSuggestion,
  RefOpRequest,
  RefsInfo,
  RowsRequest,
  RowsResult,
  SearchRequest,
  ShowDiffRequest,
  UsersResult,
} from './protocol';
import { hasAnyFilter, parseFollowNames, parseShortlog, pathsInRoot, recentBranches } from './query';
import { toRefItem } from './refs';
import { readSettings, RELOAD_KEYS, writeSetting } from './settings';

const FAVORITES_KEY = 'jbGit.log.favorites';
const DEFAULT_OPTIONS: LogViewOptions = { showChangesToParents: false, showOnlyAffectedChanges: true };

export interface ControllerOptions {
  init: LogInit;
  /** workspaceState key for filters/options; undefined = not persisted (editor tabs) */
  persistKey?: string;
  /** initial filters (override persisted ones) */
  filters?: LogFilters;
  /** opens another log editor tab with these filters ("Open New Git Log Editor Tab") */
  openEditor: (filters: LogFilters) => void;
}

interface Persisted {
  filters: LogFilters;
  options: LogViewOptions;
}

type LoadKind = 'refresh' | 'more' | 'reload';

export class LogController implements vscode.Disposable {
  readonly data = new LogData();
  private readonly fileHistory: FileHistoryActions;
  private readonly bridge: RpcBridge;
  private readonly disposables: vscode.Disposable[] = [];
  private filters: LogFilters;
  private options: LogViewOptions;
  private loading = false;
  private error: string | undefined;
  private visible = true;
  private dirty = false;
  private refreshTimer: NodeJS.Timeout | undefined;
  private pending: LoadKind | undefined;
  private running: Promise<void> | undefined;
  private extraPaths = new Map<string, string[]>();
  private lsFiles = new Map<string, Promise<string[]>>();
  private disposed = false;
  /** resolves after the first load */
  readonly ready: Promise<void>;

  constructor(
    private readonly ctx: FeatureContext,
    private readonly webview: vscode.Webview,
    private readonly opts: ControllerOptions,
  ) {
    const saved = opts.persistKey ? ctx.extension.workspaceState.get<Persisted>(opts.persistKey) : undefined;
    this.filters = { ...(opts.filters ?? saved?.filters ?? {}) };
    this.options = { ...DEFAULT_OPTIONS, ...(saved?.options ?? {}) };
    this.fileHistory = new FileHistoryActions(this.data, opts.init.historyPaths ?? []);
    this.bridge = new RpcBridge(webview, this.handlers());
    this.disposables.push(
      this.bridge,
      ctx.repos.onDidChangeRepository((repo) => this.onRepoChanged(repo)),
      ctx.repos.onDidChangeRepositories(() => this.request('refresh')),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (!e.affectsConfiguration('jbGit.log')) return;
        const settings = readSettings();
        this.bridge.emit('settings', settings);
        if (RELOAD_KEYS.some((k) => e.affectsConfiguration(`jbGit.log.${k}`))) this.request('reload');
        else this.emitState();
      }),
    );
    this.ready = (async () => {
      await ctx.repos.ready();
      await this.computeHistoryNames();
      await this.request('reload');
    })();
  }

  get init(): LogInit {
    return this.opts.init;
  }

  private repos(): Repository[] {
    return this.ctx.repos.all;
  }

  private loadRequest(): LoadRequest {
    const store = this.ctx.extension.workspaceState.get<Record<string, string[]>>(FAVORITES_KEY) ?? {};
    return {
      repos: this.repos(),
      filters: this.effectiveFilters(),
      settings: readSettings(),
      history: this.opts.init.mode === 'history',
      extraPaths: this.extraPaths,
      favorites: (root) => (store[root] ? new Set(store[root]) : undefined),
    };
  }

  /** The history view always filters by its paths (the filter bar doesn't show them). */
  private effectiveFilters(): LogFilters {
    const hp = this.opts.init.historyPaths;
    return hp?.length ? { ...this.filters, paths: hp } : this.filters;
  }

  /** History of a single file follows renames: older names join the path filter. */
  private async computeHistoryNames(): Promise<void> {
    const hp = this.opts.init.historyPaths;
    if (this.opts.init.mode !== 'history' || hp?.length !== 1) return;
    const abs = hp[0];
    const repo = this.ctx.repos.forUri(vscode.Uri.file(abs));
    if (!repo) return;
    try {
      if (fs.existsSync(abs) && fs.statSync(abs).isDirectory()) return;
    } catch {
      return;
    }
    const rel = pathsInRoot([abs], repo.root)[0];
    if (!rel || rel === '.') return;
    // -z: names unquoted (non-ASCII paths); literal pathspec: names with glob characters ("[id].tsx")
    const r = await repo.run(['log', '--no-show-signature', '--follow', '-z', '--name-only', '--format=', '--', rel], { quiet: true, allowFail: true, env: LITERAL_PATHSPECS });
    const names = parseFollowNames(r.stdout, rel);
    if (names.length) this.extraPaths.set(repo.root, names);
  }

  // ---- loading ----

  /** Queues a load; concurrent requests are coalesced (reload > more > refresh). */
  private request(kind: LoadKind): Promise<void> {
    const rank = { refresh: 0, more: 1, reload: 2 } as const;
    if (!this.pending || rank[kind] > rank[this.pending]) this.pending = kind;
    if (!this.running) {
      this.running = (async () => {
        try {
          while (this.pending && !this.disposed) {
            const k = this.pending;
            this.pending = undefined;
            await this.runLoad(k);
          }
        } finally {
          this.running = undefined;
        }
      })();
    }
    return this.running;
  }

  private async runLoad(kind: LoadKind): Promise<void> {
    this.loading = true;
    this.emitState();
    try {
      const req = this.loadRequest();
      if (kind === 'more') await this.data.loadMore(req);
      else await this.data.load(req, kind === 'refresh');
      this.error = undefined;
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
      this.data.clear();
    } finally {
      this.loading = false;
      this.lsFiles.clear();
      this.dirty = false;
    }
    this.emitState();
    if (!this.disposed) this.bridge.emit('refs');
  }

  private onRepoChanged(repo: Repository): void {
    if (!this.repos().includes(repo)) return;
    if (!this.visible) {
      this.dirty = true;
      return;
    }
    clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => this.refreshIfChanged(), 400);
  }

  private async refreshIfChanged(): Promise<void> {
    if (this.disposed) return;
    try {
      if (await this.data.changedSince(this.repos())) await this.request('refresh');
    } catch {
      /* repository vanished; the manager will fire onDidChangeRepositories */
    }
  }

  setVisible(visible: boolean): void {
    this.visible = visible;
    if (visible && this.dirty) this.refreshIfChanged();
  }

  state(): LogState {
    const settings = readSettings();
    const f = this.filters;
    return {
      version: this.data.version,
      roots: this.data.roots.map((r) => r.info),
      visibleRoots: this.data.visible.map((r) => r.repo.root),
      rowCount: this.data.count,
      hasMore: this.data.hasMore,
      loading: this.loading,
      error: this.error,
      linear: this.data.linear,
      filtered: hasAnyFilter({ ...f, paths: this.opts.init.mode === 'history' ? undefined : f.paths }),
      filters: f,
      options: this.options,
      settings,
      graphWidth: this.data.graphWidth,
    };
  }

  private emitState(): void {
    if (!this.disposed) this.bridge.emit('state', this.state());
  }

  private persist(): void {
    if (this.opts.persistKey) this.ctx.extension.workspaceState.update(this.opts.persistKey, { filters: this.filters, options: this.options } satisfies Persisted);
  }

  /** Replaces the filters (jbGit.log.show) and reloads. */
  async setFilters(filters: LogFilters): Promise<LogState> {
    this.filters = normalizeFilters(filters);
    this.persist();
    await this.request('reload');
    return this.state();
  }

  /** Refresh: reloads keeping the number of loaded commits. */
  refresh(): Promise<void> {
    return this.request('refresh');
  }

  focusTextFilter(): void {
    this.bridge.emit('focusTextFilter');
  }

  /** Selects a revision (hash, branch, tag); resets the filters if the commit is filtered out. */
  async reveal(revision: string, root?: string): Promise<void> {
    await this.ready;
    let res = await this.goTo(revision, root);
    if (res.row < 0 && hasAnyFilter(this.filters) && res.hash) {
      await this.setFilters({});
      res = await this.goTo(revision, root);
    }
    if (res.row >= 0 && res.hash && res.root) this.bridge.emit('select', { row: res.row, hash: res.hash, root: res.root });
    else if (res.message) vscode.window.showWarningMessage(res.message);
  }

  /** Go To Hash/Branch/Tag. Loads more commits while the target isn't loaded yet. */
  async goTo(text: string, onlyRoot?: string): Promise<GoToResult> {
    await this.ready;
    const t = text.trim();
    if (!t) return { row: -1 };
    const roots = this.data.roots.filter((r) => !onlyRoot || r.repo.root === onlyRoot);
    let target: { root: string; hash: string } | undefined;
    for (const r of roots) {
      if (t === 'HEAD' && r.info.head) target = { root: r.repo.root, hash: r.info.head };
      const ref = r.refs.find((x) => x.short === t || x.name === t);
      if (!target && ref) target = { root: r.repo.root, hash: ref.hash };
      if (target) break;
    }
    if (!target && /^[0-9a-f]{4,40}$/i.test(t)) {
      const row = this.data.findHashPrefix(t);
      if (row >= 0 && (!onlyRoot || this.data.rootOf(row).repo.root === onlyRoot)) return { row, hash: this.data.hashOf(row), root: this.data.rootOf(row).repo.root };
    }
    if (!target) {
      for (const r of roots) {
        const res = await r.repo.run(['rev-parse', '--verify', '--quiet', `${t}^{commit}`], { quiet: true, allowFail: true });
        if (res.code === 0) {
          target = { root: r.repo.root, hash: res.stdout.trim() };
          break;
        }
      }
    }
    if (!target) return { row: -1, message: `Commit or reference '${t}' not found` };
    let row = this.data.row(target.root, target.hash);
    while (row < 0 && this.data.hasMore && !this.disposed) {
      await this.request('more');
      row = this.data.row(target.root, target.hash);
    }
    if (row >= 0) return { row, ...target };
    return { row: -1, ...target, message: hasAnyFilter(this.filters) ? `Commit or reference '${t}' doesn't match the filters` : `Commit or reference '${t}' not found` };
  }

  private repoOf(root: string): Repository {
    const r = this.ctx.repos.get(root);
    if (!r) throw new Error(`${root} is not a Git repository`);
    return r;
  }

  private handlers() {
    const guard =
      <P, R>(title: string, fn: (p: P) => Promise<R> | R) =>
      async (p: P): Promise<R | undefined> => {
        try {
          return await fn(p);
        } catch (e) {
          showGitError(e, title);
          return undefined;
        }
      };
    return {
      state: () => this.ready.then(() => this.state()),
      rows: async (p: RowsRequest): Promise<RowsResult> => {
        await this.ready;
        const settings = readSettings();
        const rows = await this.data.rows(p.from, p.to, settings);
        return { version: this.data.version, rowCount: this.data.count, rows };
      },
      loadMore: async () => {
        await this.request('more');
        return this.state();
      },
      refresh: async () => {
        await this.request('refresh');
        return this.state();
      },
      setFilters: (f: LogFilters) => this.setFilters(f),
      setOptions: (o: Partial<LogViewOptions>) => {
        this.options = { ...this.options, ...o };
        this.persist();
        this.emitState();
        return this.state();
      },
      setSetting: (p: { key: LogSettingKey; value: unknown }) => writeSetting(p.key, p.value),
      details: (p: { commits: CommitId[] }) => this.data.details(p.commits ?? []),
      containingBranches: (p: CommitId) => this.data.containingBranches(p.root, p.hash),
      changes: (p: ChangesRequest) => {
        const affected = new Map<string, string[]>();
        if (this.opts.init.mode === 'history' && this.options.showOnlyAffectedChanges) for (const r of this.data.visible) affected.set(r.repo.root, r.paths);
        return computeChanges(this.data, p, p.showChangesToParents ?? this.options.showChangesToParents, affected);
      },
      showDiff: guard('Cannot show diff', (p: ShowDiffRequest) => showDiff(p)),
      openFileAtRevision: guard('Cannot open file', (p: FileAtRevision) => invoke('jbGit.openFileAtRevision', { repoRoot: p.root, path: p.path, rev: p.rev })),
      annotate: guard('Cannot annotate', (p: FileAtRevision) => vscode.commands.executeCommand('jbGit.annotate.revision', { repoRoot: p.root, path: p.path, rev: p.rev })),
      showHistory: guard('Cannot show history', (p: { root: string; path: string; revision?: string }) =>
        invoke('jbGit.log.show', { repoRoot: p.root, paths: [p.path], editorTab: true, revision: p.revision }),
      ),
      historyUpTo: guard('Cannot show history', (p: HistoryUpToRequest) => this.historyUpTo(p)),
      historyInfo: async (p: CommitId) => {
        await this.ready;
        return this.fileHistory.info(p);
      },
      historyAction: guard('Operation failed', async (p: HistoryActionRequest) => {
        await this.ready;
        return this.fileHistory.run(p);
      }),
      compareWithLocalFile: guard('Cannot compare', (p: FileAtRevision) => invoke('jbGit.compare.fileWithRevision', { repoRoot: p.root, path: p.path, rev: p.rev })),
      openFile: guard('Cannot open file', async (p: { root: string; path: string }) => {
        const uri = vscode.Uri.file(this.repoOf(p.root).abs(p.path));
        await vscode.window.showTextDocument(uri, { preview: true });
      }),
      getFromRevision: guard('Get Version failed', (p: FilesAtRevision) => getFromRevision(this.repoOf(p.root), p)),
      revertSelectedChanges: guard('Failed to revert changes', (p: FilesAtRevision) => applySelectedChanges(this.repoOf(p.root), p, true)),
      cherryPickSelectedChanges: guard('Failed to apply changes', (p: FilesAtRevision) => applySelectedChanges(this.repoOf(p.root), p, false)),
      commitOp: guard('Operation failed', (p: CommitOpRequest) => this.commitOp(p)),
      refOp: guard('Operation failed', (p: RefOpRequest) => this.refOp(p)),
      compareVersions: guard('Cannot compare', (p: { commits: CommitId[] }) => this.compareVersions(p.commits)),
      compareWithLocal: guard('Cannot compare', (p: CommitId) => invoke('jbGit.changes.show', { repoRoot: p.root, from: p.hash, title: `${p.hash.slice(0, 8)} ↔ Local Changes` })),
      refs: () => this.ready.then(() => this.refs()),
      toggleFavorite: (p: { root: string; name: string }) => this.toggleFavorite(p.root, p.name),
      users: () => this.ready.then(() => this.users()),
      paths: (p: { query: string; limit?: number }) => this.paths(p.query ?? '', p.limit ?? 50),
      goTo: (p: { text: string; root?: string }) => this.goTo(p.text ?? '', p.root),
      search: async (p: SearchRequest) => ({ row: await this.data.search(p.text ?? '', p.from ?? -1, !!p.backward, p.regex, p.matchCase) }),
      copy: (p: { text: string }) => vscode.env.clipboard.writeText(p.text ?? ''),
      /** rows of commits in the current list (-1 = not loaded); used to keep the selection across reloads */
      rowsOf: async (p: { commits: CommitId[] }) => {
        await this.ready;
        return (p.commits ?? []).map((c) => this.data.row(c.root, c.hash));
      },
      fileContents: (p: FileContentsRequest) => fileContents(this.repoOf(p.root), p),
      cherryPicked: (p: CherryPickedRequest) => cherryPicked(this.repoOf(p.root), p.branch),
      /** Paths filter "Select in Tree…": folder/file chooser, returns absolute paths with forward slashes */
      selectFolders: async () => {
        const first = this.data.visible[0]?.repo.root ?? this.repos()[0]?.root;
        const picked = await vscode.window.showOpenDialog({
          title: 'Select Paths to Filter by',
          canSelectFiles: true,
          canSelectFolders: true,
          canSelectMany: true,
          defaultUri: first ? vscode.Uri.file(first) : undefined,
          openLabel: 'OK',
        });
        return (picked ?? []).map((u) => u.fsPath.split(path.sep).join('/'));
      },
      openInEditorTab: () => this.opts.openEditor(this.filters),
      showConsole: () => vscode.commands.executeCommand('jbGit.log.showConsoleTab'),
      /** empty log "Commit local changes" link */
      commitLocalChanges: () => invoke('jbGit.commit.focus', {}),
    };
  }

  private async commitOp(p: CommitOpRequest): Promise<unknown> {
    const roots = new Set(p.commits.map((c) => c.root));
    if (roots.size !== 1) {
      vscode.window.showWarningMessage('Select commits from a single repository.');
      return;
    }
    const args = { repoRoot: p.commits[0].root, hashes: p.commits.map((c) => c.hash) };
    if (p.op === 'repoAtRevision') return invoke('jbGit.repoAtRevision', args);
    const id = `jbGit.commit.${p.op}` as keyof Commands;
    return vscode.commands.executeCommand(id, args);
  }

  private async refOp(p: RefOpRequest): Promise<unknown> {
    const a = { repoRoot: p.root, ref: p.ref };
    switch (p.op) {
      case 'actions':
        return invoke('jbGit.branch.actions', a);
      case 'checkout':
        return invoke('jbGit.branch.checkout', a);
      case 'newBranch':
        return invoke('jbGit.branch.new', a);
      case 'newTag':
        return invoke('jbGit.tag.new', a);
      case 'delete':
        return invoke('jbGit.branch.delete', a);
      case 'deleteTag':
        return invoke('jbGit.tag.delete', a);
      case 'rename':
        return invoke('jbGit.branch.rename', a);
      case 'merge':
        return invoke('jbGit.merge', a);
      case 'rebase':
        return invoke('jbGit.rebase', a);
      case 'compareWithCurrent':
        return invoke('jbGit.compare.withCurrent', a);
      case 'push':
        // a local branch node pushes that branch (jbGit.sync.pushBranch); HEAD / no ref pushes the current branch
        return p.ref && p.ref !== 'HEAD'
          ? vscode.commands.executeCommand('jbGit.sync.pushBranch', { repoRoot: p.root, branch: p.ref })
          : invoke('jbGit.push', { repoRoot: p.root });
      case 'fetch':
        return invoke('jbGit.fetch', { repoRoot: p.root });
      case 'pull':
        return invoke('jbGit.pull', { repoRoot: p.root });
      case 'updateProject':
        return invoke('jbGit.updateProject', { repoRoot: p.root });
      case 'checkoutAndRebase':
        return p.ref && checkoutAndRebase(this.repoOf(p.root), p.ref);
      case 'showDiffWithWorkingTree':
        return vscode.commands.executeCommand('jbGit.compare.withWorkingTree', a);
      case 'update':
        return p.ref && updateBranch(this.repoOf(p.root), p.ref);
      case 'pullRebase':
      case 'pullMerge':
        return p.ref && pullInto(this.repoOf(p.root), p.ref, p.op === 'pullRebase');
    }
  }

  /** Vcs.ShowHistoryForRevision: a History tab of the file limited to commits reachable from the revision. */
  private async historyUpTo(p: HistoryUpToRequest): Promise<unknown> {
    // inside a History tab, an older name of its file means the file itself: keep following renames from its current name
    const rd = this.data.roots.find((r) => r.repo.root === p.root);
    const current = this.opts.init.mode === 'history' && rd && rd.paths.length && !rd.paths.includes('.') && rd.paths.includes(p.path) && this.opts.init.historyPaths?.length === 1 ? rd.paths[0] : p.path;
    const base = current.slice(current.lastIndexOf('/') + 1) || current;
    return invoke('jbGit.log.show', {
      repoRoot: p.root,
      paths: [current],
      editorTab: true,
      branches: [p.revision],
      revision: p.revision,
      title: `History: ${base} (${p.revision.slice(0, 8)})`,
    });
  }

  /** "Compare Versions" of two selected commits: older → newer in the changes view. */
  private async compareVersions(commits: CommitId[]): Promise<unknown> {
    if (commits.length !== 2 || commits[0].root !== commits[1].root) {
      vscode.window.showWarningMessage('Select two commits from the same repository.');
      return;
    }
    const [a, b] = commits.map((c) => ({ c, row: this.data.row(c.root, c.hash) }));
    const [newer, older] = a.row >= 0 && b.row >= 0 && b.row < a.row ? [b.c, a.c] : [a.c, b.c];
    return invoke('jbGit.changes.show', {
      repoRoot: newer.root,
      from: older.hash,
      to: newer.hash,
      title: `${older.hash.slice(0, 8)} ↔ ${newer.hash.slice(0, 8)}`,
    });
  }

  private async refs(): Promise<RefsInfo[]> {
    return Promise.all(
      this.data.roots.map(async (r) => {
        const current = r.info.branch;
        const reflog = await r.repo.run(['reflog', '-n', '300', '--format=%gs'], { quiet: true, allowFail: true });
        const local = r.refs.filter((x) => x.type === 'head');
        const recent = recentBranches(reflog.stdout, new Set(local.map((x) => x.short)));
        return {
          root: r.repo.root,
          name: r.info.name,
          current,
          head: r.info.head,
          detached: r.info.detached,
          local: local.map((x) => toRefItem(x, current, r.favorites)),
          remote: r.refs.filter((x) => x.type === 'remote').map((x) => toRefItem(x, current, r.favorites)),
          tags: r.refs.filter((x) => x.type === 'tag').map((x) => toRefItem(x, current, r.favorites)),
          recent,
          favorites: [...r.favorites],
        };
      }),
    );
  }

  private async toggleFavorite(root: string, name: string): Promise<void> {
    const store = { ...(this.ctx.extension.workspaceState.get<Record<string, string[]>>(FAVORITES_KEY) ?? {}) };
    const r = this.data.roots.find((x) => x.repo.root === root);
    const set = new Set(store[root] ?? (r ? [...r.favorites] : []));
    if (set.has(name)) set.delete(name);
    else set.add(name);
    store[root] = [...set];
    await this.ctx.extension.workspaceState.update(FAVORITES_KEY, store);
    await this.request('refresh');
  }

  private async users(): Promise<UsersResult> {
    const outs = await Promise.all(
      this.data.visible.map(async (r) => {
        if (r.info.empty) return '';
        const args = ['shortlog', '-sne', '--branches', '--remotes', '--tags'];
        if (r.info.head) args.push('HEAD');
        return (await r.repo.run(args, { quiet: true, allowFail: true })).stdout;
      }),
    );
    const me = this.data.roots.map((r) => r.info.me).filter((m) => m.name || m.email);
    return { users: parseShortlog(outs.join('\n')), me };
  }

  /** Path filter suggestions: tracked files and their folders containing `query` (prefix matches first). */
  private async paths(query: string, limit: number): Promise<PathSuggestion[]> {
    await this.ready;
    const q = query.trim().toLowerCase().replace(/\\/g, '/');
    const out: (PathSuggestion & { score: number })[] = [];
    for (const r of this.data.roots) {
      const root = r.repo.root;
      let files = this.lsFiles.get(root);
      if (!files) {
        files = r.repo.run(['ls-files', '-z'], { quiet: true, allowFail: true }).then((x) => x.stdout.split('\0').filter(Boolean));
        this.lsFiles.set(root, files);
      }
      const list = await files;
      const dirs = new Set<string>();
      for (const f of list) {
        let i = f.lastIndexOf('/');
        while (i > 0) {
          const d = f.slice(0, i);
          if (dirs.has(d)) break;
          dirs.add(d);
          i = d.lastIndexOf('/');
        }
      }
      const absRoot = root.split(path.sep).join('/');
      const consider = (p: string, dir: boolean) => {
        const lp = p.toLowerCase();
        const at = q ? lp.indexOf(q) : 0;
        if (at < 0) return;
        const base = lp.slice(lp.lastIndexOf('/') + 1);
        const score = (base.startsWith(q) ? 0 : at === 0 ? 1 : 2) * 10000 + p.length;
        out.push({ root, path: p, abs: `${absRoot}/${p}`, dir, score });
      };
      for (const d of dirs) consider(d, true);
      for (const f of list) consider(f, false);
    }
    out.sort((a, b) => a.score - b.score || a.path.localeCompare(b.path));
    return out.slice(0, limit).map(({ score: _s, ...p }) => p);
  }

  dispose(): void {
    this.disposed = true;
    clearTimeout(this.refreshTimer);
    for (const d of this.disposables) d.dispose();
  }
}

function normalizeFilters(f: LogFilters): LogFilters {
  const out: LogFilters = {};
  const list = (v: string[] | undefined) => (v?.length ? [...new Set(v.filter((x) => typeof x === 'string' && x))] : undefined);
  if (list(f.branches)) out.branches = list(f.branches);
  if (list(f.users)) out.users = list(f.users);
  if (list(f.paths)) out.paths = list(f.paths)!.map((p) => p.replace(/\\/g, '/'));
  if (list(f.roots)) out.roots = list(f.roots);
  if (typeof f.since === 'number' && f.since > 0) out.since = f.since;
  if (typeof f.until === 'number' && f.until > 0) out.until = f.until;
  if (f.text?.trim()) out.text = f.text;
  if (f.regex) out.regex = true;
  if (f.matchCase) out.matchCase = true;
  return out;
}
