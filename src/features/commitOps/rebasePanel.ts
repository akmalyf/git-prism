// "Interactively Rebase from Here…": the "Rebasing Commits" dialog (webview bundle `rebase`) for the commits from
// the selected one up to HEAD, then the scripted `git rebase -i` with the edited plan.
import * as vscode from 'vscode';
import type { FeatureContext } from '../../core/context';
import { invoke, type CommitsArgs } from '../../core/contracts';
import type { Repository } from '../../core/repository';
import { RpcBridge, webviewHtml, webviewOptions } from '../../core/webview';
import { checkInHead, checkNotProtected, checkState, confirmInitialCommit, hashesOf, loadCommits, messagesOf, OpError, rangeToHead, repoOf, reportError } from './common';
import type { RebaseDetails, RebaseInit, RebaseRow, RebaseStartEntry } from './protocol';
import { runRebase } from './rewrite';
import { isNoop, isRebaseAction, subjectOf, validatePlan, type RebaseEntry } from './todo';

const open = new Map<string, vscode.WebviewPanel>();

export async function interactiveRebase(ctx: FeatureContext, args: CommitsArgs): Promise<void> {
  const repo = await repoOf(ctx, args);
  const hashes = hashesOf(args);
  if (!repo || !hashes) return;
  const title = 'Cannot Start Rebase';
  try {
    const existing = open.get(repo.root);
    if (existing) {
      existing.reveal();
      return;
    }
    // a single-commit action in IntelliJ (GitInteractiveRebaseAction)
    if (hashes.length !== 1) throw new OpError('Select a single commit');
    const from = hashes[0];
    checkState(repo, 'rebase');
    const head = await checkInHead(repo, [from]);
    const [commit] = await loadCommits(repo, [from]);
    if (commit.parents.length > 1) throw new OpError(`Selected commit has ${commit.parents.length} parents`);
    await checkNotProtected(repo, from);
    const range = await rangeToHead(repo, from);
    if (!range.commits.length) throw new OpError('There are no commits to rebase');
    if (range.root && !(await confirmInitialCommit())) return;
    const msgs = await messagesOf(repo, ['--no-walk=unsorted', ...range.commits.map((c) => c.hash)]);
    const rows: RebaseRow[] = range.commits.map((c) => ({
      hash: c.hash,
      subject: c.subject,
      message: msgs.get(c.hash) ?? c.subject,
      author: c.author,
      authorEmail: c.authorEmail,
      authorDate: c.authorDate,
      committer: c.committer,
      commitDate: c.commitDate,
    }));
    const notice = range.merges.length
      ? `${range.merges.length === 1 ? '1 merge commit' : `${range.merges.length} merge commits`} in the range will not be preserved: the history is linearized`
      : undefined;
    showPanel(ctx, repo, { repoName: repo.name, branch: await repo.currentBranch(), rows, notice, locale: vscode.env.language }, head, range.root);
  } catch (e) {
    await reportError(e, title);
  }
}

function showPanel(ctx: FeatureContext, repo: Repository, init: RebaseInit, head: string, root: boolean): void {
  const ext = ctx.extension.extensionUri;
  const title = 'Rebasing Commits';
  const panel = vscode.window.createWebviewPanel('gitPrism.rebase', `${title}: ${repo.name}`, vscode.ViewColumn.Active, webviewOptions(ext));
  panel.iconPath = new vscode.ThemeIcon('git-pull-request-draft');
  open.set(repo.root, panel);
  const rows = new Map(init.rows.map((r) => [r.hash, r]));
  const bridge = new RpcBridge(panel.webview, {
    details: (hash: string) => details(repo, hash),
    showDiff: (p: { hash: string; path: string; oldPath?: string; kind?: string; paths: { path: string; oldPath?: string; kind?: string }[] }) => showDiff(repo, p),
    cancel: () => panel.dispose(),
    start: async (entries: RebaseStartEntry[]) => {
      const plan: RebaseEntry[] = entries.map((e) => {
        const row = rows.get(e.hash);
        if (!row || !isRebaseAction(e.action)) throw new Error(`Unknown commit ${e.hash}`);
        return { hash: e.hash, action: e.action, message: row.message, newMessage: e.newMessage };
      });
      const err = validatePlan(plan);
      if (err) throw new Error(err);
      if (plan.length !== rows.size) throw new Error('The commit list is incomplete');
      panel.dispose();
      if (isNoop(plan, init.rows.map((r) => r.hash))) return;
      await runRebase(repo, {
        root,
        oldest: init.rows[0].hash,
        entries: plan,
        expectedHead: head,
        progressTitle: 'Rebasing…',
        successTitle: `Rebase successful: Rebased${init.branch ? ` ${init.branch}` : ''}`,
        failureTitle: 'Rebase failed',
        undo: { progress: 'Undoing interactive rebase…', notAllowed: 'Cannot undo interactive rebase', failed: 'Undo interactive rebase failed' },
      });
    },
  });
  panel.webview.html = webviewHtml(panel.webview, ext, 'rebase', init, title);
  const sub = repo.onDidChange(async () => {
    if ((await repo.headHash()) !== head) bridge.emit('headChanged');
  });
  panel.onDidDispose(() => {
    open.delete(repo.root);
    sub.dispose();
    bridge.dispose();
  });
}

async function details(repo: Repository, hash: string): Promise<RebaseDetails> {
  const c = await repo.commit(hash);
  const message = (await repo.run(['show', '-s', '--format=%B', hash], { quiet: true })).stdout.replace(/\n+$/, '');
  const files = await repo.commitChanges(hash);
  return {
    hash: c.hash,
    message: message || subjectOf(c.subject),
    author: c.author,
    authorEmail: c.authorEmail,
    authorDate: c.authorDate,
    committer: c.committer,
    committerEmail: c.committerEmail,
    commitDate: c.commitDate,
    parents: c.parents,
    files,
  };
}

async function showDiff(repo: Repository, p: { hash: string; path: string; paths: { path: string; oldPath?: string; kind?: string }[] }): Promise<void> {
  const c = await repo.commit(p.hash);
  const parent = c.parents[0];
  const files = p.paths.map((f) => ({
    repoRoot: repo.root,
    path: f.path,
    oldPath: f.oldPath,
    kind: f.kind as never,
    left: !parent || f.kind === 'A' ? ({ empty: true } as const) : { rev: parent, path: f.oldPath ?? f.path },
    right: f.kind === 'D' ? ({ empty: true } as const) : { rev: c.hash, path: f.path },
    leftTitle: parent ? parent.slice(0, 8) : undefined,
    rightTitle: c.hash.slice(0, 8),
  }));
  await invoke('gitPrism.diff.show', { files, index: Math.max(0, p.paths.findIndex((f) => f.path === p.path)) });
}
