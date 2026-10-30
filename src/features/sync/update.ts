// Update Project (IntelliJ Cmd+T): optional "Update Project" dialog, then per repository fetch the tracked remote
// and merge / rebase the tracked branch with auto-stash. Also used to update before re-pushing a rejected push.
import * as vscode from 'vscode';
import type { FeatureContext } from '../../core/context';
import { invoke } from '../../core/contracts';
import type { Repository } from '../../core/repository';
import {
  autostashConflict,
  cfg,
  hasConflicts,
  notifyConflicts,
  notifyUpdated,
  openDialog,
  rangeStat,
  reposOf,
  reportError,
  withProgress,
  type RangeStat,
  type SyncArgs,
} from './common';
import type { SavePolicy, UpdateInit, UpdateMethod, UpdateRequest } from './protocol';

export interface UpdateTarget {
  remote: string;
  /** branch name on the remote */
  branch: string;
}

export type UpdateOutcome =
  | { kind: 'updated' | 'uptodate'; from?: string; to?: string; stat: RangeStat; stashConflict?: boolean }
  | { kind: 'skipped'; reason: string }
  | { kind: 'conflict' | 'error'; message: string };

let running = false;

export async function updateProject(ctx: FeatureContext, args: SyncArgs): Promise<void> {
  if (running) {
    vscode.window.showWarningMessage('Update is already running');
    return;
  }
  const repos = await reposOf(ctx, args);
  if (!repos.length) return;
  let method = configuredMethod();
  let policy = (cfg().get<SavePolicy>('update.saveChangesPolicy') ?? 'stash') as SavePolicy;
  if (cfg().get<boolean>('update.showDialog', true)) {
    const init: UpdateInit = { kind: 'update', title: 'Update Project', method: method === 'branchDefault' ? 'merge' : method, policy };
    const req = await openDialog<UpdateRequest>(ctx, 'update', 'pull', 'Update Project', init, (done) => ({ ok: (r: UpdateRequest) => done(r) }));
    if (!req) return;
    method = req.method;
    policy = req.policy;
    const c = cfg();
    await c.update('update.method', req.method, vscode.ConfigurationTarget.Global);
    await c.update('update.saveChangesPolicy', req.policy, vscode.ConfigurationTarget.Global);
    if (req.dontShowAgain) await c.update('update.showDialog', false, vscode.ConfigurationTarget.Global);
  }
  running = true;
  try {
    await runUpdate(repos, method);
  } finally {
    running = false;
  }
}

function configuredMethod(): UpdateMethod | 'branchDefault' {
  const m = cfg().get<string>('update.method') ?? 'merge';
  return m === 'rebase' || m === 'branchDefault' ? m : 'merge';
}

/** Updates the given repositories and shows the summary notification. */
export async function runUpdate(repos: Repository[], method: UpdateMethod | 'branchDefault'): Promise<void> {
  const results: { repo: Repository; outcome: UpdateOutcome }[] = [];
  await withProgress('Updating…', async (token, progress) => {
    for (const repo of repos) {
      if (token.isCancellationRequested) break;
      progress.report({ message: repos.length > 1 ? repo.name : undefined });
      results.push({ repo, outcome: await updateRepo(repo, method, undefined, token) });
    }
  });
  const many = repos.length > 1;
  const skipped = results.filter((r) => r.outcome.kind === 'skipped');
  const errors = results.filter((r) => r.outcome.kind === 'error');
  const conflicts = results.filter((r) => r.outcome.kind === 'conflict');
  const ok = results.filter((r) => r.outcome.kind === 'updated' || r.outcome.kind === 'uptodate');

  for (const r of errors) void reportError(new Error((r.outcome as { message: string }).message), many ? `Update failed for ${r.repo.name}` : 'Update failed');
  for (const r of conflicts) void notifyConflicts(r.repo, (r.outcome as { message: string }).message);
  if (!ok.length && skipped.length) {
    const lines = skipped.map((r) => `${r.repo.name} was skipped (${(r.outcome as { reason: string }).reason})`);
    const noTracked = skipped.find((s) => (s.outcome as { reason: string }).reason === 'no tracked branch');
    void vscode.window.showErrorMessage(`Cannot update: ${lines.join(', ')}`, ...(noTracked ? ['Choose upstream branch'] : [])).then((pick) => {
      if (pick && noTracked) void chooseUpstream(noTracked.repo);
    });
    return;
  }
  if (!ok.length) return;
  const prefix = skipped.length ? `Project Partially Updated. Skipped ${skipped.length} ${skipped.length === 1 ? 'repository' : 'repositories'}: ${skipped.map((r) => `${r.repo.name} (${(r.outcome as { reason: string }).reason})`).join(', ')}. ` : '';
  const stashConflicts = ok.filter((r) => (r.outcome as { stashConflict?: boolean }).stashConflict);
  for (const r of stashConflicts) {
    void vscode.window.showWarningMessage('Local changes were restored with conflicts. Uncommitted changes that were stashed before update have conflicts with updated files.', 'Resolve Conflicts…').then((pick) => {
      if (pick) invoke('jbGit.conflicts.resolve', { repoRoot: r.repo.root });
    });
  }
  void notifyUpdated(
    ok.map((r) => {
      const o = r.outcome as { from?: string; to?: string; stat: RangeStat };
      return { repo: r.repo, from: o.from, to: o.to, stat: o.stat };
    }),
    prefix,
  );
}

/** Lets the user set the upstream of the current branch (IntelliJ "Choose upstream branch"). */
async function chooseUpstream(repo: Repository): Promise<void> {
  const branch = await repo.currentBranch();
  if (!branch) return;
  const refs = (await repo.refs()).filter((r) => r.type === 'remote' && !r.name.endsWith('/HEAD'));
  const pick = await vscode.window.showQuickPick(refs.map((r) => ({ label: r.short, iconPath: new vscode.ThemeIcon('git-branch') })), { placeHolder: `Choose upstream branch for ${branch}` });
  if (!pick) return;
  try {
    await repo.exec(['branch', `--set-upstream-to=${pick.label}`, branch]);
  } catch (e) {
    await reportError(e, 'Cannot set an upstream branch');
  }
}

/** Upstream of the current branch as remote + branch (from branch.<name>.remote / .merge). */
export async function trackedOf(repo: Repository, branch: string): Promise<UpdateTarget | undefined> {
  const remote = await repo.config(`branch.${branch}.remote`);
  const merge = await repo.config(`branch.${branch}.merge`);
  if (!remote || !merge) return undefined;
  return { remote, branch: merge.replace(/^refs\/heads\//, '') };
}

function trackingRef(t: UpdateTarget): string {
  return t.remote === '.' ? t.branch : `${t.remote}/${t.branch}`;
}

async function branchMethod(repo: Repository, branch: string): Promise<UpdateMethod> {
  const v = (await repo.config(`branch.${branch}.rebase`)) ?? (await repo.config('pull.rebase'));
  return v && v !== 'false' ? 'rebase' : 'merge';
}

/** Pre-checks, fetch, merge/rebase of one repository. `target` overrides the tracked branch (rejected push). */
export async function updateRepo(repo: Repository, method: UpdateMethod | 'branchDefault', target?: UpdateTarget, token?: vscode.CancellationToken): Promise<UpdateOutcome> {
  try {
    const op = repo.operationState();
    if (op === 'merge') return { kind: 'error', message: 'You have unfinished merge. These conflicts must be resolved before update.' };
    if (op === 'rebase') return { kind: 'error', message: 'You have unfinished rebase process. These conflicts must be resolved before update.' };
    const status = await repo.status();
    if (status.entries.some((e) => e.kind === 'U')) return { kind: 'error', message: 'Unmerged files detected. These conflicts must be resolved before update.' };
    const branch = status.branch.head;
    if (!branch) return { kind: 'skipped', reason: 'detached HEAD' };
    const tracked = target ?? (await trackedOf(repo, branch));
    if (!tracked) return { kind: 'skipped', reason: 'no tracked branch' };
    if (tracked.remote !== '.') {
      const prune = cfg().get<boolean>('fetch.prune', true);
      await repo.exec(['fetch', ...(prune ? ['--prune'] : []), tracked.remote], { token });
    }
    const up = trackingRef(tracked);
    const exists = await repo.run(['rev-parse', '--verify', '--quiet', `${up}^{commit}`], { allowFail: true, quiet: true });
    if (exists.code !== 0) return { kind: 'skipped', reason: `${up} doesn't exist` };
    const from = status.branch.oid;
    if (from) {
      const behind = await repo.run(['rev-list', '--count', `HEAD..${up}`], { quiet: true });
      if (+behind.stdout.trim() === 0) return { kind: 'uptodate', from, to: from, stat: { commits: 0, files: 0 } };
    }
    const m = method === 'branchDefault' ? await branchMethod(repo, branch) : method;
    let out = '';
    try {
      const r = m === 'rebase'
        ? await repo.exec(['rebase', '--autostash', up], { token })
        : await repo.exec(['merge', '--autostash', '--no-edit', up], { token });
      out = r.stdout + r.stderr;
    } catch (e) {
      if ((await hasConflicts(repo)) || /CONFLICT/.test(e instanceof Error ? e.message : '')) {
        return { kind: 'conflict', message: m === 'rebase' ? 'Merge conflicts detected. Resolve them before continuing rebase.' : 'Merge conflicts detected. Resolve them before continuing update.' };
      }
      throw e;
    }
    const to = await repo.headHash();
    return { kind: 'updated', from, to, stat: await rangeStat(repo, from, to), stashConflict: autostashConflict(out) };
  } catch (e) {
    return { kind: 'error', message: e instanceof Error ? e.message : String(e) };
  }
}
