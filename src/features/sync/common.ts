// Shared host helpers of the sync feature: repository resolution (contract args or an explorer Uri), the
// WebviewPanel dialog shell, branch data for the dialogs, settings, and conflict / result notifications.
import * as vscode from 'vscode';
import type { FeatureContext } from '../../core/context';
import { invoke } from '../../core/contracts';
import { showGitError } from '../../core/git';
import type { Repository } from '../../core/repository';
import { RpcBridge, webviewHtml, webviewOptions } from '../../core/webview';
import type { RefItem, RepoData, RepoItem } from './protocol';
import { updatedText } from './pushLogic';

/** Contract args, or the Uri an explorer/editor "Git" submenu passes. */
export type SyncArgs = { repoRoot?: string } | vscode.Uri | undefined;

export function rootOf(args: SyncArgs): string | undefined {
  if (args instanceof vscode.Uri) return undefined;
  return args?.repoRoot;
}

/** The repository named by `args`, else the one of the Uri / active editor, else asks. */
export async function repoOf(ctx: FeatureContext, args: SyncArgs): Promise<Repository | undefined> {
  await ctx.repos.ready();
  if (args instanceof vscode.Uri) return ctx.repos.forUri(args) ?? ctx.repos.pick();
  if (args?.repoRoot) {
    const r = ctx.repos.get(args.repoRoot) ?? (await ctx.repos.open(args.repoRoot));
    if (r) return r;
    vscode.window.showErrorMessage(`${args.repoRoot} is not a Git repository.`);
    return undefined;
  }
  return ctx.repos.pick();
}

/** Repositories a multi-repository operation (Fetch, Update Project, Push) acts on. */
export async function reposOf(ctx: FeatureContext, args: SyncArgs): Promise<Repository[]> {
  await ctx.repos.ready();
  if (args instanceof vscode.Uri) {
    const r = ctx.repos.forUri(args);
    return r ? [r] : ctx.repos.all;
  }
  if (args?.repoRoot) {
    const r = await repoOf(ctx, args);
    return r ? [r] : [];
  }
  const all = ctx.repos.all;
  if (!all.length) vscode.window.showWarningMessage('No Git repository found in the workspace.');
  return all;
}

export function repoItems(ctx: FeatureContext): RepoItem[] {
  return ctx.repos.all.map((r) => ({ root: r.root, name: r.name }));
}

export function cfg(): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration('jbGit');
}

const open = new Map<string, vscode.WebviewPanel>();

/**
 * Opens a dialog WebviewPanel in the active column. `handlers(done)` are the RPC methods; `done(v)` resolves the
 * promise and closes the panel. Closing the tab resolves with undefined. One dialog per kind at a time.
 * Repository changes reach the page as the `refresh` event (data: repository root), debounced.
 */
export function openDialog<T>(
  ctx: FeatureContext,
  kind: string,
  bundle: string,
  title: string,
  init: unknown,
  handlers: (done: (v: T | undefined) => void, panel: vscode.WebviewPanel) => Record<string, (p: any) => unknown>,
): Promise<T | undefined> {
  open.get(kind)?.dispose();
  return new Promise((resolve) => {
    const ext = ctx.extension.extensionUri;
    const panel = vscode.window.createWebviewPanel(`jbGit.sync.${kind}`, title, { viewColumn: vscode.ViewColumn.Active, preserveFocus: false }, webviewOptions(ext));
    panel.iconPath = new vscode.ThemeIcon('git-branch');
    open.set(kind, panel);
    let settled = false;
    const done = (v: T | undefined) => {
      if (settled) return;
      settled = true;
      resolve(v);
      panel.dispose();
    };
    const bridge = new RpcBridge(panel.webview, { ...handlers(done, panel), cancel: () => done(undefined) });
    const subs: vscode.Disposable[] = [bridge];
    const timers = new Map<string, NodeJS.Timeout>();
    subs.push(ctx.repos.onDidChangeRepository((repo) => {
      clearTimeout(timers.get(repo.root));
      timers.set(repo.root, setTimeout(() => {
        timers.delete(repo.root);
        if (!settled) bridge.emit('refresh', repo.root);
      }, 400));
    }));
    subs.push({ dispose: () => timers.forEach((t) => clearTimeout(t)) });
    panel.webview.html = webviewHtml(panel.webview, ext, bundle, init, title);
    panel.onDidDispose(() => {
      if (open.get(kind) === panel) open.delete(kind);
      for (const s of subs) s.dispose();
      if (!settled) {
        settled = true;
        resolve(undefined);
      }
    });
  });
}

/** Local branches, remote branches and tags (+ current branch / upstream / remotes) of a repository. */
export async function repoData(repo: Repository, opts: { merged?: boolean } = {}): Promise<RepoData> {
  const [refs, status, remotes] = await Promise.all([repo.refs(), repo.status(), repo.remotes()]);
  const items: RefItem[] = [];
  for (const r of refs) {
    if (r.type === 'head') items.push({ name: r.short, kind: 'local' });
    else if (r.type === 'remote' && !r.name.endsWith('/HEAD')) items.push({ name: r.short, kind: 'remote' });
    else if (r.type === 'tag') items.push({ name: r.short, kind: 'tag' });
  }
  const data: RepoData = {
    root: repo.root,
    branch: status.branch.head,
    head: status.branch.oid,
    refs: items,
    remotes: remotes.map((r) => r.name),
    upstream: status.branch.upstream,
  };
  if (opts.merged && status.branch.oid) {
    const r = await repo.run(['for-each-ref', '--merged', 'HEAD', '--format=%(refname:short)', 'refs/heads', 'refs/remotes', 'refs/tags'], { quiet: true, allowFail: true });
    data.merged = r.stdout.split('\n').filter(Boolean);
  }
  return data;
}

export async function hasLocalChanges(repo: Repository): Promise<boolean> {
  const s = await repo.status();
  return s.entries.some((e) => e.kind !== '?' && e.kind !== '!');
}

export async function hasConflicts(repo: Repository): Promise<boolean> {
  const s = await repo.status();
  return s.entries.some((e) => e.kind === 'U' || !!e.conflict);
}

/** IntelliJ-style notification after a merge/rebase/pull/update stopped on conflicts. */
export async function notifyConflicts(repo: Repository, message: string): Promise<void> {
  const op = repo.operationState();
  const actions = ['Resolve Conflicts…'];
  if (op === 'rebase') actions.push('Continue Rebase', 'Abort Rebase');
  else if (op === 'merge') actions.push('Abort Merge');
  const pick = await vscode.window.showWarningMessage(message, ...actions);
  if (pick === 'Resolve Conflicts…') invoke('jbGit.conflicts.resolve', { repoRoot: repo.root });
  else if (pick === 'Continue Rebase') invoke('jbGit.operation.continue', { repoRoot: repo.root });
  else if (pick?.startsWith('Abort')) invoke('jbGit.operation.abort', { repoRoot: repo.root });
}

/** After a failed command: conflicts → conflict notification (returns true); otherwise false. */
export async function handleConflicts(repo: Repository, message: string, e?: unknown): Promise<boolean> {
  const text = e instanceof Error ? e.message : '';
  if ((await hasConflicts(repo)) || /CONFLICT|Applying autostash resulted in conflicts/.test(text)) {
    await notifyConflicts(repo, message);
    return true;
  }
  return false;
}

/** Restored-with-conflicts warning when the autostash could not be re-applied cleanly. */
export function autostashConflict(output: string): boolean {
  return /Applying autostash resulted in conflicts|Your changes are safe in the stash/.test(output);
}

export interface RangeStat {
  commits: number;
  files: number;
}

/**
 * Commits and files an update brought in (the "N files updated in M commits" numbers): commits reachable from `to`
 * but not from `from`, without the local commits a rebase re-created (patch-equivalent) and without the merge commit
 * the update itself created.
 */
export async function rangeStat(repo: Repository, from: string | undefined, to: string | undefined): Promise<RangeStat> {
  if (!to || from === to) return { commits: 0, files: 0 };
  const q = { quiet: true, allowFail: true };
  if (!from) {
    const [c, f] = await Promise.all([repo.run(['rev-list', '--count', to], q), repo.run(['ls-tree', '-r', '--name-only', '-z', to], q)]);
    return { commits: +c.stdout.trim() || 0, files: f.stdout.split('\0').filter(Boolean).length };
  }
  const [c, f, p] = await Promise.all([
    repo.run(['rev-list', '--count', '--cherry-pick', '--right-only', `${from}...${to}`], q),
    repo.run(['diff', '--name-only', '-z', '--no-renames', from, to], q),
    repo.run(['rev-list', '--parents', '-n', '1', to], q),
  ]);
  const parents = p.stdout.trim().split(' ').slice(1);
  const ownMerge = parents.length > 1 && parents[0] === from ? 1 : 0;
  return { commits: Math.max(0, (+c.stdout.trim() || 0) - ownMerge), files: f.stdout.split('\0').filter(Boolean).length };
}

/**
 * IntelliJ "smart" save/restore around an operation whose result stays uncommitted (--squash, --no-commit), where
 * git's own --autostash would keep the changes hidden until the merge is committed: stash, run, then pop.
 * When the operation left conflicts the stash is kept (IntelliJ "Restore local changes" notification).
 */
export async function withSavedChanges<T>(repo: Repository, operation: string, run: () => Promise<T>): Promise<T> {
  const save = await hasLocalChanges(repo);
  if (save) await repo.exec(['stash', 'push', '-m', `Uncommitted changes before ${operation} at ${new Date().toLocaleString()}`]);
  try {
    return await run();
  } finally {
    if (save) {
      if (await hasConflicts(repo)) {
        void vscode.window.showInformationMessage(`Restore local changes: Local changes were saved before ${operation.toLowerCase()}`, 'View Stash…').then((pick) => {
          if (pick) invoke('jbGit.stash.unstash', { repoRoot: repo.root });
        });
      } else {
        const r = await repo.exec(['stash', 'pop'], { allowFail: true });
        if (r.code !== 0) void notifyConflicts(repo, 'Local changes were restored with conflicts. Your changes are safe in the stash.');
      }
    }
  }
}

/** "N files updated in M commits" with View Commits, or "All files are up to date". */
export async function notifyUpdated(results: { repo: Repository; from?: string; to?: string; stat: RangeStat }[], prefix = ''): Promise<void> {
  const changed = results.filter((r) => r.stat.commits > 0);
  if (!changed.length) {
    vscode.window.showInformationMessage(`${prefix}All files are up to date`);
    return;
  }
  const files = changed.reduce((n, r) => n + r.stat.files, 0);
  const commits = changed.reduce((n, r) => n + r.stat.commits, 0);
  const pick = await vscode.window.showInformationMessage(`${prefix}${updatedText(files, commits)}`, 'View Commits');
  if (pick) {
    const first = changed[0];
    invoke('jbGit.log.show', { repoRoot: first.repo.root, revision: first.to });
  }
}

/** Runs a task with a cancellable notification progress; errors are shown with showGitError. */
export async function withProgress<T>(title: string, task: (token: vscode.CancellationToken, progress: vscode.Progress<{ message?: string }>) => Promise<T>): Promise<T | undefined> {
  return vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title, cancellable: true }, (progress, token) => task(token, progress));
}

export async function reportError(e: unknown, prefix: string): Promise<void> {
  await showGitError(e, prefix);
}

/** "repo: message" when several repositories are involved. */
export function prefixed(repo: Repository, many: boolean, message: string): string {
  return many ? `${repo.name}: ${message}` : message;
}

const OP_NAMES: Record<string, string> = { merge: 'merge', rebase: 'rebase', 'cherry-pick': 'cherry-pick', revert: 'revert', am: 'patch apply', bisect: 'bisect' };

/**
 * IntelliJ "Rebase not allowed" style check: an unfinished merge/rebase/cherry-pick/revert blocks the operation.
 * Returns the message, or undefined when the repository is in a normal state.
 */
export function blockedBy(repo: Repository, action: string): string | undefined {
  const op = repo.operationState();
  if (op === 'none' || op === 'bisect') return undefined;
  const second = op === 'merge' ? `You should complete the merge before starting a ${action}.` : op === 'rebase' ? `You should complete it before starting another ${action}.` : `You should finish it before starting a ${action}.`;
  return `There is an unfinished ${OP_NAMES[op]} process in ${repo.name}. ${second}`;
}
