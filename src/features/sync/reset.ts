// Reset HEAD dialog ("Reset Head" / "Git Reset"): To Commit + Soft / Mixed / Hard / Keep (GitBundle git.reset.mode.*).
// A hard reset with local changes asks for confirmation first.
import * as vscode from 'vscode';
import type { FeatureContext } from '../../core/context';
import type { Repository } from '../../core/repository';
import { blockedBy, hasLocalChanges, openDialog, repoData, repoItems, repoOf, reportError, withProgress } from './common';
import type { CommitInfo, ResetInit, ResetRequest } from './protocol';

async function commitInfo(repo: Repository, rev: string): Promise<CommitInfo | null> {
  if (!rev.trim()) return null;
  const r = await repo.run(['log', '-1', '--format=%H%x1f%s%x1f%an%x1f%ct', `${rev.trim()}^{commit}`, '--'], { allowFail: true, quiet: true });
  if (r.code !== 0 || !r.stdout.trim()) return null;
  const [hash, subject, author, date] = r.stdout.trim().split('\x1f');
  return { hash, subject, author, date: +date };
}

export async function resetHead(ctx: FeatureContext, args: { repoRoot?: string; target?: string } | vscode.Uri | undefined): Promise<void> {
  const repo = await repoOf(ctx, args);
  if (!repo) return;
  const target = args instanceof vscode.Uri ? undefined : args?.target;
  try {
    const data = await repoData(repo);
    if (!data.head) {
      vscode.window.showErrorMessage(`Reset failed: repository ${repo.name} has no commits yet`);
      return;
    }
    const title = target ? 'Git Reset' : 'Reset Head';
    const get = (root: string) => ctx.repos.get(root) ?? repo;
    const init: ResetInit = { title, repos: repoItems(ctx), data, ref: target ?? 'HEAD', fromLog: !!target, hasChanges: await hasLocalChanges(repo), locale: vscode.env.language };
    const req = await openDialog<ResetRequest>(ctx, 'reset', 'reset', title, init, (done) => ({
      repoData: async (root: string) => ({ data: await repoData(get(root)), hasChanges: await hasLocalChanges(get(root)) }),
      validate: (p: { root: string; rev: string }) => commitInfo(get(p.root), p.rev),
      ok: async (r: ResetRequest) => {
        const rp = get(r.root);
        if (r.mode === 'hard' && (await hasLocalChanges(rp))) {
          const ok = await vscode.window.showWarningMessage(
            'Hard Reset',
            { modal: true, detail: 'Files will be reverted to the state of the selected commit.\nWarning: any local changes will be lost.' },
            'Hard Reset',
          );
          if (ok !== 'Hard Reset') return false;
        }
        done(r);
        return true;
      },
    }));
    if (!req) return;
    await runReset(get(req.root), req);
  } catch (e) {
    void reportError(e, 'Reset failed');
  }
}

async function runReset(repo: Repository, req: ResetRequest): Promise<void> {
  const blocked = repo.operationState() === 'rebase' ? blockedBy(repo, 'reset') : undefined;
  if (blocked) {
    vscode.window.showErrorMessage(`Reset failed. ${blocked}`);
    return;
  }
  await withProgress('Resetting HEAD…', async (token) => {
    try {
      await repo.exec(['reset', `--${req.mode}`, req.commit.trim(), '--'], { token });
      vscode.window.showInformationMessage('Reset successful');
    } catch (e) {
      void reportError(e, 'Reset failed');
    }
  });
}
