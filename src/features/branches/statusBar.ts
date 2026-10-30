// Status bar branch widget (like the New UI VCS widget): "$(git-branch) main ↑2 ↓1" for the repository of the
// active editor (repo name prefixed when there are several); detached HEAD shows the short hash. Click → Branches popup.
import * as vscode from 'vscode';
import type { Repository } from '../../core/repository';
import type { Ctx } from './common';
import { statusBarText, syncTooltip } from './logic';

export function registerStatusBar(ctx: Ctx): void {
  const item = vscode.window.createStatusBarItem('jbGit.branch', vscode.StatusBarAlignment.Left, 1000);
  item.name = 'Git Branch';
  ctx.extension.subscriptions.push(item);
  let seq = 0;
  let timer: NodeJS.Timeout | undefined;

  const activeRepo = (): Repository | undefined => {
    const uri = vscode.window.activeTextEditor?.document.uri;
    const byUri = uri?.scheme === 'file' ? ctx.repos.forUri(uri) : undefined;
    return byUri ?? ctx.repos.all[0];
  };

  const update = async () => {
    const mine = ++seq;
    const repo = activeRepo();
    if (!repo) {
      item.hide();
      return;
    }
    try {
      const [branch, head] = await Promise.all([repo.currentBranch(), repo.headHash()]);
      let ahead: number | undefined;
      let behind: number | undefined;
      let upstream: string | undefined;
      if (branch && head) {
        const up = await repo.run(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], { quiet: true, allowFail: true });
        if (up.code === 0) {
          upstream = up.stdout.trim();
          const r = await repo.run(['rev-list', '--left-right', '--count', 'HEAD...@{u}'], { quiet: true, allowFail: true });
          const m = /^(\d+)\s+(\d+)/.exec(r.stdout.trim());
          if (m) {
            ahead = +m[1];
            behind = +m[2];
          }
        }
      }
      if (mine !== seq) return;
      const multi = ctx.repos.all.length > 1;
      item.text = statusBarText({ repoName: repo.name, multiRepo: multi, branch, head, ahead, behind });
      const tip = new vscode.MarkdownString(undefined, true);
      tip.appendMarkdown(branch ? `Git Branch: **${branch}**` : head ? `Detached HEAD at **${head.slice(0, 8)}**` : 'Git Branch');
      if (multi) tip.appendMarkdown(`  \nRepository: ${repo.name}`);
      if (upstream) tip.appendMarkdown(`  \nTracked branch: ${upstream}`);
      const sync = syncTooltip(ahead, behind);
      if (sync) tip.appendMarkdown(`  \n${sync}`);
      if (!head) tip.appendMarkdown('  \nNo commits yet');
      item.tooltip = tip;
      item.command = { title: 'Branches…', command: 'jbGit.branches.show', arguments: [{ repoRoot: repo.root }] };
      item.accessibilityInformation = { label: `Git branch ${branch ?? head?.slice(0, 8) ?? ''}` };
      item.show();
    } catch {
      if (mine === seq) item.hide();
    }
  };
  const schedule = () => {
    clearTimeout(timer);
    timer = setTimeout(update, 150);
  };
  ctx.extension.subscriptions.push(
    ctx.repos.onDidChangeRepository(schedule),
    ctx.repos.onDidChangeRepositories(schedule),
    vscode.window.onDidChangeActiveTextEditor(schedule),
    { dispose: () => clearTimeout(timer) },
  );
  schedule();
}
