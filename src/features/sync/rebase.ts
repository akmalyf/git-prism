// Rebase dialog ("Rebase"): git rebase [--onto <new base>] <upstream>|--root [<branch>] with IntelliJ's options.
// --interactive is delegated to the Interactive Rebase dialog (gitPrism.commit.interactiveRebase) when the upstream is
// below HEAD; otherwise (a new base is needed) `git rebase -i` runs in a terminal with the user's editor.
import * as vscode from 'vscode';
import type { FeatureContext } from '../../core/context';
import { invoke, type RefArgs } from '../../core/contracts';
import { gitPath } from '../../core/git';
import type { Repository } from '../../core/repository';
import { autostashConflict, blockedBy, hasConflicts, notifyConflicts, openDialog, repoData, repoItems, repoOf, reportError, withProgress } from './common';
import { rebaseArgs } from './options';
import type { RebaseRequest, RefDialogInit } from './protocol';

export async function rebase(ctx: FeatureContext, args: RefArgs | vscode.Uri | undefined): Promise<void> {
  const repo = await repoOf(ctx, args);
  if (!repo) return;
  const ref = args instanceof vscode.Uri ? undefined : args?.ref;
  try {
    const data = await repoData(repo);
    const init: RefDialogInit = { title: 'Rebase', repos: repoItems(ctx), data, ref: ref ?? data.upstream, locale: vscode.env.language };
    const req = await openDialog<RebaseRequest>(ctx, 'rebase', 'rebase-dialog', init.title, init, (done) => ({
      repoData: (root: string) => repoData(ctx.repos.get(root) ?? repo),
      validate: (p: { root: string; rev: string }) => validRev(ctx.repos.get(p.root) ?? repo, p.rev),
      ok: (r: RebaseRequest) => done(r),
    }));
    if (!req) return;
    await runRebase(ctx.repos.get(req.root) ?? repo, req);
  } catch (e) {
    void reportError(e, 'Rebase failed');
  }
}

async function validRev(repo: Repository, rev: string): Promise<boolean> {
  if (!rev.trim()) return false;
  return (await repo.run(['rev-parse', '--verify', '--quiet', `${rev}^{commit}`], { allowFail: true, quiet: true })).code === 0;
}

async function runRebase(repo: Repository, req: RebaseRequest): Promise<void> {
  const blocked = blockedBy(repo, 'rebase');
  if (blocked) {
    vscode.window.showErrorMessage(`Rebase not allowed. ${blocked}`);
    return;
  }
  if (!(await repo.headHash())) {
    vscode.window.showErrorMessage(`Rebase not allowed. Repository ${repo.name} is empty.`);
    return;
  }
  if (req.options.includes('interactive')) return interactive(repo, req);
  const branch = req.options.includes('switch-branch') && req.branch ? req.branch : await repo.currentBranch();
  const base = req.options.includes('onto') ? req.onto : req.options.includes('root') ? undefined : req.upstream;
  await withProgress('Rebasing…', async (token) => {
    try {
      const r = await repo.exec(rebaseArgs(req), { token });
      const out = r.stdout + r.stderr;
      if (/is up to date/i.test(out)) vscode.window.showInformationMessage(`${branch ?? 'HEAD'} is up to date${base ? ` with ${base}` : ''}`);
      else vscode.window.showInformationMessage(`Rebased${branch ? ` ${branch}` : ''}${base ? ` on ${base}` : ''}`);
      if (autostashConflict(out)) void notifyConflicts(repo, 'Local changes were restored with conflicts');
    } catch (e) {
      const msg = e instanceof Error ? e.message : '';
      if ((await hasConflicts(repo)) || /CONFLICT/.test(msg)) {
        void notifyConflicts(repo, 'Rebase stopped due to conflicts');
        return;
      }
      if (repo.operationState() === 'rebase') {
        void notifyConflicts(repo, 'Rebase stopped for editing');
        return;
      }
      void reportError(e, 'Rebase failed');
    }
  });
}

/** --interactive: commitOps' Interactive Rebase dialog when no base change is needed, else `git rebase -i` in a terminal. */
async function interactive(repo: Repository, req: RebaseRequest): Promise<void> {
  const inPlace = !req.options.includes('onto') && !req.options.includes('switch-branch');
  if (inPlace) {
    let oldest: string | undefined;
    if (req.options.includes('root')) {
      oldest = (await repo.run(['rev-list', '--max-parents=0', '--reverse', 'HEAD'], { quiet: true })).stdout.split('\n')[0]?.trim();
    } else if (req.upstream) {
      const up = await repo.revParse(req.upstream);
      const below = (await repo.run(['merge-base', '--is-ancestor', up, 'HEAD'], { allowFail: true, quiet: true })).code === 0;
      if (below) {
        const list = (await repo.run(['rev-list', '--reverse', '--first-parent', `${up}..HEAD`], { quiet: true })).stdout.split('\n').filter(Boolean);
        if (!list.length) {
          vscode.window.showInformationMessage('There are no commits to rebase');
          return;
        }
        oldest = list[0];
      }
    }
    if (oldest) {
      await invoke('gitPrism.commit.interactiveRebase', { repoRoot: repo.root, hashes: [oldest] });
      return;
    }
  }
  const args = ['rebase', '-i', '--autostash', ...rebaseArgs({ ...req, options: req.options.filter((o) => o !== 'interactive') }).slice(2)];
  const term = vscode.window.createTerminal({ name: 'Git Rebase', cwd: repo.root });
  term.show();
  term.sendText([gitPath(), ...args].map(shellQuote).join(' '));
}

function shellQuote(s: string): string {
  return /^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}
