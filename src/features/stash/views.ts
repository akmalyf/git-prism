// The "Stash" and "Shelf" webview views of the Commit tool window (IntelliJ shows them as tabs next to Commit).
// Each view pushes its model to the page and executes the toolbar / context-menu actions it requests.
import * as vscode from 'vscode';
import type { FeatureContext } from '../../core/context';
import { showGitError } from '../../core/git';
import { RpcBridge, webviewHtml } from '../../core/webview';
import * as ops from './gitOps';
import type { ShelfActions, ShelfStore } from './shelf';
import type { StashActions, StashModel } from './stash';
import type { ShelfInit, ShelfViewModel, StashFile, StashViewModel } from './protocol';

export const STASH_VIEW = 'jbGit.stashView';
export const SHELF_VIEW = 'jbGit.shelfView';

abstract class BaseView implements vscode.WebviewViewProvider, vscode.Disposable {
  protected view: vscode.WebviewView | undefined;
  protected bridge: RpcBridge | undefined;
  protected readonly disposables: vscode.Disposable[] = [];

  constructor(
    protected readonly ctx: FeatureContext,
    private readonly bundle: string,
    private readonly title: string,
  ) {}

  protected abstract handlers(): Record<string, (p: any) => unknown>;
  protected abstract init(): unknown;
  abstract model(): unknown;

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    const ext = this.ctx.extension.extensionUri;
    view.webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(ext, 'dist', 'media')] };
    this.bridge?.dispose();
    this.bridge = new RpcBridge(view.webview, { ...this.handlers(), state: () => this.model(), copy: (text: string) => vscode.env.clipboard.writeText(text) });
    view.webview.html = webviewHtml(view.webview, ext, this.bundle, this.init(), this.title);
    const sub = view.onDidDispose(() => {
      sub.dispose();
      this.bridge?.dispose();
      this.bridge = undefined;
      this.view = undefined;
    });
  }

  push(): void {
    this.bridge?.emit('state', this.model());
  }

  dispose(): void {
    this.bridge?.dispose();
    for (const d of this.disposables) d.dispose();
  }
}

type Target = { repoRoot: string; hash: string };

export class StashView extends BaseView {
  private previewDiff: boolean;

  constructor(
    ctx: FeatureContext,
    private readonly stashes: StashModel,
    private readonly actions: StashActions,
  ) {
    super(ctx, 'stash', 'Stash');
    this.previewDiff = ctx.extension.workspaceState.get('jbGit.stash.previewDiff', false);
    this.disposables.push(stashes.onDidChange(() => this.push()));
  }

  protected init(): unknown {
    return { locale: vscode.env.language };
  }

  model(): StashViewModel {
    return { repos: this.stashes.repos, previewDiff: this.previewDiff, locale: vscode.env.language };
  }

  togglePreview(): void {
    this.previewDiff = !this.previewDiff;
    void this.ctx.extension.workspaceState.update('jbGit.stash.previewDiff', this.previewDiff);
    this.push();
  }

  protected handlers(): Record<string, (p: any) => unknown> {
    const a = this.actions;
    return {
      refresh: () => this.stashes.refresh().then(() => this.push()),
      files: async (p: Target) => {
        const repo = await a.repo(p.repoRoot);
        if (!repo) return [];
        try {
          return await ops.stashFiles(repo, p.hash);
        } catch (e) {
          showGitError(e, `Could not load changes in root ${repo.name}`);
          return [];
        }
      },
      apply: (p: Target) => a.apply(p.repoRoot, p.hash, false),
      pop: (p: Target) => a.apply(p.repoRoot, p.hash, true),
      drop: (p: { repoRoot: string; hashes: string[] }) => a.drop(p.repoRoot, p.hashes),
      clear: (p: { repoRoot: string }) => a.clear(p.repoRoot),
      unstashAs: (p: Target) => a.unstashAs(p.repoRoot, p.hash),
      showDiff: (p: Target & { files?: StashFile[]; index: number; preview?: boolean }) => a.showDiff(p.repoRoot, p.hash, p.files, p.index, !!p.preview),
      fileAction: (p: Target & { action: Parameters<StashActions['fileAction']>[0]; files: StashFile[] }) => a.fileAction(p.action, p.repoRoot, p.hash, p.files),
      togglePreview: () => this.togglePreview(),
      stash: () => vscode.commands.executeCommand('jbGit.stash.create', {}),
    };
  }
}

export class ShelfView extends BaseView {
  private showApplied: boolean;
  private groupByDirectory: boolean;

  constructor(
    ctx: FeatureContext,
    private readonly store: ShelfStore,
    private readonly actions: ShelfActions,
  ) {
    super(ctx, 'shelf', 'Shelf');
    this.showApplied = ctx.extension.workspaceState.get('jbGit.shelf.showApplied', false);
    this.groupByDirectory = ctx.extension.workspaceState.get('jbGit.shelf.groupByDirectory', true);
    this.updateContext();
    this.disposables.push(store.onDidChange(() => this.push()));
  }

  protected init(): ShelfInit {
    return { mode: 'view', locale: vscode.env.language };
  }

  model(): ShelfViewModel {
    const shelves = this.store.all.map((s) => this.store.info(s));
    return {
      shelves,
      showApplied: this.showApplied,
      groupByDirectory: this.groupByDirectory,
      multiRepo: new Set(shelves.map((s) => s.repoRoot)).size > 1,
      locale: vscode.env.language,
    };
  }

  private updateContext(): void {
    void vscode.commands.executeCommand('setContext', 'jbGit.shelf.showApplied', this.showApplied);
  }

  toggleShowApplied(): void {
    this.showApplied = !this.showApplied;
    void this.ctx.extension.workspaceState.update('jbGit.shelf.showApplied', this.showApplied);
    this.updateContext();
    this.push();
  }

  setGroupByDirectory(v: boolean): void {
    this.groupByDirectory = v;
    void this.ctx.extension.workspaceState.update('jbGit.shelf.groupByDirectory', v);
    this.push();
  }

  protected handlers(): Record<string, (p: any) => unknown> {
    const a = this.actions;
    type Ids = { ids: string[]; paths?: string[] };
    return {
      refresh: () => this.store.load(),
      unshelve: (p: Ids) => a.unshelve(p.ids[0], p.paths),
      unshelveSilently: (p: Ids) => a.unshelveSilently(p.ids, p.paths),
      delete: (p: Ids) => a.delete(p.ids),
      rename: (p: Ids) => a.rename(p.ids[0]),
      restore: (p: Ids) => a.restore(p.ids),
      createPatch: (p: Ids & { clipboard: boolean }) => a.createPatch(p.ids[0], p.paths, p.clipboard),
      showDiff: (p: { id: string; index: number; paths?: string[]; withLocal?: boolean; preview?: boolean }) =>
        a.showDiff(p.id, p.paths, p.index, { withLocal: p.withLocal, beside: p.preview }),
      importPatches: () => a.importPatches(),
      toggleShowApplied: () => this.toggleShowApplied(),
      setGroupByDirectory: (v: boolean) => this.setGroupByDirectory(v),
      shelve: () => vscode.commands.executeCommand('jbGit.shelf.shelve', {}),
    };
  }
}
