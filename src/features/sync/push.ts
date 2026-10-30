// Push dialog ("Push Commits to <repo>"): per repository "<branch> → <remote> : <target>" with the outgoing commits,
// their changed files, Push tags / Run Git hooks, Push / Force Push. Then git push --porcelain per repository, the
// IntelliJ result notification, upstream setup for new branches and the "Push Rejected" → Merge / Rebase → re-push flow.
import * as vscode from 'vscode';
import type { FeatureContext } from '../../core/context';
import { invoke, type DiffFile } from '../../core/contracts';
import { GitError } from '../../core/git';
import type { Repository } from '../../core/repository';
import { cfg, notifyConflicts, openDialog, reposOf, reportError, withProgress, type SyncArgs } from './common';
import type { PushCommit, PushInit, PushRepo, PushRequest, PushTargetInfo, PushTargetQuery } from './protocol';
import { describePush, isNonFastForward, isProtected, parseDiffTreeStdin, parsePatterns, parsePushPorcelain, pushedTags, squashChanges, type SquashedChange } from './pushLogic';
import { trackedOf, updateRepo } from './update';

const MAX_COMMITS = 1000;

export function protectedPatterns(): string[] {
  return parsePatterns(cfg().get<string | string[]>('push.protectedBranches') ?? 'master, main');
}

async function refExists(repo: Repository, ref: string): Promise<boolean> {
  return (await repo.run(['rev-parse', '--verify', '--quiet', ref], { allowFail: true, quiet: true })).code === 0;
}

async function remoteBranches(repo: Repository, remote: string): Promise<string[]> {
  const r = await repo.run(['for-each-ref', '--format=%(refname)', `refs/remotes/${remote}/`], { quiet: true, allowFail: true });
  const prefix = `refs/remotes/${remote}/`;
  return r.stdout.split('\n').filter((l) => l.startsWith(prefix) && l !== `${prefix}HEAD`).map((l) => l.slice(prefix.length));
}

async function commitsOf(repo: Repository, args: string[]): Promise<PushCommit[]> {
  const list = await repo.log([`--max-count=${MAX_COMMITS}`, '--topo-order', ...args]);
  return list.map((c) => ({ hash: c.hash, parents: c.parents, subject: c.subject, author: c.author, authorEmail: c.authorEmail, date: c.authorDate }));
}

/** Outgoing commits of `source` for remote/target: <remote>/<target>..source, or for a new branch everything not on the remote. */
async function targetInfo(repo: Repository, source: string, remote: string, target: string): Promise<PushTargetInfo> {
  const branches = await remoteBranches(repo, remote);
  const tracking = `refs/remotes/${remote}/${target}`;
  const isNew = !target || !(await refExists(repo, tracking));
  let commits: PushCommit[] = [];
  if (target) commits = isNew ? await commitsOf(repo, [source, '--not', `--remotes=${remote}`]) : await commitsOf(repo, [`${tracking}..${source}`]);
  return { isNew, commits, remoteBranches: branches };
}

async function defaultRemote(repo: Repository, branch: string | undefined, remotes: string[]): Promise<string | undefined> {
  if (!remotes.length) return undefined;
  const cands = [branch && (await repo.config(`branch.${branch}.pushRemote`)), await repo.config('remote.pushDefault'), branch && (await repo.config(`branch.${branch}.remote`)), 'origin'];
  return cands.find((c): c is string => !!c && remotes.includes(c)) ?? remotes[0];
}

/** `pushBranch`: push that local branch instead of the current one (branch popup / Git log branch tree "Push…"). */
async function loadRepo(repo: Repository, upTo: string | undefined, selected: boolean, pushBranch?: string): Promise<PushRepo> {
  const status = await repo.status();
  const remotes = (await repo.remotes()).map((r) => r.name);
  if (pushBranch && pushBranch !== status.branch.head) {
    const oid = (await repo.run(['rev-parse', '--verify', '--quiet', `refs/heads/${pushBranch}^{commit}`], { allowFail: true, quiet: true })).stdout.trim();
    const base: PushRepo = { root: repo.root, name: repo.name, branch: pushBranch, source: '', remotes, isNew: false, setUpstream: false, remoteBranches: [], commits: [], selected };
    if (!oid) return { ...base, problem: 'Cannot push', selected: false };
    const remote = await defaultRemote(repo, pushBranch, remotes);
    const tracked = await trackedOf(repo, pushBranch);
    const target = tracked && tracked.remote === remote ? tracked.branch : pushBranch;
    const source = upTo ? await repo.revParse(upTo) : oid;
    const info = remote ? await targetInfo(repo, source, remote, target) : { isNew: false, commits: [], remoteBranches: [] };
    return { ...base, source, remote, target: remote ? target : undefined, ...info, setUpstream: !tracked };
  }
  const base: PushRepo = { root: repo.root, name: repo.name, branch: status.branch.head, source: '', remotes, isNew: false, setUpstream: false, remoteBranches: [], commits: [], selected };
  if (!status.branch.oid) return { ...base, problem: 'Empty repository', selected: false };
  const source = upTo ? await repo.revParse(upTo) : status.branch.oid;
  const branch = status.branch.head;
  if (!branch) {
    // detached HEAD: "HEAD → <remote> : Enter target branch", pushed as <commit>:refs/heads/<target> without upstream
    const remote = await defaultRemote(repo, undefined, remotes);
    return { ...base, branch: undefined, source, remote, target: remote ? '' : undefined, isNew: false, remoteBranches: remote ? await remoteBranches(repo, remote) : [] };
  }
  const remote = await defaultRemote(repo, branch, remotes);
  const tracked = await trackedOf(repo, branch);
  const target = tracked && tracked.remote === remote ? tracked.branch : branch;
  const info = remote ? await targetInfo(repo, source, remote, target) : { isNew: false, commits: [], remoteBranches: [] };
  return { ...base, source, remote, target: remote ? target : undefined, ...info, setUpstream: !tracked };
}

/** Net changed files of the selected outgoing commits (one diff-tree call; merges against their first parent). */
async function changesOf(repo: Repository, commits: PushCommit[]): Promise<SquashedChange[]> {
  if (!commits.length) return [];
  // commits come newest first; feed "<commit> <first parent>" lines so merges diff against their first parent
  const input = commits.map((c) => (c.parents.length ? `${c.hash} ${c.parents[0]}` : c.hash)).join('\n') + '\n';
  const r = await repo.run(['diff-tree', '--stdin', '-z', '--name-status', '-r', '-M', '--root', '--always'], { input, quiet: true });
  const files = parseDiffTreeStdin(r.stdout);
  return squashChanges([...commits].reverse().map((c) => ({ hash: c.hash, root: !c.parents.length, files: files.get(c.hash) ?? [] })));
}

/** `branch`: a local branch to push instead of the current one (jbGit.sync.pushBranch); limits the dialog to one repository. */
export async function push(ctx: FeatureContext, args: (SyncArgs & { upTo?: string; force?: boolean; branch?: string }) | vscode.Uri | undefined): Promise<void> {
  const a = args instanceof vscode.Uri ? undefined : args;
  let repos = await reposOf(ctx, args);
  if (!repos.length) return;
  if (a?.upTo || a?.branch) repos = repos.slice(0, 1);
  try {
    const items: PushRepo[] = [];
    for (const r of repos) items.push(await loadRepo(r, a?.upTo, true, a?.branch));
    // multi-repo: preselect repositories with something to push (IntelliJ selects the ones with outgoing commits)
    if (items.length > 1) for (const it of items) it.selected = !it.problem && (it.commits.length > 0 || it.isNew);
    if (items.length > 1 && !items.some((i) => i.selected)) for (const it of items) it.selected = !it.problem;
    const state = ctx.extension.workspaceState;
    const init: PushInit = {
      title: repos.length === 1 ? `Push Commits to ${repos[0].name}` : 'Push Commits',
      repos: items,
      pushTags: state.get('jbGit.push.tags', false),
      tagMode: state.get<'all' | 'current'>('jbGit.push.tagMode', 'all'),
      runHooks: state.get('jbGit.push.runHooks', true),
      forceDefault: !!a?.force,
      protectedPatterns: protectedPatterns(),
      locale: vscode.env.language,
    };
    const get = (root: string) => ctx.repos.get(root) ?? repos[0];
    const sources = new Map(items.map((i) => [i.root, i.source]));
    const req = await openDialog<PushRequest>(ctx, 'push', 'push', init.title, init, (done) => ({
      target: (q: PushTargetQuery) => targetInfo(get(q.root), sources.get(q.root) ?? 'HEAD', q.remote, q.target),
      changes: (q: { root: string; commits: PushCommit[] }) => changesOf(get(q.root), q.commits),
      details: async (q: { root: string; hash: string }) => (await get(q.root).run(['show', '-s', '--format=%B', q.hash], { quiet: true })).stdout.replace(/\n+$/, ''),
      showDiff: async (q: { root: string; commits: PushCommit[]; path: string }) => {
        const changes = await changesOf(get(q.root), q.commits);
        const files: DiffFile[] = changes.map((c) => ({
          repoRoot: q.root,
          path: c.path,
          oldPath: c.oldPath,
          kind: c.kind,
          left: c.kind === 'A' || c.firstRoot ? { empty: true } : { rev: `${c.first}^`, path: c.oldPath ?? c.path },
          right: c.kind === 'D' ? { empty: true } : { rev: c.last, path: c.path },
          leftTitle: c.kind === 'A' || c.firstRoot ? undefined : c.first.slice(0, 8) + '^',
          rightTitle: c.last.slice(0, 8),
        }));
        const index = Math.max(0, files.findIndex((f) => f.path === q.path));
        await invoke('jbGit.diff.show', { files, index, title: q.path.split('/').pop() });
      },
      defineRemote: async (q: { root: string; name: string; url: string }) => {
        const repo = get(q.root);
        await repo.exec(['remote', 'add', q.name, q.url]);
        // fetch so the remote branches are known (a fresh remote may be empty or unreachable: ignore errors)
        await repo.exec(['fetch', q.name], { allowFail: true });
        const it = await loadRepo(repo, a?.upTo, true, a?.branch);
        sources.set(it.root, it.source);
        return it;
      },
      push: (r: PushRequest) => done(r),
    }));
    if (!req) return;
    await state.update('jbGit.push.tags', req.pushTags);
    await state.update('jbGit.push.tagMode', req.tagMode);
    await state.update('jbGit.push.runHooks', req.runHooks);
    await runPush(ctx, req, items, a?.upTo);
  } catch (e) {
    await reportError(e, 'Push failed');
  }
}

interface RepoPush {
  repo: Repository;
  item: PushRepo;
  remote: string;
  target: string;
}

interface PushOutcome {
  p: RepoPush;
  text?: string;
  rejected?: boolean;
  /** non-fast-forward rejection of the current branch: offer Merge / Rebase and push again */
  needsUpdate?: boolean;
  error?: unknown;
}

async function pushOne(p: RepoPush, req: PushRequest, upTo: string | undefined, token: vscode.CancellationToken): Promise<PushOutcome> {
  const { repo, item, remote, target } = p;
  // detached HEAD pushes the commit shown in the dialog (item.source), never HEAD's later state
  const src = upTo ? await repo.revParse(upTo) : item.branch ? `refs/heads/${item.branch}` : item.source;
  const tracking = `refs/remotes/${remote}/${target}`;
  const count = (await refExists(repo, tracking))
    ? +(await repo.run(['rev-list', '--count', `${tracking}..${src}`], { quiet: true })).stdout.trim()
    : +(await repo.run(['rev-list', '--count', src, '--not', `--remotes=${remote}`], { quiet: true })).stdout.trim();
  const args = ['push', '--porcelain', '--progress'];
  if (req.force) args.push('--force-with-lease');
  if (!req.runHooks) args.push('--no-verify');
  if (req.pushTags) args.push(req.tagMode === 'all' ? '--tags' : '--follow-tags');
  args.push(remote, `${src}:refs/heads/${target}`);
  const r = await repo.exec(args, { allowFail: true, token });
  const results = parsePushPorcelain(r.stdout);
  const branch = results.find((x) => x.to === `refs/heads/${target}`);
  if (r.code !== 0 && !branch) return { p, error: new GitError(args, r.code, r.stderr, r.stdout) };
  const text = describePush({ target: `${remote}/${target}`, remote, count, branch, tags: pushedTags(results), force: req.force });
  if (branch?.flag === 'rejected') {
    // Merge / Rebase and push again only for the current branch (IntelliJ); another branch's rejection is just reported
    const head = item.branch && (await repo.run(['symbolic-ref', '--quiet', '--short', 'HEAD'], { allowFail: true, quiet: true })).stdout.trim();
    return { p, text, rejected: true, needsUpdate: isNonFastForward(branch) && !upTo && !!item.branch && head === item.branch };
  }
  if (item.setUpstream && item.branch && !upTo) {
    await repo.exec(['branch', `--set-upstream-to=${remote}/${target}`, item.branch], { allowFail: true });
  }
  return { p, text };
}

async function runPush(ctx: FeatureContext, req: PushRequest, items: PushRepo[], upTo: string | undefined): Promise<void> {
  const patterns = protectedPatterns();
  const plan: RepoPush[] = [];
  for (const r of req.repos) {
    const repo = ctx.repos.get(r.root);
    const item = items.find((i) => i.root === r.root);
    if (!repo || !item) continue;
    if (req.force && isProtected(r.target, patterns)) {
      vscode.window.showErrorMessage(`Force push to ${r.target} is prohibited`);
      return;
    }
    plan.push({ repo, item, remote: r.remote, target: r.target });
  }
  if (!plan.length) return;
  const outcomes = (await withProgress('Pushing…', async (token, progress) => {
    const out: PushOutcome[] = [];
    for (const p of plan) {
      if (token.isCancellationRequested) break;
      if (plan.length > 1) progress.report({ message: p.repo.name });
      try {
        out.push(await pushOne(p, req, upTo, token));
      } catch (e) {
        out.push({ p, error: e });
      }
    }
    return out;
  })) ?? [];
  await report(outcomes.filter((o) => !o.needsUpdate), plan.length > 1);
  const rejected = outcomes.filter((o) => o.needsUpdate);
  if (rejected.length) await handleRejected(rejected.map((o) => o.p), req, upTo, plan.length > 1);
}

async function report(outcomes: PushOutcome[], many: boolean): Promise<void> {
  const name = (o: PushOutcome) => (many ? `${o.p.repo.name}: ` : '');
  for (const o of outcomes.filter((x) => x.error)) void reportError(o.error, many ? `Push failed (${o.p.repo.name})` : 'Push failed');
  for (const o of outcomes.filter((x) => !x.error && x.rejected)) vscode.window.showErrorMessage(`Push rejected: ${name(o)}${o.text}`);
  const ok = outcomes.filter((x) => !x.error && !x.rejected && x.text);
  if (ok.length) {
    const lines = ok.map((o) => (many ? `${o.p.repo.name}: ${o.text}` : o.text!));
    vscode.window.showInformationMessage(lines.join('; '));
  }
}

/** IntelliJ "Push Rejected" dialog: Merge / Rebase the remote changes, then push again. */
async function handleRejected(list: RepoPush[], req: PushRequest, upTo: string | undefined, manyRepos: boolean): Promise<void> {
  const one = list.length === 1;
  const message = !one
    ? 'Push of the current branch was rejected:'
    : manyRepos
      ? `Push of the current branch "${list[0].item.branch}" in repository "${list[0].repo.name}" was rejected.`
      : `Push of the current branch "${list[0].item.branch}" was rejected.`;
  const hasMerges = (await Promise.all(list.map((p) => p.repo.run(['rev-list', '--merges', '--count', `refs/remotes/${p.remote}/${p.target}..HEAD`], { quiet: true, allowFail: true })))).some((r) => +r.stdout.trim() > 0);
  const detail = (one ? '' : list.map((p) => `${p.item.branch} in ${p.repo.name}`).join('\n') + '\n\n') +
    (hasMerges ? 'Remote changes need to be merged before pushing.\n\nIn this case merge is highly recommended, because there are non-pushed merge commits. Rebasing them can lead to problems.' : 'Remote changes need to be merged before pushing.');
  const rebaseLabel = hasMerges ? 'Rebase Anyway' : 'Rebase';
  const pick = await vscode.window.showWarningMessage(message, { modal: true, detail }, 'Merge', rebaseLabel);
  if (!pick) {
    vscode.window.showWarningMessage('Push was rejected, and update was canceled');
    return;
  }
  const method = pick === 'Merge' ? 'merge' : 'rebase';
  const again: RepoPush[] = [];
  await withProgress('Updating…', async (token) => {
    for (const p of list) {
      const o = await updateRepo(p.repo, method, { remote: p.remote, branch: p.target }, token);
      if (o.kind === 'conflict') {
        void notifyConflicts(p.repo, 'Push was canceled, because there were conflicts during the update. Check that conflicts were resolved correctly, and invoke push again.');
      } else if (o.kind === 'error' || o.kind === 'skipped') {
        void reportError(new Error(o.kind === 'skipped' ? o.reason : o.message), 'Push was rejected, and update failed with an error');
      } else {
        again.push(p);
      }
    }
  });
  if (!again.length) return;
  const outcomes = (await withProgress('Pushing…', async (token) => {
    const out: PushOutcome[] = [];
    for (const p of again) {
      try {
        out.push(await pushOne(p, req, upTo, token));
      } catch (e) {
        out.push({ p, error: e });
      }
    }
    return out;
  })) ?? [];
  await report(outcomes, again.length > 1);
}
