// Merge dialog ("Merge into <current>"): git merge <branch> with IntelliJ's "Modify options", then the result
// notification ("Merged x to y" / "Already up to date") or conflict handling.
import * as vscode from 'vscode';
import type { FeatureContext } from '../../core/context';
import type { RefArgs } from '../../core/contracts';
import type { Repository } from '../../core/repository';
import { autostashConflict, blockedBy, hasConflicts, notifyConflicts, openDialog, repoData, repoItems, repoOf, reportError, withProgress, withSavedChanges } from './common';
import { leavesUncommitted, mergeArgs } from './options';
import type { MergeRequest, RefDialogInit } from './protocol';

export const mergeTitle = (branch: string | undefined) => (branch ? `Merge into ${branch}` : 'Merge Changes');

export async function merge(ctx: FeatureContext, args: RefArgs | vscode.Uri | undefined): Promise<void> {
  const repo = await repoOf(ctx, args);
  if (!repo) return;
  const ref = args instanceof vscode.Uri ? undefined : args?.ref;
  try {
    const data = await repoData(repo, { merged: true });
    const init: RefDialogInit = { title: mergeTitle(data.branch), repos: repoItems(ctx), data, ref, locale: vscode.env.language };
    const req = await openDialog<MergeRequest>(ctx, 'merge', 'merge-dialog', init.title, init, (done, panel) => ({
      repoData: async (root: string) => {
        const d = await repoData(ctx.repos.get(root) ?? repo, { merged: true });
        panel.title = mergeTitle(d.branch);
        return d;
      },
      ok: (r: MergeRequest) => done(r),
    }));
    if (!req) return;
    await runMerge(ctx.repos.get(req.root) ?? repo, req);
  } catch (e) {
    void reportError(e, 'Merge failed');
  }
}

async function runMerge(repo: Repository, req: MergeRequest): Promise<void> {
  const blocked = blockedBy(repo, 'merge');
  if (blocked) {
    vscode.window.showErrorMessage(`Merge is not possible. ${blocked}`);
    return;
  }
  const branch = (await repo.currentBranch()) ?? 'HEAD';
  await withProgress(`Merging ${req.ref}…`, async (token) => {
    try {
      const run = () => repo.exec(mergeArgs({ ref: req.ref, options: req.options, message: req.message }), { token });
      const r = leavesUncommitted(req.options) ? await withSavedChanges(repo, 'Merge', run) : await run();
      const out = r.stdout + r.stderr;
      if (/Already up to date/i.test(out)) vscode.window.showInformationMessage('Already up to date');
      else if (leavesUncommitted(req.options)) vscode.window.showInformationMessage(`Merged ${req.ref} to ${branch}. The result is not committed yet`);
      else vscode.window.showInformationMessage(`Merged ${req.ref} to ${branch}`);
      if (autostashConflict(out)) void notifyConflicts(repo, 'Local changes were restored with conflicts');
    } catch (e) {
      if ((await hasConflicts(repo)) || /CONFLICT/.test(e instanceof Error ? e.message : '')) {
        void notifyConflicts(repo, `${req.ref} Merged with Conflicts`);
        return;
      }
      void reportError(e, `Could Not Merge ${req.ref}`);
    }
  });
}
