// Continue / Skip / Abort of the operation in progress (git rebase|cherry-pick|revert --continue|--skip|--abort,
// merge --abort, "Commit merge") with IntelliJ's confirmations and the notifications about where the operation stopped.
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { FeatureContext } from '../../core/context';
import { invoke } from '../../core/contracts';
import { showGitError } from '../../core/git';
import type { Repository } from '../../core/repository';
import type { OperationState } from '../../core/types';
import { commentChar, readGitFile, readOpInfo, unmerged } from './gitState';
import { abortConfirmation, cleanMergeMessage, isEmptyPickError, isUnstagedChangesError, opName, rebaseStopKind, short } from './logic';

const SUPPORTED: OperationState[] = ['merge', 'rebase', 'cherry-pick', 'revert'];

export class Operations {
  private readonly busy = new Set<string>();
  /** when this feature last told the user about conflicts in a repository (the widget then stays quiet) */
  private readonly notified = new Map<string, number>();

  constructor(private readonly ctx: FeatureContext) {}

  recentlyNotified(root: string): boolean {
    return Date.now() - (this.notified.get(root) ?? 0) < 10_000;
  }

  /** " in <repo>" when the workspace has several repositories (GitUtil.mention). */
  mention(repo: Repository): string {
    return this.ctx.repos.all.length > 1 ? ` in ${repo.name}` : '';
  }

  /**
   * The repository to act on: `repoRoot`, else the one of the active editor / the only one / a quick pick among
   * the repositories whose operation state is in `states`.
   */
  async pickRepo(repoRoot: string | undefined, states: OperationState[] = SUPPORTED, noneMessage?: string): Promise<Repository | undefined> {
    await this.ctx.repos.ready();
    if (repoRoot) {
      const r = this.ctx.repos.get(repoRoot) ?? (await this.ctx.repos.open(repoRoot));
      if (!r) vscode.window.showErrorMessage(`Not a Git repository: ${repoRoot}`);
      return r;
    }
    const candidates = this.ctx.repos.all.filter((r) => states.includes(r.operationState()));
    if (!candidates.length) {
      vscode.window.showInformationMessage(noneMessage ?? 'There is no merge, rebase, cherry-pick or revert in progress.');
      return undefined;
    }
    const active = vscode.window.activeTextEditor?.document.uri;
    const byEditor = active?.scheme === 'file' ? this.ctx.repos.forUri(active) : undefined;
    if (byEditor && candidates.includes(byEditor)) return byEditor;
    if (candidates.length === 1) return candidates[0];
    const sel = await vscode.window.showQuickPick(
      candidates.map((r) => ({ label: r.name, description: opName(r.operationState())[1], detail: r.root, repo: r })),
      { placeHolder: 'Select a Git repository' },
    );
    return sel?.repo;
  }

  private async guard(repo: Repository, fn: () => Promise<void>): Promise<void> {
    if (this.busy.has(repo.root)) return;
    this.busy.add(repo.root);
    try {
      await fn();
    } catch (e) {
      showGitError(e);
    } finally {
      this.busy.delete(repo.root);
    }
  }

  private progress<T>(title: string, task: () => Promise<T>): Thenable<T> {
    return vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title }, task);
  }

  // ------------------------------------------------------------------ continue

  async continue(repo: Repository): Promise<void> {
    const op = repo.operationState();
    if (op === 'none') {
      vscode.window.showInformationMessage(`There is no merge, rebase, cherry-pick or revert in progress${this.mention(repo)}.`);
      return;
    }
    if (op === 'bisect' || op === 'am') {
      vscode.window.showWarningMessage(`${opName(op)[1]} is in progress${this.mention(repo)}. Finish it in the terminal.`);
      return;
    }
    if ((await unmerged(repo)).length) {
      await invoke('jbGit.conflicts.resolve', { repoRoot: repo.root });
      return;
    }
    if (op === 'merge') {
      await this.focusMergeCommit(repo);
      return;
    }
    await this.guard(repo, () => this.step(repo, op, 'continue'));
  }

  /** Reveals the Commit view with the merge message (MERGE_MSG without git's comment lines). */
  async focusMergeCommit(repo: Repository): Promise<void> {
    const raw = readGitFile(repo, 'MERGE_MSG');
    const message = raw !== undefined ? cleanMergeMessage(raw, await commentChar(repo)) : undefined;
    await invoke('jbGit.commit.focus', { repoRoot: repo.root, message });
  }

  /** git rebase|cherry-pick|revert --continue|--skip, then reports where it ended. */
  private async step(repo: Repository, op: OperationState, kind: 'continue' | 'skip'): Promise<void> {
    const cmd = op === 'rebase' ? 'rebase' : op === 'cherry-pick' ? 'cherry-pick' : 'revert';
    const before = op === 'rebase' ? await readOpInfo(repo) : undefined;
    const title =
      kind === 'skip'
        ? op === 'rebase'
          ? 'Skip commit during rebase…'
          : `Skipping ${opName(op)[0]}…`
        : op === 'rebase'
          ? 'Continuing rebase process…'
          : op === 'cherry-pick'
            ? 'Continuing cherry-pick…'
            : 'Continuing revert…';
    const r = await this.progress(title, () => repo.exec([cmd, `--${kind}`], { allowFail: true, env: { GIT_EDITOR: 'true' } }));
    const output = `${r.stdout}\n${r.stderr}`;
    const state = repo.operationState();
    const conflicts = state !== 'none' ? (await unmerged(repo)).length : 0;
    const failTitle = op === 'rebase' ? 'Continue rebase failed' : op === 'cherry-pick' ? 'Continue cherry-pick failed' : 'Continue revert failed';

    if (state === 'none') {
      if (r.code !== 0) return void showGitError(new Error(output.trim()), failTitle);
      this.notifySuccess(repo, op, before);
      return;
    }
    if (conflicts) return this.notifyConflicts(repo, state);
    if (r.code !== 0 && isUnstagedChangesError(output)) return this.offerStageAndRetry(repo, op);
    if (r.code !== 0 && op !== 'rebase' && isEmptyPickError(output)) return this.offerSkipEmpty(repo, op);
    if (state === 'rebase') {
      const info = await readOpInfo(repo);
      const stop = rebaseStopKind(false, !!info.editStop, output);
      if (r.code !== 0 && stop !== 'exec' && stop !== 'edit') return void showGitError(new Error(output.trim()), failTitle);
      return this.notifyRebaseStopped(repo, stop, output);
    }
    if (r.code !== 0) return void showGitError(new Error(output.trim()), failTitle);
  }

  private notifySuccess(repo: Repository, op: OperationState, before: Awaited<ReturnType<typeof readOpInfo>> | undefined): void {
    if (op === 'rebase') {
      const branch = before?.rebasingBranch;
      const onto = before?.ontoBranch ?? (before?.ontoHash ? short(before.ontoHash) : undefined);
      vscode.window.showInformationMessage(`Rebase successful: Rebased${branch ? ` ${branch}` : ''}${onto ? ` on ${onto}` : ''}`);
    } else if (op === 'cherry-pick') {
      vscode.window.showInformationMessage(`Cherry-pick continue successful${this.mention(repo)}`);
    } else {
      vscode.window.showInformationMessage(`${opName(op)[1]} successful${this.mention(repo)}`);
    }
  }

  /** "Rebase stopped due to conflicts" / "Cherry-pick was performed with conflicts" → Resolve… / Abort. */
  async notifyConflicts(repo: Repository, op: OperationState): Promise<void> {
    this.notified.set(repo.root, Date.now());
    const resolve = 'Resolve…';
    const abort = op === 'rebase' ? 'Abort' : `Abort ${opName(op)[1]}`;
    const files = await unmerged(repo);
    const what = files.length === 1 ? files[0].path : `${files.length} files`;
    const text =
      op === 'rebase'
        ? `Rebase stopped due to conflicts${this.mention(repo)}: ${what}`
        : op === 'merge'
          ? `Merge Conflicts${this.mention(repo)}: ${what}`
          : `${opName(op)[1]} was performed with conflicts${this.mention(repo)}: ${what}`;
    const pick = await vscode.window.showWarningMessage(text, resolve, abort);
    if (pick === resolve) invoke('jbGit.conflicts.resolve', { repoRoot: repo.root });
    else if (pick === abort) this.abort(repo);
  }

  /** "Rebase stopped for editing" (an `edit`/`break` stop) or a failed `exec` → Continue / Abort. */
  async notifyRebaseStopped(repo: Repository, stop: 'edit' | 'exec' | 'other' | 'conflicts', output = ''): Promise<void> {
    if (stop === 'conflicts') return this.notifyConflicts(repo, 'rebase');
    const cont = 'Continue';
    const abort = 'Abort';
    let pick: string | undefined;
    if (stop === 'exec') {
      const last = output.trim().split('\n').filter((l) => l.trim() && !/^(hint|Rebasing)/.test(l)).slice(-1)[0] ?? '';
      pick = await vscode.window.showErrorMessage(`Rebase stopped${this.mention(repo)}: ${last}`, cont, abort);
    } else {
      pick = await vscode.window.showInformationMessage(
        `Rebase stopped for editing${this.mention(repo)}. Once you are satisfied with your changes you may continue.`,
        cont,
        abort,
      );
    }
    if (pick === cont) this.continue(repo);
    else if (pick === abort) this.abort(repo);
  }

  private async offerStageAndRetry(repo: Repository, op: OperationState): Promise<void> {
    const stage = 'Stage and Retry';
    const pick = await vscode.window.showErrorMessage(
      `${op === 'rebase' ? 'Continue rebase failed' : `Continue ${opName(op)[0]} failed`}: There are unstaged changes in tracked files preventing ${opName(op)[0]} from continuing`,
      stage,
    );
    if (pick !== stage) return;
    await this.guard(repo, async () => {
      const r = await repo.exec(['add', '-u'], { allowFail: true });
      if (r.code !== 0) return void showGitError(new Error(r.stderr), 'Failed to stage changes in tracked files');
      await this.step(repo, op, 'continue');
    });
  }

  private async offerSkipEmpty(repo: Repository, op: OperationState): Promise<void> {
    const skip = 'Skip Commit';
    const abort = `Abort ${opName(op)[1]}`;
    const pick = await vscode.window.showWarningMessage(
      `The ${opName(op)[0]} result is empty${this.mention(repo)}: all its changes are already in the current branch.`,
      skip,
      abort,
    );
    if (pick === skip) await this.skip(repo);
    else if (pick === abort) await this.abort(repo);
  }

  // ------------------------------------------------------------------ skip

  async skip(repo: Repository): Promise<void> {
    const op = repo.operationState();
    if (op !== 'rebase' && op !== 'cherry-pick' && op !== 'revert') {
      vscode.window.showInformationMessage(op === 'none' ? `No rebase in progress${this.mention(repo)}` : `Cannot skip a commit during ${opName(op)[0]}`);
      return;
    }
    await this.guard(repo, () => this.step(repo, op, 'skip'));
  }

  // ------------------------------------------------------------------ abort

  async abort(repo: Repository): Promise<void> {
    const op = repo.operationState();
    if (!SUPPORTED.includes(op)) {
      const msg = op === 'none' ? 'There is no merge, rebase, cherry-pick or revert in progress' : `Cannot abort ${opName(op)[0]} here`;
      vscode.window.showInformationMessage(`${msg}${this.mention(repo)}.`);
      return;
    }
    const Name = opName(op)[1];
    const { title, message } = abortConfirmation(op, repo.name, this.mention(repo));
    const ok = 'Abort';
    const pick = await vscode.window.showWarningMessage(title, { modal: true, detail: message }, ok);
    if (pick !== ok) return;
    await this.guard(repo, async () => {
      const progress = op === 'rebase' ? 'Aborting rebase process…' : `Aborting ${Name} Process`;
      const r = await this.progress(progress, () => repo.exec([op, '--abort'], { allowFail: true }));
      if (r.code !== 0) {
        showGitError(new Error((r.stderr || r.stdout).trim()), op === 'rebase' ? 'Abort rebase failed' : `${Name} abort failed`);
        return;
      }
      vscode.window.showInformationMessage(op === 'rebase' ? `Abort rebase succeeded${this.mention(repo)}` : `${Name} abort succeeded${this.mention(repo)}`);
    });
  }

  // ------------------------------------------------------------------ commit merge

  /** Git.Merge.Commit: commits the merge with the prepared MERGE_MSG (GitMerger.mergeCommit). */
  async commitMerge(repo: Repository): Promise<void> {
    if (repo.operationState() !== 'merge') {
      vscode.window.showInformationMessage(`There is no merge in progress${this.mention(repo)}.`);
      return;
    }
    if ((await unmerged(repo)).length) {
      await invoke('jbGit.conflicts.resolve', { repoRoot: repo.root });
      return;
    }
    await this.guard(repo, async () => {
      const hasMsg = readGitFile(repo, 'MERGE_MSG') !== undefined;
      const args = hasMsg ? ['commit', '-F', path.join(repo.gitDir, 'MERGE_MSG'), '--cleanup=strip'] : ['commit', '--no-edit'];
      const r = await this.progress('Committing merge…', () => repo.exec(args, { allowFail: true }));
      if (r.code !== 0) showGitError(new Error((r.stderr || r.stdout).trim()), 'Merge commit failed');
    });
  }
}
