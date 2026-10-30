// Merge/Rebase status bar widget ("Rebasing main", "Merging feature", "Cherry-picking in main", "Reverting in main")
// with the ongoing operation's actions, the jbGit.hasConflicts / jbGit.operation.* context keys and the
// "Merge Conflicts" notification when unmerged files appear.
import * as vscode from 'vscode';
import type { FeatureContext } from '../../core/context';
import { invoke } from '../../core/contracts';
import type { Repository } from '../../core/repository';
import type { OperationState } from '../../core/types';
import { currentName, readOpInfo, unmerged } from './gitState';
import { OP_ACTION_LABELS, opActions, opName, widgetText, type OpAction } from './logic';
import type { Operations } from './operations';
import { ConflictsPanel } from './panel';

interface RepoSnapshot {
  op: OperationState;
  conflicts: number;
  branch?: string;
  editStop?: boolean;
}

const ICONS: Partial<Record<OperationState, string>> = {
  rebase: '$(git-pull-request)',
  merge: '$(git-merge)',
  'cherry-pick': '$(git-commit)',
  revert: '$(discard)',
};

export class OperationWidget implements vscode.Disposable {
  private readonly item = vscode.window.createStatusBarItem('jbGit.operation', vscode.StatusBarAlignment.Left, 99);
  private readonly snapshots = new Map<string, RepoSnapshot>();
  private readonly disposables: vscode.Disposable[] = [this.item];
  private timer: NodeJS.Timeout | undefined;
  private updating: Promise<void> = Promise.resolve();

  constructor(
    private readonly ctx: FeatureContext,
    private readonly ops: Operations,
  ) {
    this.item.name = 'Git Merge/Rebase';
    this.item.command = 'jbGit.conflicts.operationActions';
    this.disposables.push(
      ctx.repos.onDidChangeRepository(() => this.schedule()),
      ctx.repos.onDidChangeRepositories(() => this.schedule()),
      vscode.window.onDidChangeActiveTextEditor(() => this.render()),
    );
    ctx.repos.ready().then(() => this.schedule());
  }

  private schedule(): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.updating = this.updating.then(() => this.update()).catch(() => undefined);
    }, 100);
  }

  private async update(): Promise<void> {
    const repos = this.ctx.repos.all;
    const seen = new Set<string>();
    for (const repo of repos) {
      seen.add(repo.root);
      const op = repo.operationState();
      const conflicts = (await unmerged(repo)).length;
      const prev = this.snapshots.get(repo.root);
      const snap: RepoSnapshot = { op, conflicts };
      if (op !== 'none') {
        const info = op === 'rebase' ? await readOpInfo(repo) : undefined;
        snap.branch = info?.current ?? (await currentName(repo));
        snap.editStop = info?.editStop && !conflicts;
      }
      this.snapshots.set(repo.root, snap);
      if (conflicts && !prev?.conflicts) this.notifyConflicts(repo);
    }
    for (const root of [...this.snapshots.keys()]) if (!seen.has(root)) this.snapshots.delete(root);
    const all = [...this.snapshots.values()];
    const setCtx = (key: string, v: unknown) => vscode.commands.executeCommand('setContext', key, v);
    setCtx('jbGit.hasConflicts', all.some((s) => s.conflicts > 0));
    setCtx('jbGit.operationInProgress', all.some((s) => s.op !== 'none'));
    setCtx('jbGit.operation.rebase', all.some((s) => s.op === 'rebase'));
    setCtx('jbGit.operation.merge', all.some((s) => s.op === 'merge'));
    setCtx('jbGit.operation.cherryPick', all.some((s) => s.op === 'cherry-pick'));
    setCtx('jbGit.operation.revert', all.some((s) => s.op === 'revert'));
    setCtx('jbGit.operation.mergeCommit', all.some((s) => s.op === 'merge' && !s.conflicts));
    setCtx('jbGit.operation.cherryPickContinue', all.some((s) => s.op === 'cherry-pick' && !s.conflicts));
    this.render();
  }

  /** The repository the widget shows: the active editor's one if it has an operation, else the first that has. */
  focusedRepo(): Repository | undefined {
    const busy = this.ctx.repos.all.filter((r) => (this.snapshots.get(r.root)?.op ?? 'none') !== 'none');
    const uri = vscode.window.activeTextEditor?.document.uri;
    const byEditor = uri?.scheme === 'file' ? this.ctx.repos.forUri(uri) : undefined;
    return byEditor && busy.includes(byEditor) ? byEditor : busy[0];
  }

  private render(): void {
    const repo = this.focusedRepo();
    const snap = repo && this.snapshots.get(repo.root);
    const text = snap && widgetText(snap.op, snap.branch);
    if (!repo || !snap || !text) {
      this.item.hide();
      return;
    }
    const multi = this.ctx.repos.all.length > 1;
    this.item.text = `${ICONS[snap.op] ?? '$(git-branch)'} ${text}${snap.conflicts ? ` $(warning) ${snap.conflicts}` : ''}`;
    const lines = [snap.op === 'rebase' ? 'Git: Rebase in progress' : `Git: ${opName(snap.op)[1]} in progress`];
    if (multi) lines.push(`Repository: ${repo.name}`);
    if (snap.conflicts) lines.push(`${snap.conflicts === 1 ? '1 file has' : `${snap.conflicts} files have`} unresolved conflicts`);
    else if (snap.editStop) lines.push('Rebase stopped for editing');
    this.item.tooltip = lines.join('\n');
    this.item.backgroundColor = snap.conflicts ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined;
    this.item.show();
  }

  /** Quick pick of the ongoing operation's actions (Continue Rebase / Skip Commit / Abort Rebase / Resolve Conflicts…). */
  async showActions(repoRoot?: string): Promise<void> {
    await this.updating;
    let repo = repoRoot ? this.ctx.repos.get(repoRoot) : this.focusedRepo();
    if (!repoRoot && this.ctx.repos.all.filter((r) => r.operationState() !== 'none').length > 1) {
      repo = await this.ops.pickRepo(undefined);
    }
    if (!repo) {
      vscode.window.showInformationMessage('There is no merge, rebase, cherry-pick or revert in progress.');
      return;
    }
    const op = repo.operationState();
    const conflicts = (await unmerged(repo)).length;
    const actions = opActions(op, conflicts > 0);
    if (!actions.length) {
      vscode.window.showInformationMessage(`There is no merge, rebase, cherry-pick or revert in progress${this.ops.mention(repo)}.`);
      return;
    }
    const snap = this.snapshots.get(repo.root);
    const ICON: Record<OpAction, string> = {
      resolve: '$(git-merge)',
      rebaseContinue: '$(debug-continue)',
      rebaseSkip: '$(debug-step-over)',
      rebaseAbort: '$(debug-stop)',
      mergeCommit: '$(check)',
      mergeAbort: '$(debug-stop)',
      cherryPickContinue: '$(debug-continue)',
      cherryPickAbort: '$(debug-stop)',
      revertAbort: '$(debug-stop)',
    };
    const pick = await vscode.window.showQuickPick(
      actions.map((a) => ({ label: `${ICON[a]} ${OP_ACTION_LABELS[a]}`, action: a })),
      { title: `${widgetText(op, snap?.branch) ?? opName(op)[1]}${this.ops.mention(repo)}`, placeHolder: conflicts ? `${conflicts} unresolved conflict${conflicts === 1 ? '' : 's'}` : undefined },
    );
    if (pick) await runAction(this.ops, repo, pick.action);
  }

  /** "Merge Conflicts" → Resolve… / Abort <Operation>; skipped while the Conflicts dialog already shows this repository. */
  private notifyConflicts(repo: Repository): void {
    if (!vscode.workspace.getConfiguration('jbGit.conflicts').get<boolean>('showNotification', true)) return;
    // let the feature that started the operation show its own "… stopped due to conflicts" first
    setTimeout(async () => {
      if (ConflictsPanel.isOpenFor(repo.root) || this.ops.recentlyNotified(repo.root)) return;
      const files = await unmerged(repo);
      if (!files.length) return;
      const op = repo.operationState();
      const resolve = 'Resolve…';
      const abort = ['merge', 'rebase', 'cherry-pick', 'revert'].includes(op) ? `Abort ${opName(op)[1]}` : undefined;
      const what = files.length === 1 ? files[0].path : `${files.length} files`;
      const buttons = abort ? [resolve, abort] : [resolve];
      const pick = await vscode.window.showWarningMessage(
        `Merge Conflicts${this.ops.mention(repo)}: There are unresolved conflicts in the working tree (${what}).`,
        ...buttons,
      );
      if (pick === resolve) invoke('jbGit.conflicts.resolve', { repoRoot: repo.root });
      else if (pick && pick === abort) this.ops.abort(repo);
    }, 1500);
  }

  dispose(): void {
    clearTimeout(this.timer);
    for (const d of this.disposables) d.dispose();
  }
}

export async function runAction(ops: Operations, repo: Repository, a: OpAction): Promise<void> {
  switch (a) {
    case 'resolve':
      await invoke('jbGit.conflicts.resolve', { repoRoot: repo.root });
      break;
    case 'rebaseContinue':
    case 'cherryPickContinue':
      await ops.continue(repo);
      break;
    case 'rebaseSkip':
      await ops.skip(repo);
      break;
    case 'mergeCommit':
      await ops.commitMerge(repo);
      break;
    case 'rebaseAbort':
    case 'mergeAbort':
    case 'cherryPickAbort':
    case 'revertAbort':
      await ops.abort(repo);
      break;
  }
}
