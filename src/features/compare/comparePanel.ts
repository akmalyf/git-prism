// 'jbGit.compare.withCurrent': IntelliJ's branch compare ("Comparing <current> with <ref>") with a Log tab (commits
// in one branch but not the other, swappable) and a Files tab (difference between <ref> and the working tree).
import * as vscode from 'vscode';
import { invoke, type RefArgs } from '../../core/contracts';
import type { FeatureContext } from '../../core/context';
import { showGitError } from '../../core/git';
import { LOG_FORMAT, parseLog } from '../../core/parse';
import type { Repository } from '../../core/repository';
import { RpcBridge, webviewHtml, webviewOptions } from '../../core/webview';
import { changesHandlers } from './changesRpc';
import { pickRef } from './pickers';
import type { CommitDetails, CompareInit, CompareLogData } from './protocol';
import { currentLabel, emptyTree, requireHead } from './util';

const panels = new Map<string, vscode.WebviewPanel>();
const MAX_COMMITS = 10000;

async function resolveRepo(ctx: FeatureContext, root?: string): Promise<Repository | undefined> {
  await ctx.repos.ready();
  return root ? (ctx.repos.get(root) ?? (await ctx.repos.open(root))) : ctx.repos.pick();
}

export async function compareWithCurrent(ctx: FeatureContext, args: RefArgs): Promise<void> {
  try {
    const repo = await resolveRepo(ctx, args.repoRoot);
    if (!repo) return;
    await requireHead(repo);
    const ref = args.ref ?? (await pickRef(repo, { title: 'Select Branch to Compare', excludeCurrent: true }));
    if (!ref) return;
    await repo.revParse(ref).catch(() => {
      throw new Error(`Unknown revision '${ref}'.`);
    });
    const current = await currentLabel(repo);
    const key = JSON.stringify([repo.root, ref]);
    const existing = panels.get(key);
    if (existing) {
      existing.reveal();
      return;
    }
    const titleFor = (cur: string) => (ctx.repos.all.length > 1 ? `Comparing ${cur} with ${ref} in root ${repo.name}` : `Comparing ${cur} with ${ref}`);
    const title = titleFor(current);
    const panel = vscode.window.createWebviewPanel('jbGit.compareBranches', title, vscode.ViewColumn.Active, webviewOptions(ctx.extension.extensionUri));
    panel.iconPath = new vscode.ThemeIcon('git-compare');
    const init: CompareInit = { repoRoot: repo.root, current, currentRev: 'HEAD', ref };
    panel.webview.html = webviewHtml(panel.webview, ctx.extension.extensionUri, 'compare-branches', init, title);
    const bridge = new RpcBridge(panel.webview, {
      ...changesHandlers(repo),
      'compare.log': async (): Promise<CompareLogData> => {
        const [head, base] = await Promise.all([
          repo.run(['log', LOG_FORMAT, '--no-show-signature', `--max-count=${MAX_COMMITS}`, `HEAD..${ref}`, '--'], { quiet: true }),
          repo.run(['log', LOG_FORMAT, '--no-show-signature', `--max-count=${MAX_COMMITS}`, `${ref}..HEAD`, '--'], { quiet: true }),
        ]);
        return { head: parseLog(head.stdout), base: parseLog(base.stdout) };
      },
      // the current side follows HEAD (checkout while the tab is open)
      'compare.current': async () => {
        const cur = await currentLabel(repo);
        panel.title = titleFor(cur);
        return cur;
      },
      'compare.commit': async (p: { hash: string }): Promise<CommitDetails> => {
        const [commit, contains] = await Promise.all([
          repo.commit(p.hash),
          repo.run(['for-each-ref', '--contains', p.hash, '--format=%(refname:short)%09%(symref)', 'refs/heads', 'refs/remotes'], { quiet: true, allowFail: true }),
        ]);
        // skip symbolic refs such as origin/HEAD
        const branches = contains.stdout.split('\n').filter((l) => l && l.endsWith('\t')).map((l) => l.slice(0, -1));
        return { commit, branches, parent: commit.parents[0] ?? (await emptyTree(repo)) };
      },
      'compare.showInLog': (p: { hash: string }) => invoke('jbGit.log.show', { repoRoot: repo.root, revision: p.hash }),
      'compare.copyHash': (p: { hash: string }) => vscode.env.clipboard.writeText(p.hash),
    });
    const sub = ctx.repos.onDidChangeRepository((r) => {
      if (r === repo) bridge.emit('refresh');
    });
    panels.set(key, panel);
    panel.onDidDispose(() => {
      panels.delete(key);
      bridge.dispose();
      sub.dispose();
    });
  } catch (e) {
    showGitError(e, 'Cannot compare branches');
  }
}

/** "Show Diff with Working Tree": changes between `ref` and the working tree. */
export async function compareWithWorkingTree(ctx: FeatureContext, args: RefArgs): Promise<void> {
  try {
    const repo = await resolveRepo(ctx, args.repoRoot);
    if (!repo) return;
    const ref = args.ref ?? (await pickRef(repo, { title: 'Select Branch to Compare' }));
    if (!ref) return;
    await invoke('jbGit.changes.show', { repoRoot: repo.root, from: ref });
  } catch (e) {
    showGitError(e, 'Cannot Show Changes');
  }
}
