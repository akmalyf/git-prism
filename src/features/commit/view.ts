// Commit tool window host (WebviewView "jbGit.commitView"): collects the local changes of every repository into
// the view model (changelists or staging area), persists inclusion / changelists / drafts, and executes the
// toolbar, context menu and commit actions requested by the webview (src/webview/commit).
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { FeatureContext } from '../../core/context';
import { invoke } from '../../core/contracts';
import { showGitError } from '../../core/git';
import type { Repository } from '../../core/repository';
import type { Status } from '../../core/types';
import { RpcBridge, webviewHtml } from '../../core/webview';
import { filesCommittedText, diffFile, partialCommitImpossible, stageDiffFile, subjectOf, validateCommit, validateStagedCommit } from './logic';
import { CommitDiffPanel, type DiffHost } from './diffPanel';
import * as ops from './ops';
import { fileState, pruneExcluded } from './partial';
import { fileKey, itemKey, type CommitOptions, type CommitRequest, type Item, type ItemOp, type RepoInfo, type ViewModel, type ViewSettings } from './protocol';
import { CommitStore } from './store';
import { ThreeWayPanel } from './threeWay';

export const VIEW_ID = 'jbGit.commitView';

export class CommitView implements vscode.WebviewViewProvider, vscode.Disposable {
  private view: vscode.WebviewView | undefined;
  private bridge: RpcBridge | undefined;
  private readyResolve: (() => void) | undefined;
  private ready: Promise<void>;
  private readonly store: CommitStore;
  private vm: ViewModel;
  private timer: NodeJS.Timeout | undefined;
  private refreshing: Promise<void> | undefined;
  private dirty = false;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(private readonly ctx: FeatureContext) {
    this.store = new CommitStore(ctx.extension.workspaceState);
    this.ready = new Promise((r) => (this.readyResolve = r));
    this.vm = { loading: true, repos: [], lists: this.store.model.sorted(), items: [], settings: this.store.settings, options: this.store.options, stagingDraft: this.store.stagingDraft };
    this.disposables.push(
      ctx.repos.onDidChangeRepository(() => this.scheduleRefresh()),
      ctx.repos.onDidChangeRepositories(() => this.scheduleRefresh()),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (!e.affectsConfiguration('jbGit.commit')) return;
        this.updateContext();
        this.scheduleRefresh(0);
      }),
    );
    this.updateContext();
    this.scheduleRefresh(0);
  }

  // ---------------------------------------------------------------- webview

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    const ext = this.ctx.extension.extensionUri;
    view.webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(ext, 'dist', 'media')] };
    this.bridge?.dispose();
    this.bridge = new RpcBridge(view.webview, this.handlers());
    view.webview.html = webviewHtml(view.webview, ext, 'commit', { locale: vscode.env.language, isMac: process.platform === 'darwin' }, 'Commit');
    view.onDidDispose(() => {
      this.bridge?.dispose();
      this.bridge = undefined;
      this.view = undefined;
      this.ready = new Promise((r) => (this.readyResolve = r));
    });
    view.onDidChangeVisibility(() => {
      if (view.visible) this.scheduleRefresh(0);
    });
  }

  /** Reveals the view and waits until the page is listening. */
  async reveal(): Promise<boolean> {
    await vscode.commands.executeCommand(`${VIEW_ID}.focus`);
    const ok = await Promise.race([this.ready.then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), 8000))]);
    return ok;
  }

  async post(event: string, data?: unknown): Promise<void> {
    await this.ready;
    this.bridge?.emit(event, data);
  }

  // ---------------------------------------------------------------- model

  scheduleRefresh(delay = 150): void {
    clearTimeout(this.timer);
    // background changes only matter while the view is shown (it refreshes when it becomes visible again)
    this.timer = setTimeout(() => {
      if (this.view?.visible) void this.refresh();
    }, delay);
  }

  async refresh(): Promise<void> {
    if (this.refreshing) {
      this.dirty = true;
      return this.refreshing;
    }
    this.refreshing = (async () => {
      do {
        this.dirty = false;
        try {
          this.vm = await this.collect();
        } catch (e) {
          showGitError(e, 'Failed to refresh changes');
        }
        this.bridge?.emit('state', this.vm);
      } while (this.dirty);
    })().finally(() => (this.refreshing = undefined));
    return this.refreshing;
  }

  private async collect(): Promise<ViewModel> {
    await this.ctx.repos.ready();
    const settings = this.store.settings;
    const model = this.store.model;
    const repos: RepoInfo[] = [];
    const items: Item[] = [];
    const tracked: string[] = [];
    const unversioned: string[] = [];
    const statuses: { repo: Repository; status: Status }[] = [];
    for (const repo of this.ctx.repos.all) {
      let status: Status;
      try {
        status = await repo.status({ ignored: settings.showIgnored });
      } catch {
        continue;
      }
      statuses.push({ repo, status });
      repos.push({ root: repo.root, name: repo.name, branch: status.branch.head, head: status.branch.oid, empty: !status.branch.oid, operation: repo.operationState() });
      for (const e of status.entries) {
        if (e.kind === '?') unversioned.push(fileKey(repo.root, e.path));
        else if (e.kind !== '!' && e.kind !== 'U') tracked.push(fileKey(repo.root, e.path));
      }
    }
    if (model.sync(tracked, unversioned)) void this.store.saveLists();
    for (const { repo, status } of statuses) {
      const r = repo.root;
      for (const e of status.entries) {
        const fk = fileKey(r, e.path);
        if (e.kind === 'U') items.push({ key: itemKey('conflict', r, e.path), repo: r, path: e.path, kind: 'U', area: 'conflict', conflict: e.conflict });
        else if (e.kind === '?') items.push({ key: itemKey('untracked', r, e.path), repo: r, path: e.path, kind: '?', area: 'untracked', included: model.isIncluded(fk, true) });
        else if (e.kind === '!') items.push({ key: itemKey('ignored', r, e.path), repo: r, path: e.path, kind: '!', area: 'ignored' });
        else if (!settings.stagingArea) {
          items.push({ key: itemKey('changes', r, e.path), repo: r, path: e.path, oldPath: e.oldPath, kind: e.kind, area: 'changes', list: model.listOf(fk), included: model.isIncluded(fk, false) });
        } else {
          if (e.index !== '.') items.push({ key: itemKey('staged', r, e.path), repo: r, path: e.path, oldPath: e.oldPath, kind: e.index, area: 'staged' });
          if (e.worktree !== '.') items.push({ key: itemKey('unstaged', r, e.path), repo: r, path: e.path, kind: e.worktree, area: 'unstaged' });
        }
      }
    }
    if (!settings.stagingArea && (await this.syncPartial(items, repos))) void this.store.saveLists();
    return { loading: false, repos, lists: model.sorted(), items, settings, options: this.store.options, stagingDraft: this.store.stagingDraft };
  }

  /**
   * Validates the stored excluded lines against the current changes and marks partially included items. Files whose
   * lines are all excluded become unchecked; stale entries are dropped. Returns true when inclusion changed.
   */
  private async syncPartial(items: Item[], repos: RepoInfo[]): Promise<boolean> {
    const stored = this.store.excludedLines;
    if (!Object.keys(stored).length) return false;
    const updates: Record<string, string[]> = {};
    const live = new Set<string>();
    let changed = false;
    for (const it of items) {
      if (it.area !== 'changes') continue;
      const fk = fileKey(it.repo, it.path);
      const ex = stored[fk];
      if (!ex?.length) continue;
      live.add(fk);
      const info = repos.find((r) => r.root === it.repo);
      const repo = this.repo(it.repo);
      if (!repo || !info || info.empty || it.kind !== 'M' || !it.included || partialCommitImpossible(info.operation)) {
        updates[fk] = [];
        continue;
      }
      let hunks;
      try {
        hunks = (await ops.fileDiff(repo, it.path)).hunks;
      } catch {
        continue;
      }
      const kept = pruneExcluded(hunks, ex);
      const state = fileState(hunks, new Set(kept));
      if (state === 'off') {
        this.store.model.setIncluded([fk], false, () => false);
        it.included = false;
        updates[fk] = [];
        changed = true;
      } else if (state === 'on') updates[fk] = [];
      else {
        it.partial = true;
        if (kept.length !== ex.length) updates[fk] = kept;
      }
    }
    for (const fk of Object.keys(stored)) if (!live.has(fk)) updates[fk] = [];
    if (Object.keys(updates).length) await this.store.setExcludedLines(updates);
    return changed;
  }

  /** Callbacks of the Commit diff window. */
  private diffHost(): DiffHost {
    return {
      item: (key) => this.vm.items.find((i) => i.key === key),
      repo: (root) => this.repo(root),
      hasHead: (root) => this.hasHead(root),
      excludedOf: (it) => this.store.excludedOf(fileKey(it.repo, it.path)),
      linesDisabled: (root) => partialCommitImpossible(this.vm.repos.find((r) => r.root === root)?.operation ?? 'none'),
      applyLines: async (it, excluded, all) => {
        const fk = fileKey(it.repo, it.path);
        const ex = new Set(excluded);
        const none = all.every((k) => ex.has(k));
        this.store.model.setIncluded([fk], !none, () => it.area === 'untracked');
        await this.store.setExcludedLines({ [fk]: none || !ex.size ? [] : [...ex] });
        await this.store.saveLists();
        await this.refresh();
      },
      setFileIncluded: async (it, included) => {
        const fk = fileKey(it.repo, it.path);
        this.store.model.setIncluded([fk], included, () => it.area === 'untracked');
        await this.store.clearExcludedLines([fk]);
        await this.store.saveLists();
        await this.refresh();
      },
      refresh: () => this.refresh(),
    };
  }

  private items(keys: readonly string[]): Item[] {
    const set = new Set(keys);
    return this.vm.items.filter((i) => set.has(i.key));
  }

  private repo(root: string): Repository | undefined {
    return this.ctx.repos.get(root);
  }

  private hasHead(root: string): boolean {
    const r = this.vm.repos.find((x) => x.root === root);
    return !!r && !r.empty;
  }

  /** Items grouped by repository. */
  private byRepo(items: readonly Item[]): { repo: Repository; items: Item[] }[] {
    const map = new Map<string, Item[]>();
    for (const it of items) {
      let l = map.get(it.repo);
      if (!l) map.set(it.repo, (l = []));
      l.push(it);
    }
    const out: { repo: Repository; items: Item[] }[] = [];
    for (const [root, list] of map) {
      const repo = this.repo(root);
      if (repo) out.push({ repo, items: list });
    }
    return out;
  }

  private updateContext(): void {
    const s = this.store.settings;
    vscode.commands.executeCommand('setContext', 'jbGit.commit.showIgnored', s.showIgnored);
    vscode.commands.executeCommand('setContext', 'jbGit.commit.doubleClickSource', s.doubleClick === 'source');
    vscode.commands.executeCommand('setContext', 'jbGit.commit.previewDiff', s.previewDiff);
    vscode.commands.executeCommand('setContext', 'jbGit.commit.stagingArea', s.stagingArea);
    vscode.commands.executeCommand('setContext', 'jbGit.commit.commitAll', s.commitAll);
  }

  async setSetting<K extends keyof ViewSettings>(key: K, value: ViewSettings[K]): Promise<void> {
    await this.store.setSetting(key, value);
    this.updateContext();
    await this.refresh();
  }

  get settings(): ViewSettings {
    return this.store.settings;
  }

  // ---------------------------------------------------------------- entry points from commands

  /** Items (changes / unversioned / staged / unstaged / conflicts) at or below the given absolute paths. */
  itemsUnder(uris: readonly vscode.Uri[], areas?: Item['area'][]): Item[] {
    const out: Item[] = [];
    for (const it of this.vm.items) {
      if (areas && !areas.includes(it.area)) continue;
      const abs = path.join(it.repo, ...it.path.split('/'));
      if (uris.some((u) => abs === u.fsPath || abs.startsWith(u.fsPath.replace(/[\\/]+$/, '') + path.sep))) out.push(it);
    }
    return out;
  }

  async commitFiles(uris: vscode.Uri[]): Promise<void> {
    await this.refresh();
    const items = this.itemsUnder(uris, ['changes', 'untracked', 'staged', 'unstaged']);
    if (!items.length) {
      vscode.window.showInformationMessage('No changes detected');
      return;
    }
    if (!this.vm.settings.stagingArea) {
      const tracked = this.vm.items.filter((i) => i.area === 'changes').map((i) => fileKey(i.repo, i.path));
      const unv = this.vm.items.filter((i) => i.area === 'untracked').map((i) => fileKey(i.repo, i.path));
      this.store.model.includeOnly(items.map((i) => fileKey(i.repo, i.path)), tracked, unv);
      await this.store.saveLists();
      await this.refresh();
    }
    if (await this.reveal()) await this.post('select', { keys: items.map((i) => i.key), focusMessage: true });
  }

  async rollbackFiles(uris: vscode.Uri[]): Promise<void> {
    await this.refresh();
    const items = this.itemsUnder(uris, ['changes', 'staged', 'unstaged', 'conflict']);
    if (!items.length) {
      vscode.window.showInformationMessage('No changes detected');
      return;
    }
    if (await this.reveal()) await this.post('rollback', { keys: items.map((i) => i.key) });
  }

  /** Commit and Push… (Cmd/Ctrl+Alt+K outside the Commit view). */
  async commitAndPush(): Promise<void> {
    if (await this.reveal()) await this.post('commit', { push: true });
  }

  /** Show Staged Version / Compare with Staged Version / 3 versions for files (editor, explorer). */
  async stageFileAction(op: 'showStaged' | 'compareLocalStaged' | 'threeWay', uris: vscode.Uri[]): Promise<void> {
    await this.refresh();
    let items: Item[] = [];
    const tracked: Item[] = [];
    for (const u of uris) {
      const repo = this.ctx.repos.forUri(u);
      if (!repo) continue;
      const rel = repo.rel(u.fsPath);
      if (!(await ops.indexEntry(repo, rel).catch(() => undefined))) continue;
      const own = this.vm.items.filter((i) => i.repo === repo.root && i.path === rel && (i.area === 'staged' || i.area === 'unstaged'));
      // an unmodified file still has a staged version (equal to HEAD and Local)
      tracked.push(...(own.length ? own : [{ key: itemKey('unstaged', repo.root, rel), repo: repo.root, path: rel, kind: 'M', area: 'unstaged' } satisfies Item]));
    }
    items = op === 'compareLocalStaged' ? tracked.filter((i, n) => tracked.findIndex((x) => x.repo === i.repo && x.path === i.path) === n) : tracked;
    if (!items.length) {
      vscode.window.showInformationMessage('The file is not in the Git index');
      return;
    }
    if (op === 'compareLocalStaged') items = items.map((i) => ({ ...i, area: 'unstaged', kind: i.kind === 'D' && i.area === 'staged' ? 'M' : i.kind }));
    await this.runOp(op, items);
  }

  async focus(args: { repoRoot?: string; message?: string }): Promise<void> {
    if (!(await this.reveal())) return;
    if (args.message !== undefined) await this.post('setMessage', { message: args.message });
    else await this.post('focusMessage');
  }

  // ---------------------------------------------------------------- rpc handlers

  private handlers() {
    return {
      ready: () => {
        this.readyResolve?.();
        this.scheduleRefresh(0);
        return this.vm;
      },
      refresh: () => this.refresh(),
      setIncluded: async (p: { keys: string[]; included: boolean }) => {
        const unv = new Set(this.vm.items.filter((i) => i.area === 'untracked').map((i) => fileKey(i.repo, i.path)));
        const keys = this.items(p.keys).map((i) => fileKey(i.repo, i.path));
        this.store.model.setIncluded(keys, p.included, (k) => unv.has(k));
        let partial = false;
        for (const it of this.items(p.keys)) {
          it.included = p.included;
          partial ||= !!it.partial;
          it.partial = false;
        }
        await this.store.clearExcludedLines(keys);
        await this.store.saveLists();
        // a partially included file becomes fully included / excluded: redraw its checkbox
        if (partial) this.bridge?.emit('state', this.vm);
      },
      includeOnly: async (p: { keys: string[] }) => {
        const tracked = this.vm.items.filter((i) => i.area === 'changes').map((i) => fileKey(i.repo, i.path));
        const unv = this.vm.items.filter((i) => i.area === 'untracked').map((i) => fileKey(i.repo, i.path));
        const only = this.items(p.keys).map((i) => fileKey(i.repo, i.path));
        this.store.model.includeOnly(only, tracked, unv);
        await this.store.clearExcludedLines(only);
        await this.store.saveLists();
        await this.refresh();
      },
      setSetting: (p: { key: keyof ViewSettings; value: never }) => this.setSetting(p.key, p.value),
      setOptions: (o: CommitOptions) => this.store.setOptions(o),
      setDraft: async (p: { list?: string; text: string }) => {
        if (p.list) {
          this.store.model.setComment(p.list, p.text);
          await this.store.saveLists();
        } else await this.store.setStagingDraft(p.text);
      },
      commit: (req: CommitRequest) => this.commit(req),
      amendMessage: async (p: { repo: string }) => {
        const repo = this.repo(p.repo);
        return repo ? ops.headMessage(repo) : '';
      },
      amendableCommits: async (p: { repo: string }) => {
        const repo = this.repo(p.repo);
        return repo ? ops.amendableCommits(repo) : [];
      },
      commitMessage: async (p: { repo: string; hash: string }) => {
        const repo = this.repo(p.repo);
        if (!repo) return '';
        return (await repo.run(['log', '-1', '--format=%B', p.hash], { quiet: true })).stdout.replace(/\s+$/, '');
      },
      history: async (p: { repo?: string }) => {
        const repo = p.repo ? this.repo(p.repo) : this.ctx.repos.all[0];
        const recent = repo && this.hasHead(repo.root) ? await ops.recentMessages(repo) : [];
        return { messages: this.store.history, recent };
      },
      identity: async (p: { repo?: string }) => {
        const repo = (p.repo && this.repo(p.repo)) || this.ctx.repos.all[0];
        if (!repo) return '';
        const [name, email] = await Promise.all([repo.config('user.name'), repo.config('user.email')]);
        return name ? `${name}${email ? ` <${email}>` : ''}` : '';
      },
      authors: async () => {
        const all = new Set<string>();
        for (const r of this.ctx.repos.all) if (this.hasHead(r.root)) for (const a of await ops.knownAuthors(r)) all.add(a);
        return [...all];
      },
      showDiff: (p: { keys: string[]; index: number; preview?: boolean }) => this.showDiff(p.keys, p.index),
      open: (p: { keys: string[] }) => this.openFiles(this.items(p.keys)),
      op: (p: { op: ItemOp; keys: string[] }) => this.runOp(p.op, this.items(p.keys)),
      rollback: (p: { keys: string[]; deleteAdded: boolean }) => this.rollback(this.items(p.keys), p.deleteAdded),
      ignoreTargets: (p: { keys: string[] }) => {
        const groups = this.byRepo(this.items(p.keys));
        if (groups.length !== 1) return [];
        return ops.ignoreTargets(groups[0].repo, groups[0].items.map((i) => i.path));
      },
      addToIgnore: (p: { keys: string[]; target: ops.IgnoreTarget }) => this.addToIgnore(this.items(p.keys), p.target),
      activeFile: () => {
        const uri = vscode.window.activeTextEditor?.document.uri;
        if (!uri || uri.scheme !== 'file') return undefined;
        const repo = this.ctx.repos.forUri(uri);
        return repo ? { repo: repo.root, path: repo.rel(uri.fsPath) } : undefined;
      },
      stageAll: (p: { repos?: string[]; tracked: boolean }) => this.forRepos(p.repos, (r) => ops.stageAll(r, p.tracked), 'Failed to Stage Files'),
      unstageAll: (p: { repos?: string[] }) => {
        const withStaged = [...new Set(this.vm.items.filter((i) => i.area === 'staged').map((i) => i.repo))];
        return this.forRepos(p.repos ?? withStaged, (r) => ops.unstageAll(r, this.hasHead(r.root)), 'Failed to Unstage Files');
      },
      newChangelist: async (p: { name: string; comment: string; active: boolean; move?: string[] }) => {
        const l = this.store.model.add(p.name, p.comment, p.active);
        if (p.move?.length) this.store.model.move(this.items(p.move).map((i) => fileKey(i.repo, i.path)), l.id);
        await this.store.saveLists();
        await this.refresh();
        return l;
      },
      editChangelist: async (p: { id: string; name: string; comment: string; active: boolean }) => {
        this.store.model.edit(p.id, p.name, p.comment, p.active);
        await this.store.saveLists();
        await this.refresh();
      },
      removeChangelists: async (p: { ids: string[] }) => {
        this.store.model.remove(p.ids);
        await this.store.saveLists();
        await this.refresh();
      },
      setActiveChangelist: async (p: { id: string }) => {
        this.store.model.setActive(p.id);
        await this.store.saveLists();
        await this.refresh();
      },
      moveToChangelist: async (p: { keys: string[]; list: string }) => {
        this.store.model.move(this.items(p.keys).map((i) => fileKey(i.repo, i.path)), p.list);
        await this.store.saveLists();
        await this.refresh();
      },
      updateProject: () => invoke('jbGit.updateProject', {}),
      stash: (p: { repo?: string }) => invoke('jbGit.stash.create', { repoRoot: p.repo }),
      resolveConflicts: (p: { repo?: string }) => invoke('jbGit.conflicts.resolve', { repoRoot: p.repo }),
      info: (p: { message: string }) => vscode.window.showInformationMessage(p.message),
    };
  }

  private async forRepos(roots: string[] | undefined, fn: (r: Repository) => Promise<void>, error: string): Promise<void> {
    const repos = (roots ?? this.vm.repos.map((r) => r.root)).map((r) => this.repo(r)).filter((r): r is Repository => !!r);
    try {
      for (const r of repos) await fn(r);
    } catch (e) {
      showGitError(e, error);
    }
    await this.refresh();
  }

  // ---------------------------------------------------------------- actions

  private async showDiff(keys: string[], index: number): Promise<void> {
    const items = this.items(keys);
    if (!items.length) return;
    const order = new Map(keys.map((k, i) => [k, i]));
    items.sort((a, b) => order.get(a.key)! - order.get(b.key)!);
    const sel = keys[index];
    const i = Math.max(0, items.findIndex((it) => it.key === sel));
    // changelist mode: IntelliJ's diff with "Include into commit" checkboxes per file and per changed chunk
    if (!this.vm.settings.stagingArea && items.every((it) => it.area === 'changes' || it.area === 'untracked')) {
      CommitDiffPanel.show(this.ctx, this.diffHost(), items, i);
      return;
    }
    await invoke('jbGit.diff.show', { files: items.map((it) => diffFile(it, this.hasHead(it.repo))), index: i });
  }

  /** Compare HEAD, Staged and Local Versions (one entry per file even when it is both staged and unstaged). */
  showThreeWay(items: Item[], index = 0): void {
    const seen = new Set<string>();
    const files = items.filter((it) => {
      if (it.area !== 'staged' && it.area !== 'unstaged') return false;
      const fk = fileKey(it.repo, it.path);
      if (seen.has(fk)) return false;
      seen.add(fk);
      return true;
    });
    if (!files.length) return;
    ThreeWayPanel.show(this.ctx, { repo: (r) => this.repo(r), hasHead: (r) => this.hasHead(r) }, files, Math.min(index, files.length - 1));
  }

  private async openFiles(items: Item[]): Promise<void> {
    const files = items.filter((i) => i.kind !== 'D');
    for (const it of files) {
      const uri = vscode.Uri.file(path.join(it.repo, ...it.path.split('/')));
      await vscode.commands.executeCommand('vscode.open', uri, { preview: files.length === 1, preserveFocus: false });
    }
  }

  private async runOp(op: ItemOp, items: Item[]): Promise<void> {
    if (!items.length) return;
    const groups = this.byRepo(items);
    try {
      switch (op) {
        case 'showDiff':
          return await this.showDiff(items.map((i) => i.key), 0);
        case 'jumpToSource':
          return await this.openFiles(items);
        case 'delete': {
          const files = items.filter((i) => i.kind !== 'D');
          if (!files.length) return;
          const what = files.length === 1 ? `'${path.posix.basename(files[0].path)}'` : `${files.length} files`;
          const ok = await vscode.window.showWarningMessage(`Delete ${what}?`, { modal: true }, 'Delete');
          if (ok !== 'Delete') return;
          for (const g of this.byRepo(files)) await ops.deleteFiles(g.repo, [...new Set(g.items.map((i) => i.path))]);
          break;
        }
        case 'add':
        case 'stage':
          for (const g of groups) await ops.stage(g.repo, [...new Set(g.items.map((i) => i.path))]);
          break;
        case 'addNoContent':
          for (const g of groups) await ops.execPaths(g.repo, ['add', '-N'], g.items.filter((i) => i.area === 'untracked').map((i) => i.path));
          break;
        case 'unstage':
          for (const g of groups) await ops.unstage(g.repo, g.items.filter((i) => i.area === 'staged'), this.hasHead(g.repo.root));
          break;
        case 'acceptTheirs':
        case 'acceptYours':
          for (const g of groups) await ops.acceptConflictSide(g.repo, g.items.filter((i) => i.area === 'conflict'), op === 'acceptTheirs' ? 'theirs' : 'ours');
          break;
        case 'merge': {
          const conflicts = items.filter((i) => i.area === 'conflict');
          if (conflicts.length === 1) await invoke('jbGit.conflicts.mergeFile', { repoRoot: conflicts[0].repo, path: conflicts[0].path });
          else await invoke('jbGit.conflicts.resolve', { repoRoot: conflicts[0]?.repo });
          return;
        }
        case 'createPatch':
          for (const g of groups) await invoke('jbGit.patch.create', { repoRoot: g.repo.root, paths: [...new Set(g.items.map((i) => i.path))] });
          return;
        case 'copyPatch': {
          let text = '';
          for (const g of groups) text += await ops.patchText(g.repo, g.items, this.hasHead(g.repo.root));
          await vscode.env.clipboard.writeText(text);
          vscode.window.setStatusBarMessage('Patch copied to clipboard', 3000);
          return;
        }
        case 'showHistory': {
          const it = items[0];
          await invoke('jbGit.log.show', { repoRoot: it.repo, paths: [it.path], editorTab: true, title: `History: ${path.posix.basename(it.path)}` });
          return;
        }
        case 'annotate': {
          const it = items.find((i) => i.kind !== 'D' && i.area !== 'untracked') ?? items[0];
          const uri = vscode.Uri.file(path.join(it.repo, ...it.path.split('/')));
          await vscode.window.showTextDocument(uri, { preview: true });
          await vscode.commands.executeCommand('jbGit.annotate.toggle', uri);
          return;
        }
        case 'shelve':
          for (const g of groups) await invoke('jbGit.shelf.shelve', { repoRoot: g.repo.root, paths: [...new Set(g.items.flatMap((i) => (i.oldPath ? [i.path, i.oldPath] : [i.path])))] });
          return;
        case 'stash':
          for (const g of groups) await invoke('jbGit.stash.create', { repoRoot: g.repo.root, paths: [...new Set(g.items.flatMap((i) => (i.oldPath ? [i.path, i.oldPath] : [i.path])))] });
          return;        case 'showStaged': {
          const it = items[0];
          await invoke('jbGit.openFileAtRevision', { repoRoot: it.repo, path: it.path, rev: ':0' });
          return;
        }
        case 'showLocal':
          return await this.openFiles(items.slice(0, 1));
        case 'compareLocalStaged':
        case 'compareStagedLocal':
        case 'compareStagedHead':
          await invoke('jbGit.diff.show', { files: items.map((it) => stageDiffFile(it, op, this.hasHead(it.repo))) });
          return;
        case 'threeWay':
          return this.showThreeWay(items);
      }
    } catch (e) {
      const titles: Partial<Record<ItemOp, string>> = {
        stage: 'Failed to Stage Files',
        add: 'Failed to add files',
        unstage: 'Failed to Unstage Files',
        delete: 'Delete failed',
        acceptTheirs: 'Accept Theirs failed',
        acceptYours: 'Accept Yours failed',
      };
      showGitError(e, titles[op] ?? 'Operation failed');
    }
    await this.refresh();
  }

  private async rollback(items: Item[], deleteAdded: boolean): Promise<void> {
    try {
      await vscode.window.withProgress({ location: { viewId: VIEW_ID }, title: 'Rollback' }, async () => {
        for (const g of this.byRepo(items)) await ops.rollback(g.repo, g.items, deleteAdded, this.hasHead(g.repo.root));
      });
    } catch (e) {
      showGitError(e, 'Rollback failed');
    }
    await this.refresh();
  }

  async addToIgnore(items: Item[], target: ops.IgnoreTarget): Promise<void> {
    const groups = this.byRepo(items);
    if (groups.length !== 1) return;
    const { repo } = groups[0];
    if (!target.exists) {
      const dir = target.dir ? repo.abs(target.dir) : repo.root;
      const ok = await vscode.window.showWarningMessage(`Create .gitignore file in ${dir}?`, { modal: true, detail: 'Create .gitignore' }, 'Create');
      if (ok !== 'Create') return;
    }
    try {
      await ops.addToIgnore(repo, target, [...new Set(groups[0].items.map((i) => i.path))]);
    } catch (e) {
      showGitError(e, 'Failed to update ignore file');
    }
    await this.refresh();
  }

  // ---------------------------------------------------------------- commit

  private async commit(req: CommitRequest): Promise<{ ok: boolean; error?: string }> {
    await this.refresh();
    const s = this.vm.settings;
    const message = req.message.replace(/\s+$/, '');
    let groups: { repo: Repository; items: Item[] }[];
    let all = false;
    if (s.stagingArea) {
      const staged = this.vm.items.filter((i) => i.area === 'staged');
      all = s.commitAll && !staged.length;
      const pool = all ? this.vm.items.filter((i) => i.area === 'unstaged' && i.kind !== '?') : staged;
      groups = this.byRepo(pool);
      const err = validateStagedCommit({ message, hasStaged: pool.length > 0, amend: req.amend });
      if (err) return { ok: false, error: err };
    } else {
      const included = this.items(req.keys).filter((i) => i.area === 'changes' || i.area === 'untracked');
      groups = this.byRepo(included);
      const err = validateCommit({ message, hasChanges: included.length > 0, amend: req.amend });
      if (err) return { ok: false, error: err };
    }
    if (!message.trim()) return { ok: false, error: 'Specify commit message' };
    if (req.amend && !groups.length) {
      const root = req.amendRepo ?? this.vm.repos.find((r) => !r.empty)?.root;
      const repo = root ? this.repo(root) : undefined;
      if (repo) groups = [{ repo, items: [] }];
    }
    if (!groups.length) return { ok: false, error: 'Nothing to commit' };
    if (req.amend && req.amendTarget && groups.some((g) => g.repo.root !== req.amendRepo)) {
      return { ok: false, error: 'Amending a specific commit is possible only for changes of its repository' };
    }

    // IntelliJ checks before committing
    for (const g of groups) {
      const op = g.repo.operationState();
      const info = this.vm.repos.find((r) => r.root === g.repo.root);
      if (this.vm.items.some((i) => i.repo === g.repo.root && i.area === 'conflict')) {
        const ok = await vscode.window.showWarningMessage('Are you sure you want to commit changes with unresolved conflicts?', { modal: true, detail: 'Unresolved Conflicts' }, 'Commit Anyway');
        if (ok !== 'Commit Anyway') return { ok: false };
      }
      if (op === 'rebase') {
        const ok = await vscode.window.showWarningMessage(`Rebase in progress in the repository: ${info?.name ?? g.repo.name}. Committing during rebase may lead to the commit loss.`, { modal: true }, 'Commit Anyway');
        if (ok !== 'Commit Anyway') return { ok: false };
      }
      if (!s.stagingArea && partialCommitImpossible(op)) {
        const excluded = this.vm.items.some((i) => i.repo === g.repo.root && i.area === 'changes' && (!i.included || i.partial));
        if (excluded) {
          const ok = await vscode.window.showWarningMessage('Are you sure you want to exclude these changed files from merge commit?', { modal: true, detail: 'Changes Excluded from Merge Commit' }, 'Commit Anyway');
          if (ok !== 'Commit Anyway') return { ok: false };
        }
      }
    }

    const committed: string[] = [];
    const partialFiles: string[] = [];
    let files = 0;
    try {
      await vscode.window.withProgress({ location: { viewId: VIEW_ID }, title: 'Committing…' }, async () => {
        await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: 'Committing…' }, async () => {
          for (const g of groups) {
            const merge = partialCommitImpossible(g.repo.operationState());
            const excluded = s.stagingArea || merge ? undefined : this.excludedLinesOf(g.items);
            if (excluded?.size) partialFiles.push(...g.items.filter((i) => excluded.has(i.path)).map((i) => fileKey(i.repo, i.path)));
            if (req.amend && req.amendTarget && req.amendRepo === g.repo.root && !(await this.isHead(g.repo, req.amendTarget))) {
              try {
                await ops.amendSpecific(g.repo, req.amendTarget, g.items, { message, options: req.options, index: s.stagingArea, excluded });
              } catch (e) {
                if (e instanceof ops.AmendConflictError) {
                  const keep = 'Create an “amend!” commit';
                  const pick = await vscode.window.showErrorMessage(e.message, keep);
                  if (pick !== keep) await ops.undoLastCommit(g.repo).catch((err) => showGitError(err, 'Failed to create an “amend!” commit'));
                  else vscode.window.showInformationMessage('“amend!” commit created');
                  throw new Cancelled();
                }
                throw e;
              }
            } else if (s.stagingArea) {
              await ops.commitIndex(g.repo, { message, amend: req.amend, options: req.options, all });
            } else {
              await ops.commitItems(g.repo, g.items, { message, amend: req.amend, options: req.options, merge, hasHead: this.hasHead(g.repo.root), excluded });
            }
            committed.push(g.repo.root);
            files += new Set(g.items.map((i) => i.path)).size;
          }
        });
      });
    } catch (e) {
      if (!(e instanceof Cancelled)) showGitError(e, req.amend ? 'Failed to amend the commit' : 'Commit failed');
      await this.refresh();
      if (!committed.length) return { ok: false };
    }

    await this.store.addHistory(message);
    // the lines left out of a partial commit are new, fully included local changes now
    await this.store.clearExcludedLines(partialFiles.filter((k) => committed.some((r) => k.startsWith(r + '\0'))));
    if (s.stagingArea) await this.store.setStagingDraft('');
    else if (req.list) {
      this.store.model.setComment(req.list, '');
      await this.store.saveLists();
    }
    const opts = this.store.options;
    if (opts.author) await this.store.setOptions({ ...opts, author: '' });
    const subject = subjectOf(message);
    if (s.stagingArea) {
      const names = committed.map((r) => `'${path.basename(r)}'`).join(', ');
      vscode.window.showInformationMessage(`Committed ${names}: ${subject}`);
    } else vscode.window.showInformationMessage(filesCommittedText(files, subject));
    await this.refresh();
    if (req.push) await invoke('jbGit.push', { repoRoot: committed.length === 1 ? committed[0] : undefined });
    return { ok: true };
  }

  /** Excluded line keys (by repo-relative path) of the partially included items. */
  private excludedLinesOf(items: readonly Item[]): Map<string, Set<string>> {
    const out = new Map<string, Set<string>>();
    for (const it of items) {
      if (!it.partial) continue;
      const ex = this.store.excludedOf(fileKey(it.repo, it.path));
      if (ex.size) out.set(it.path, ex);
    }
    return out;
  }

  private async isHead(repo: Repository, hash: string): Promise<boolean> {
    const head = await repo.headHash();
    return !!head && head.startsWith(hash);
  }

  dispose(): void {
    clearTimeout(this.timer);
    this.bridge?.dispose();
    for (const d of this.disposables) d.dispose();
  }
}

class Cancelled extends Error {}
