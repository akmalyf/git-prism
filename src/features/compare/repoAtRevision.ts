// 'jbGit.repoAtRevision' (Show Repository at Revision): a webview tab with the file tree of a commit (one
// `git ls-tree -r` listing, folders expanded lazily in the page), files opened read-only via 'jbGit.openFileAtRevision'.
import * as vscode from 'vscode';
import { invoke, type CommitsArgs } from '../../core/contracts';
import type { FeatureContext } from '../../core/context';
import { showGitError } from '../../core/git';
import { RpcBridge, webviewHtml, webviewOptions } from '../../core/webview';
import { historyTitle, showHistory } from './changesRpc';
import { parseLsTree } from './parse';
import type { RepoAtRevisionInit, RepoEntryView } from './protocol';

const panels = new Map<string, vscode.WebviewPanel>();

export async function showRepoAtRevision(ctx: FeatureContext, args: CommitsArgs): Promise<void> {
  try {
    await ctx.repos.ready();
    const repo = args.repoRoot ? (ctx.repos.get(args.repoRoot) ?? (await ctx.repos.open(args.repoRoot))) : await ctx.repos.pick();
    if (!repo) return;
    const rev = args.hashes?.[0] ?? (await vscode.window.showInputBox({ title: 'Show Repository at Revision', prompt: 'Revision (hash, branch or tag)', value: 'HEAD' }))?.trim();
    if (!rev) return;
    const hash = await repo.revParse(rev).catch(() => {
      throw new Error(`Unknown revision '${rev}'.`);
    });
    const key = `${repo.root}\n${hash}`;
    const existing = panels.get(key);
    if (existing) {
      existing.reveal();
      return;
    }
    const c = await repo.commit(hash);
    const short = hash.slice(0, 8);
    const title = ctx.repos.all.length > 1 ? `${repo.name} at ${short}` : `Repository at ${short}`;
    const panel = vscode.window.createWebviewPanel('jbGit.repoAtRevision', title, vscode.ViewColumn.Active, webviewOptions(ctx.extension.extensionUri));
    panel.iconPath = new vscode.ThemeIcon('repo');
    const init: RepoAtRevisionInit = { repoRoot: repo.root, rev: hash, short, subject: c.subject, author: c.author, date: c.authorDate };
    panel.webview.html = webviewHtml(panel.webview, ctx.extension.extensionUri, 'repo-at-revision', init, title);
    const bridge = new RpcBridge(panel.webview, {
      // every file of the revision; the page builds folders from the paths
      list: async (): Promise<RepoEntryView[]> => {
        const out = await repo.run(['ls-tree', '-r', '-z', '--full-tree', hash], { quiet: true });
        return parseLsTree(out.stdout)
          .filter((e) => e.type !== 'tree')
          .map((e) => ({ type: e.type, path: e.path, name: e.name }));
      },
      open: async (p: { paths: string[] }) => {
        for (const path of p.paths) await invoke('jbGit.openFileAtRevision', { repoRoot: repo.root, path, rev: hash });
      },
      compareWithLocal: (p: { path: string }) => invoke('jbGit.compare.fileWithRevision', { repoRoot: repo.root, path: p.path, rev: hash }),
      history: (p: { path: string }) => showHistory(repo, p.path ? [p.path] : [], p.path ? historyTitle(p.path) : `History: ${repo.name}`),
      showInLog: () => invoke('jbGit.log.show', { repoRoot: repo.root, revision: hash }),
      copy: (p: { text: string }) => vscode.env.clipboard.writeText(p.text),
    });
    panels.set(key, panel);
    panel.onDidDispose(() => {
      panels.delete(key);
      bridge.dispose();
    });
  } catch (e) {
    showGitError(e, 'Cannot show repository at revision');
  }
}
