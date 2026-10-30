// Fetch (IntelliJ "Fetch All Remotes"): fetches every remote of every (or the given) repository with --prune,
// then reports "Fetch successful" (with pruned references), "No changes" or the errors per remote.
import * as vscode from 'vscode';
import type { FeatureContext } from '../../core/context';
import type { Repository } from '../../core/repository';
import { cfg, reposOf, reportError, withProgress, type SyncArgs } from './common';
import { prunedRefs } from './pushLogic';

let running = false;

async function snapshot(repo: Repository): Promise<string> {
  return (await repo.run(['for-each-ref', '--format=%(refname) %(objectname)', 'refs/remotes', 'refs/tags'], { quiet: true, allowFail: true })).stdout;
}

export interface FetchResult {
  repo: Repository;
  changed: boolean;
  pruned: string[];
  errors: { remote: string; error: unknown }[];
  noRemotes: boolean;
}

/** Fetches all remotes of one repository (also used by the Pull dialog to refresh branches). */
export async function fetchRepo(repo: Repository, token?: vscode.CancellationToken, only?: string): Promise<FetchResult> {
  const prune = cfg().get<boolean>('fetch.prune', true);
  const remotes = only ? [only] : (await repo.remotes()).map((r) => r.name);
  const res: FetchResult = { repo, changed: false, pruned: [], errors: [], noRemotes: !remotes.length };
  const before = await snapshot(repo);
  for (const remote of remotes) {
    if (token?.isCancellationRequested) break;
    try {
      const r = await repo.exec(['fetch', '--recurse-submodules=no', ...(prune ? ['--prune'] : []), remote], { token });
      res.pruned.push(...prunedRefs(r.stderr));
    } catch (e) {
      res.errors.push({ remote, error: e });
    }
  }
  res.changed = before !== (await snapshot(repo));
  return res;
}

export async function fetch(ctx: FeatureContext, args: SyncArgs): Promise<void> {
  if (running) {
    vscode.window.showInformationMessage('Fetch in progress…');
    return;
  }
  const repos = await reposOf(ctx, args);
  if (!repos.length) return;
  running = true;
  let results: FetchResult[] = [];
  try {
    results = (await withProgress('Fetching…', async (token, progress) => {
      const out: FetchResult[] = [];
      for (const repo of repos) {
        if (token.isCancellationRequested) break;
        if (repos.length > 1) progress.report({ message: repo.name });
        out.push(await fetchRepo(repo, token));
      }
      return out;
    })) ?? [];
  } finally {
    running = false;
  }
  const many = repos.length > 1;
  const failed = results.filter((r) => r.errors.length);
  for (const r of failed) {
    for (const e of r.errors) {
      const msg = e.error instanceof Error ? e.error.message : String(e.error);
      const auth = /Authentication failed|could not read Username|Permission denied \(publickey\)/i.test(msg);
      await reportError(e.error, auth ? 'Fetch failed: authorization error' : `Fetch failed${many || r.errors.length > 1 ? ` (${many ? `${r.repo.name}: ` : ''}${e.remote})` : ''}`);
    }
  }
  const ok = results.filter((r) => !r.errors.length && !r.noRemotes);
  if (!ok.length) {
    if (!failed.length) vscode.window.showWarningMessage(results.length ? 'No remotes defined' : 'Fetch cancelled');
    return;
  }
  const pruned = ok.flatMap((r) => r.pruned);
  const changed = ok.some((r) => r.changed);
  const title = failed.length ? 'Fetch partially failed' : 'Fetch successful';
  const detail = pruned.length ? `Pruned obsolete remote ${pruned.length === 1 ? 'reference' : 'references'}: ${pruned.join(', ')}` : changed ? '' : 'No changes';
  vscode.window.showInformationMessage(detail ? `${title}. ${detail}` : title);
}
