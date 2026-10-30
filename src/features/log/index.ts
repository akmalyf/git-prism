// Git Log feature: the "Log" webview view in the Git panel, "Show Git Log" / "History: <file>" editor tabs
// (same 'log' webview bundle), the jbGit.log.show contract command and the panel's "Console" tab (consoleview.ts).
import * as path from 'node:path';
import * as vscode from 'vscode';
import { implement, type LogShowArgs } from '../../core/contracts';
import type { FeatureContext } from '../../core/context';
import { webviewHtml, webviewOptions } from '../../core/webview';
import { activateConsole } from './consoleview';
import { LogController } from './controller';
import type { LogFilters, LogInit } from './protocol';

const VIEW_ID = 'jbGit.logView';
const VIEW_STATE_KEY = 'jbGit.log.view';

const fwd = (p: string) => p.split(path.sep).join('/');

class LogHost implements vscode.WebviewViewProvider, vscode.Disposable {
  private view: LogController | undefined;
  private viewWaiters: ((c: LogController) => void)[] = [];
  private readonly panels = new Map<string, { panel: vscode.WebviewPanel; controller: LogController }>();
  /** the log UI that was focused last (for palette commands) */
  private active: LogController | undefined;

  constructor(private readonly ctx: FeatureContext) {}

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    const ext = this.ctx.extension.extensionUri;
    webviewView.webview.options = webviewOptions(ext);
    const init: LogInit = { mode: 'log', title: 'Log', hideBranches: false, editorTab: false };
    webviewView.webview.html = webviewHtml(webviewView.webview, ext, 'log', init, 'Log');
    const controller = new LogController(this.ctx, webviewView.webview, {
      init,
      persistKey: VIEW_STATE_KEY,
      openEditor: (filters) => this.openEditor({ filters, title: 'Log' }),
    });
    this.view = controller;
    this.active = controller;
    controller.setVisible(webviewView.visible);
    webviewView.onDidChangeVisibility(() => {
      controller.setVisible(webviewView.visible);
      if (webviewView.visible) this.active = controller;
    });
    webviewView.onDidDispose(() => {
      controller.dispose();
      if (this.view === controller) this.view = undefined;
      if (this.active === controller) this.active = undefined;
    });
    for (const w of this.viewWaiters.splice(0)) w(controller);
  }

  /** Reveals the Log view in the Git panel and returns its controller. */
  private async revealView(): Promise<LogController | undefined> {
    await vscode.commands.executeCommand(`${VIEW_ID}.focus`);
    if (this.view) return this.view;
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(this.view), 10000);
      this.viewWaiters.push((c) => {
        clearTimeout(timer);
        resolve(c);
      });
    });
  }

  /** jbGit.log.show */
  async show(args: LogShowArgs): Promise<void> {
    await this.ctx.repos.ready();
    const firstAbs = args.paths?.find((p) => path.isAbsolute(p));
    // without repoRoot, an absolute path (editor/explorer "Show History") tells the repository
    const repo = args.repoRoot
      ? (this.ctx.repos.get(args.repoRoot) ?? (await this.ctx.repos.open(args.repoRoot)))
      : firstAbs
        ? this.ctx.repos.forUri(vscode.Uri.file(firstAbs))
        : undefined;
    if (args.repoRoot && !repo) {
      vscode.window.showWarningMessage(`${args.repoRoot} is not a Git repository.`);
      return;
    }
    const absPaths = args.paths?.map((p) => fwd(path.isAbsolute(p) ? p : repo ? repo.abs(p) : p));
    const filters: LogFilters = {};
    if (args.branches?.length) filters.branches = args.branches;
    if (args.text) filters.text = args.text;
    if (args.editorTab) {
      const history = !!absPaths?.length;
      if (repo) filters.roots = [repo.root];
      const title =
        args.title ??
        (history ? `History: ${absPaths!.map((p) => path.posix.basename(p) || p).join(', ')}` : filters.branches ? `Log: on ${filters.branches.join(', ')}` : 'Log');
      const c = this.openEditor({ filters, title, historyPaths: history ? absPaths : undefined });
      if (args.revision) c.reveal(args.revision, repo?.root);
      return;
    }
    const c = await this.revealView();
    if (!c) return;
    if (absPaths?.length) filters.paths = absPaths;
    if (args.branches?.length || args.text || absPaths?.length) await c.setFilters(filters);
    if (args.revision) await c.reveal(args.revision, repo?.root);
  }

  /** Opens (or reveals) a log editor tab. */
  openEditor(o: { filters: LogFilters; title: string; historyPaths?: string[] }): LogController {
    // one History tab per paths (and revision filter: "History Up to Here" opens its own tab)
    const key = o.historyPaths ? `history:${o.historyPaths.join('\n')}|${(o.filters.branches ?? []).join('\n')}` : undefined;
    const existing = key ? this.panels.get(key) : undefined;
    if (existing) {
      existing.panel.reveal();
      return existing.controller;
    }
    const ext = this.ctx.extension.extensionUri;
    const init: LogInit = {
      mode: o.historyPaths ? 'history' : 'log',
      title: o.title,
      hideBranches: !!o.historyPaths,
      historyPaths: o.historyPaths,
      editorTab: true,
    };
    const panel = vscode.window.createWebviewPanel('jbGit.log', o.title, vscode.ViewColumn.Active, webviewOptions(ext));
    panel.iconPath = new vscode.ThemeIcon(o.historyPaths ? 'history' : 'git-commit');
    panel.webview.html = webviewHtml(panel.webview, ext, 'log', init, o.title);
    const controller = new LogController(this.ctx, panel.webview, {
      init,
      filters: o.filters,
      openEditor: (filters) => this.openEditor({ filters, title: 'Log' }),
    });
    const id = key ?? `log:${Date.now()}:${Math.random()}`;
    this.panels.set(id, { panel, controller });
    this.active = controller;
    panel.onDidChangeViewState(() => {
      controller.setVisible(panel.visible);
      if (panel.active) this.active = controller;
    });
    panel.onDidDispose(() => {
      controller.dispose();
      this.panels.delete(id);
      if (this.active === controller) this.active = undefined;
    });
    return controller;
  }

  async activeController(): Promise<LogController | undefined> {
    return this.active ?? (await this.revealView());
  }

  dispose(): void {
    this.view?.dispose();
    for (const p of this.panels.values()) p.panel.dispose();
  }
}

export function activate(ctx: FeatureContext): void {
  activateConsole(ctx);
  const host = new LogHost(ctx);
  ctx.extension.subscriptions.push(
    host,
    vscode.window.registerWebviewViewProvider(VIEW_ID, host, { webviewOptions: { retainContextWhenHidden: true } }),
    implement('jbGit.log.show', (args) => host.show(args)),
    vscode.commands.registerCommand('jbGit.log.refresh', async () => {
      await (await host.activeController())?.refresh();
    }),
    vscode.commands.registerCommand('jbGit.log.openInEditor', () => host.openEditor({ filters: {}, title: 'Log' })),
    vscode.commands.registerCommand('jbGit.log.focusTextFilter', async () => (await host.activeController())?.focusTextFilter()),
    vscode.commands.registerCommand('jbGit.log.goToRef', async () => {
      const c = await host.activeController();
      if (!c) return;
      const text = await vscode.window.showInputBox({ title: 'Go To Hash/Branch/Tag', prompt: 'Enter hash or branch/tag name:' });
      if (text?.trim()) await c.reveal(text.trim());
    }),
  );
}
