// Branches feature: the Git Branches popup and per-ref actions, branch/tag
// management, remotes, worktrees, clone/init, clean-up and the VCS Operations popup.
import * as vscode from 'vscode';
import type { FeatureContext } from '../../core/context';
import { implement } from '../../core/contracts';
import { showGitError } from '../../core/git';
import type { Repository } from '../../core/repository';
import { showBranchActions } from './actions';
import { cmdArgs, type CmdArgs, resolveRepo } from './common';
import { showBranchesPopup } from './popup';
import { checkout, checkoutRevision, deleteRef, deleteTag, newBranch, newTag, pickTag, renameBranch } from './ops';
import { manageRemotes } from './remotes';
import { checkShallow, cleanupBranches, cloneRepository, copyBranchName, findMergedBranches, initRepository, unshallow, vcsOperations } from './repoTools';
import { showWorktrees } from './worktrees';

export function activate(ctx: FeatureContext): void {
  const subs = ctx.extension.subscriptions;
  /** wraps a handler that needs a repository: resolves it from the args, reports unexpected errors */
  const withRepo = (fn: (repo: Repository, a: CmdArgs) => unknown) => async (raw: unknown) => {
    const a = cmdArgs(raw);
    try {
      const repo = await resolveRepo(ctx, a.repoRoot, a.uri);
      if (repo) await fn(repo, a);
    } catch (e) {
      await showGitError(e);
    }
  };
  const safe = (fn: (a: CmdArgs) => unknown) => async (raw: unknown) => {
    try {
      await fn(cmdArgs(raw));
    } catch (e) {
      await showGitError(e);
    }
  };
  const reg = (id: string, fn: (raw: unknown) => unknown) => subs.push(vscode.commands.registerCommand(id, fn));

  // contract commands
  subs.push(
    implement('gitPrism.branches.show', safe((a) => showBranchesPopup(ctx, a.repoRoot ?? (a.uri ? ctx.repos.forUri(a.uri)?.root : undefined)))),
    implement('gitPrism.branch.new', withRepo((repo, a) => newBranch(repo, a.ref))),
    implement(
      'gitPrism.branch.checkout',
      withRepo((repo, a) => (a.ref ? checkout(repo, a.ref) : checkoutRevision(repo))),
    ),
    implement('gitPrism.tag.new', withRepo((repo, a) => newTag(repo, a.ref))),
    implement('gitPrism.branch.rename', withRepo((repo, a) => renameBranch(repo, a.ref))),
    implement('gitPrism.branch.delete', withRepo((repo, a) => deleteRef(repo, a.ref))),
    implement(
      'gitPrism.tag.delete',
      withRepo(async (repo, a) => {
        const tag = a.ref ?? (await pickTag(repo, 'Select a tag to delete'));
        if (tag) await deleteTag(repo, tag.replace(/^refs\/tags\//, ''));
      }),
    ),
    implement(
      'gitPrism.branch.actions',
      withRepo((repo, a) => (a.ref ? showBranchActions(ctx, repo, a.ref) : showBranchesPopup(ctx, repo.root))),
    ),
  );

  // feature commands
  reg('gitPrism.checkoutRevision', withRepo((repo) => checkoutRevision(repo)));
  reg('gitPrism.cleanupBranches', withRepo((repo) => cleanupBranches(repo)));
  reg('gitPrism.findMergedBranches', withRepo((repo) => findMergedBranches(ctx, repo)));
  reg('gitPrism.remotes.manage', withRepo((repo) => manageRemotes(repo)));
  reg('gitPrism.worktrees', withRepo((repo) => showWorktrees(repo)));
  reg('gitPrism.clone', safe(() => cloneRepository(ctx)));
  reg('gitPrism.init', safe((a) => initRepository(ctx, a.uri)));
  reg('gitPrism.unshallow', withRepo((repo) => unshallow(repo)));
  reg('gitPrism.copyBranchName', withRepo((repo, a) => copyBranchName(repo, a.ref)));
  reg('gitPrism.vcsOperations', safe(() => vcsOperations()));


  // "Shallow repository detected" hint
  const notified = new Set<string>();
  const checkAll = () => {
    for (const r of ctx.repos.all) checkShallow(ctx, r, notified).catch(() => undefined);
  };
  subs.push(ctx.repos.onDidChangeRepositories(checkAll));
  checkAll();
}
