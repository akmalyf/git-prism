// Conflict resolution & in-progress operations: implements gitPrism.conflicts.resolve (the "Conflicts" dialog) and
// gitPrism.operation.continue / abort / skip, the Git menu actions of IntelliJ's Merge/Rebase groups and the status bar widget.
import * as vscode from 'vscode';
import type { FeatureContext } from '../../core/context';
import { implement } from '../../core/contracts';
import type { Repository } from '../../core/repository';
import type { OperationState } from '../../core/types';
import { unmerged } from './gitState';
import { Operations } from './operations';
import { ConflictsPanel } from './panel';
import { OperationWidget } from './widget';

export function activate(ctx: FeatureContext): void {
  const ops = new Operations(ctx);
  const widget = new OperationWidget(ctx, ops);

  const resolve = async (repoRoot?: string): Promise<void> => {
    await ctx.repos.ready();
    let roots: string[];
    if (repoRoot) {
      const repo = ctx.repos.get(repoRoot) ?? (await ctx.repos.open(repoRoot));
      if (!repo) {
        vscode.window.showErrorMessage(`Not a Git repository: ${repoRoot}`);
        return;
      }
      roots = [repo.root];
      if (!(await unmerged(repo)).length && repo.operationState() === 'none') {
        vscode.window.showInformationMessage(`There are no unresolved conflicts${ops.mention(repo)}.`);
        return;
      }
    } else {
      const withConflicts: Repository[] = [];
      for (const r of ctx.repos.all) if ((await unmerged(r)).length) withConflicts.push(r);
      if (!withConflicts.length) {
        vscode.window.showInformationMessage('There are no unresolved conflicts.');
        return;
      }
      roots = withConflicts.map((r) => r.root);
    }
    ConflictsPanel.show(ctx, ops, roots);
  };

  /** Runs `fn` on the repository of `repoRoot`, or the one (picked) whose state is `state`. */
  const forState =
    (state: OperationState, none: string, fn: (repo: Repository) => Promise<void>) =>
    async (arg?: { repoRoot?: string } | vscode.Uri) => {
      const repoRoot = arg instanceof vscode.Uri ? ctx.repos.forUri(arg)?.root : arg?.repoRoot;
      const repo = await ops.pickRepo(repoRoot && ctx.repos.get(repoRoot)?.operationState() === state ? repoRoot : undefined, [state], none);
      if (repo) await fn(repo);
    };

  const anyOp = (fn: (repo: Repository) => Promise<void>) => async (args: { repoRoot?: string }) => {
    const repo = await ops.pickRepo(args?.repoRoot);
    if (repo) await fn(repo);
  };

  const noRebase = 'No rebase in progress';
  const noMerge = 'There is no merge in progress';
  const noPick = 'No cherry-pick in progress';
  const noRevert = 'There is no revert in progress';

  ctx.extension.subscriptions.push(
    widget,
    // from menus the argument is the clicked resource: show every repository with conflicts, like IntelliJ
    implement('gitPrism.conflicts.resolve', (args) => resolve(args instanceof vscode.Uri ? undefined : args?.repoRoot)),
    implement('gitPrism.operation.continue', anyOp((r) => ops.continue(r))),
    implement('gitPrism.operation.abort', anyOp((r) => ops.abort(r))),
    implement('gitPrism.operation.skip', anyOp((r) => ops.skip(r))),
    vscode.commands.registerCommand('gitPrism.conflicts.operationActions', (args?: { repoRoot?: string }) => widget.showActions(args?.repoRoot)),
    vscode.commands.registerCommand('gitPrism.conflicts.rebaseContinue', forState('rebase', noRebase, (r) => ops.continue(r))),
    vscode.commands.registerCommand('gitPrism.conflicts.rebaseSkip', forState('rebase', noRebase, (r) => ops.skip(r))),
    vscode.commands.registerCommand('gitPrism.conflicts.rebaseAbort', forState('rebase', noRebase, (r) => ops.abort(r))),
    vscode.commands.registerCommand('gitPrism.conflicts.mergeCommit', forState('merge', noMerge, (r) => ops.commitMerge(r))),
    vscode.commands.registerCommand('gitPrism.conflicts.mergeAbort', forState('merge', noMerge, (r) => ops.abort(r))),
    vscode.commands.registerCommand('gitPrism.conflicts.cherryPickContinue', forState('cherry-pick', noPick, (r) => ops.continue(r))),
    vscode.commands.registerCommand('gitPrism.conflicts.cherryPickAbort', forState('cherry-pick', noPick, (r) => ops.abort(r))),
    vscode.commands.registerCommand('gitPrism.conflicts.revertAbort', forState('revert', noRevert, (r) => ops.abort(r))),
  );
}
