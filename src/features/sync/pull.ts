// Pull dialog ("Pull to <branch>"): remote + remote branch(es) + "Modify options", then git pull with auto-stash
// and the "N files updated in M commits" / conflicts result. Cmd/Ctrl+F5 in the dialog fetches the remote.
import * as vscode from 'vscode';
import type { FeatureContext } from '../../core/context';
import type { Repository } from '../../core/repository';
import {
  autostashConflict,
  blockedBy,
  hasConflicts,
  notifyConflicts,
  notifyUpdated,
  openDialog,
  rangeStat,
  repoData,
  repoItems,
  repoOf,
  reportError,
  withProgress,
  withSavedChanges,
  type SyncArgs,
} from './common';
import { fetchRepo } from './fetch';
import { leavesUncommitted, pullArgs, splitRemoteRef } from './options';
import type { PullInit, PullRequest, RepoData } from './protocol';

export const pullTitle = (branch: string | undefined) => (branch ? `Pull to ${branch}` : 'Pull');

/** Remote branch names (without the remote prefix) of one remote. */
function branchesOf(data: RepoData, remote: string | undefined): string[] {
  if (!remote) return [];
  return data.refs.filter((r) => r.kind === 'remote' && r.name.startsWith(remote + '/')).map((r) => splitRemoteRef(r.name, data.remotes).branch);
}

async function pullData(repo: Repository): Promise<{ data: RepoData; remote?: string; branch?: string; branches: string[] }> {
  const data = await repoData(repo);
  const up = data.upstream ? splitRemoteRef(data.upstream, data.remotes) : undefined;
  const remote = up?.remote ?? (data.remotes.includes('origin') ? 'origin' : data.remotes[0]);
  const branches = branchesOf(data, remote);
  const branch = up?.remote === remote ? up.branch : data.branch && branches.includes(data.branch) ? data.branch : undefined;
  return { data, remote, branch, branches };
}

export async function pull(ctx: FeatureContext, args: SyncArgs): Promise<void> {
  const repo = await repoOf(ctx, args);
  if (!repo) return;
  try {
    const p = await pullData(repo);
    const init: PullInit = { title: pullTitle(p.data.branch), repos: repoItems(ctx), data: p.data, ref: p.branch, remote: p.remote, branches: p.branches, locale: vscode.env.language };
    const get = (root: string) => ctx.repos.get(root) ?? repo;
    const req = await openDialog<PullRequest>(ctx, 'pull', 'pull', init.title, { kind: 'pull', ...init }, (done, panel) => ({
      repoData: async (root: string) => {
        const d = await pullData(get(root));
        panel.title = pullTitle(d.data.branch);
        return d;
      },
      branches: async (q: { root: string; remote: string }) => branchesOf(await repoData(get(q.root)), q.remote),
      fetch: async (q: { root: string; remote: string }) => {
        const r = await fetchRepo(get(q.root), undefined, q.remote);
        if (r.errors.length) throw r.errors[0].error;
        return branchesOf(await repoData(get(q.root)), q.remote);
      },
      ok: (r: PullRequest) => done(r),
    }));
    if (!req) return;
    await runPull(get(req.root), req);
  } catch (e) {
    void reportError(e, 'Pull failed');
  }
}

async function runPull(repo: Repository, req: PullRequest): Promise<void> {
  const blocked = blockedBy(repo, 'pull');
  if (blocked) {
    vscode.window.showErrorMessage(`Cannot update. ${blocked}`);
    return;
  }
  const from = await repo.headHash();
  await withProgress(`Pulling changes from ${req.remote}`, async (token) => {
    try {
      const run = () => repo.exec(pullArgs(req), { token });
      const r = leavesUncommitted(req.options) ? await withSavedChanges(repo, 'Pull', run) : await run();
      const to = await repo.headHash();
      if (/Already up to date/i.test(r.stdout + r.stderr) && to === from) {
        vscode.window.showInformationMessage('All files are up to date');
      } else if (leavesUncommitted(req.options)) {
        vscode.window.showInformationMessage(`Pulled ${req.branches.map((b) => `${req.remote}/${b}`).join(', ')}. The result is not committed yet`);
      } else {
        void notifyUpdated([{ repo, from, to, stat: await rangeStat(repo, from, to) }]);
      }
      if (autostashConflict(r.stdout + r.stderr)) void notifyConflicts(repo, 'Local changes were restored with conflicts');
    } catch (e) {
      if ((await hasConflicts(repo)) || /CONFLICT/.test(e instanceof Error ? e.message : '')) {
        void notifyConflicts(repo, req.options.includes('rebase') ? 'Rebase stopped due to conflicts' : 'Merge conflicts detected. Resolve them before continuing update.');
        return;
      }
      void reportError(e, 'Pull failed');
    }
  });
}
