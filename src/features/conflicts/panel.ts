// "Conflicts" dialog (IntelliJ MultipleFileMergeDialog) as a WebviewPanel: unmerged files of one or more
// repositories with their Yours/Theirs status, Accept Yours / Accept Theirs / Merge…, auto-refresh, and the next step
// (commit the merge / continue) once every conflict is resolved.
import * as vscode from 'vscode';
import type { FeatureContext } from '../../core/context';
import { invoke } from '../../core/contracts';
import { showGitError } from '../../core/git';
import type { Repository } from '../../core/repository';
import { RpcBridge, webviewHtml, webviewOptions } from '../../core/webview';
import { readOpInfo, unmerged } from './gitState';
import { acceptPlan, columnTitles, describe, isReversed, toConflictFile, type RepoOpInfo } from './logic';
import type { Operations } from './operations';
import type { AcceptParams, ConflictsInit, ConflictsState } from './protocol';

const CHUNK = 200;

function chunks<T>(xs: T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += CHUNK) out.push(xs.slice(i, i + CHUNK));
  return out;
}

export class ConflictsPanel {
  private static current: ConflictsPanel | undefined;

  private readonly panel: vscode.WebviewPanel;
  private readonly bridge: RpcBridge;
  private readonly disposables: vscode.Disposable[] = [];
  private roots: string[];
  private reloadTimer: NodeJS.Timeout | undefined;
  private working = 0;
  private seq = 0;
  private disposed = false;

  /** Whether the dialog is open and shows `root`. */
  static isOpenFor(root: string): boolean {
    return !!ConflictsPanel.current?.roots.includes(root);
  }

  static show(ctx: FeatureContext, ops: Operations, roots: string[]): void {
    const cur = ConflictsPanel.current;
    if (cur) {
      cur.roots = roots;
      cur.panel.reveal(vscode.ViewColumn.Active);
      cur.reload();
      return;
    }
    ConflictsPanel.current = new ConflictsPanel(ctx, ops, roots);
  }

  private constructor(
    private readonly ctx: FeatureContext,
    private readonly ops: Operations,
    roots: string[],
  ) {
    this.roots = roots;
    const ext = ctx.extension.extensionUri;
    this.panel = vscode.window.createWebviewPanel('jbGit.conflicts', 'Conflicts', vscode.ViewColumn.Active, webviewOptions(ext));
    this.panel.iconPath = new vscode.ThemeIcon('git-merge');
    this.bridge = new RpcBridge(this.panel.webview, {
      load: () => this.state(),
      accept: (p: AcceptParams) => this.accept(p),
      merge: (p: { files: { repoRoot: string; path: string }[] }) => this.merge(p.files),
      open: (p: { repoRoot: string; path: string }) => this.openFile(p),
      next: (id: 'commit' | 'continue') => this.next(id),
      close: () => this.panel.dispose(),
    });
    const init: ConflictsInit = { locale: vscode.env.language };
    this.panel.webview.html = webviewHtml(this.panel.webview, ext, 'conflicts', init, 'Conflicts');
    this.disposables.push(
      this.bridge,
      ctx.repos.onDidChangeRepository((r) => {
        if (this.roots.includes(r.root) && !this.working) this.reload();
      }),
      ctx.repos.onDidChangeRepositories(() => this.reload()),
    );
    this.panel.onDidDispose(() => this.dispose());
  }

  private reload(): void {
    clearTimeout(this.reloadTimer);
    this.reloadTimer = setTimeout(async () => {
      const s = await this.state();
      // a newer state (another reload, or an accept/merge result) supersedes this one
      if (this.disposed || s.seq !== this.seq) return;
      try {
        this.bridge.emit('state', s);
      } catch {
        /* panel disposed meanwhile */
      }
    }, 50);
  }

  private repos(): Repository[] {
    return this.roots.map((r) => this.ctx.repos.get(r)).filter((r): r is Repository => !!r);
  }

  private async state(): Promise<ConflictsState> {
    const seq = ++this.seq;
    const repos = this.repos();
    try {
      const infos: RepoOpInfo[] = [];
      const files: ConflictsState['files'] = [];
      for (const repo of repos) {
        const entries = await unmerged(repo);
        const info = await readOpInfo(repo);
        infos.push(info);
        const reversed = isReversed(info.op);
        for (const e of entries) files.push(toConflictFile(repo.root, e, reversed));
      }
      // like IntelliJ, the description and column names come from the repositories that still have conflicts
      const withConflicts = infos.filter((_, i) => files.some((f) => f.repoRoot === repos[i].root));
      const shown = withConflicts.length ? withConflicts : infos;
      const desc = describe(shown, files.length);
      const titles = columnTitles(shown);
      const state: ConflictsState = {
        seq,
        repos: repos.map((r, i) => ({ root: r.root, name: r.name, op: infos[i].op })),
        files,
        description: desc.parts,
        message: desc.message,
        yoursTitle: titles.yours,
        theirsTitle: titles.theirs,
      };
      if (!files.length) state.done = this.doneState(infos);
      return state;
    } catch (e) {
      return {
        seq,
        repos: repos.map((r) => ({ root: r.root, name: r.name, op: r.operationState() })),
        files: [],
        description: [],
        yoursTitle: 'Yours',
        theirsTitle: 'Theirs',
        error: `Cannot check the working tree for unmerged files because of an error. ${e instanceof Error ? e.message : String(e)}`,
      };
    }
  }

  private doneState(infos: RepoOpInfo[]): ConflictsState['done'] {
    const op = infos.find((i) => i.op !== 'none')?.op ?? 'none';
    switch (op) {
      case 'merge':
        return { text: 'All conflicts resolved. Commit the merge?', action: { id: 'commit', label: 'Commit…' } };
      case 'rebase':
        return { text: 'All conflicts have been resolved. Do you want to continue rebase?', action: { id: 'continue', label: 'Continue Rebase' } };
      case 'cherry-pick':
        return { text: 'All conflicts have been resolved. Do you want to continue cherry-pick?', action: { id: 'continue', label: 'Continue Cherry-Pick' } };
      case 'revert':
        return { text: 'All conflicts have been resolved. Do you want to continue revert?', action: { id: 'continue', label: 'Continue Revert' } };
      default:
        return { text: 'All conflicts resolved' };
    }
  }

  private byRepo(files: { repoRoot: string; path: string }[]): Map<Repository, string[]> {
    const map = new Map<Repository, string[]>();
    for (const f of files) {
      const repo = this.ctx.repos.get(f.repoRoot);
      if (!repo) continue;
      const list = map.get(repo) ?? [];
      list.push(f.path);
      map.set(repo, list);
    }
    return map;
  }

  /** Accept Yours / Accept Theirs: checkout --ours|--theirs + add, or git rm where that side deleted the file. */
  private async accept(p: AcceptParams): Promise<ConflictsState> {
    this.working++;
    try {
      const n = p.files.length;
      await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: `Resolving ${n === 1 ? 'Conflict' : 'Conflicts'}` }, async () => {
        for (const [repo, paths] of this.byRepo(p.files)) {
          const wanted = new Set(paths);
          const entries = (await unmerged(repo)).filter((e) => wanted.has(e.path));
          const plan = acceptPlan(entries, p.accept, isReversed(repo.operationState()));
          // literal pathspecs: "a[1].txt" must not also match (and silently resolve) "a1.txt"
          const opts = { env: { GIT_LITERAL_PATHSPECS: '1' } };
          for (const part of chunks(plan.checkout)) {
            await repo.exec(['checkout', `--${plan.side}`, '--', ...part], opts);
            await repo.exec(['add', '--force', '--', ...part], opts);
          }
          for (const part of chunks(plan.remove)) await repo.exec(['rm', '--quiet', '--force', '--ignore-unmatch', '--', ...part], opts);
        }
      });
    } catch (e) {
      showGitError(e, 'Cannot Resolve Conflict');
    } finally {
      this.working--;
    }
    return this.state();
  }

  /** Merge…: the 3-way merge window for each selected file in turn; stops when one is cancelled. */
  private async merge(files: { repoRoot: string; path: string }[]): Promise<ConflictsState> {
    for (const f of files) {
      const ok = await invoke('jbGit.conflicts.mergeFile', { repoRoot: f.repoRoot, path: f.path });
      if (ok !== true) break;
    }
    return this.state();
  }

  private async openFile(p: { repoRoot: string; path: string }): Promise<void> {
    const repo = this.ctx.repos.get(p.repoRoot);
    if (!repo) return;
    try {
      await vscode.window.showTextDocument(vscode.Uri.file(repo.abs(p.path)), { preview: false });
    } catch (e) {
      vscode.window.showErrorMessage(`Cannot find file for ${p.path}`);
    }
  }

  /** Completion: commit the merge (Commit view with MERGE_MSG) or continue the rebase / cherry-pick / revert in every shown repository. */
  private async next(id: 'commit' | 'continue'): Promise<void> {
    const repos = this.repos();
    this.panel.dispose();
    if (id === 'commit') {
      const repo = repos.find((r) => r.operationState() === 'merge');
      if (repo) await this.ops.focusMergeCommit(repo);
      return;
    }
    for (const repo of repos) {
      const op = repo.operationState();
      if (op === 'rebase' || op === 'cherry-pick' || op === 'revert') await this.ops.continue(repo);
    }
  }

  private dispose(): void {
    this.disposed = true;
    clearTimeout(this.reloadTimer);
    if (ConflictsPanel.current === this) ConflictsPanel.current = undefined;
    for (const d of this.disposables) d.dispose();
  }
}
