// 'jbGit.changes.show': the Changes browser editor tab ("Changes Between <from> and <to | Current Working Tree>")
// listing the files changed between two revisions or a revision and the working tree.
import * as vscode from 'vscode';
import type { ChangesShowArgs } from '../../core/contracts';
import type { FeatureContext } from '../../core/context';
import { showGitError } from '../../core/git';
import { RpcBridge, webviewHtml, webviewOptions } from '../../core/webview';
import { changesHandlers } from './changesRpc';
import { shortRev } from './parse';
import type { ChangesInit } from './protocol';
import { resolveTreeish } from './util';

const panels = new Map<string, vscode.WebviewPanel>();

/** "Changes Between {0} and {1}" / "… and Current Working Tree" / "… in {2}" (GitBundle). */
export function changesTitle(from: string, to: string | undefined, paths: readonly string[] = []): string {
  const base = `Changes Between ${shortRev(from)} and ${to ? shortRev(to) : 'Current Working Tree'}`;
  return paths.length ? `${base} in ${paths.join(', ')}` : base;
}

export async function showChanges(ctx: FeatureContext, args: ChangesShowArgs): Promise<void> {
  try {
    await ctx.repos.ready();
    const repo = args.repoRoot ? (ctx.repos.get(args.repoRoot) ?? (await ctx.repos.open(args.repoRoot))) : await ctx.repos.pick();
    if (!repo) return;
    if (!args.from) throw new Error('No revision to compare with.');
    // tree-ish: the log passes the empty tree as `from` for root commits
    await resolveTreeish(repo, args.from);
    if (args.to) await resolveTreeish(repo, args.to);
    const paths = [...new Set((args.paths ?? []).map((p) => p.replace(/\/+$/, '')).filter((p) => p !== ''))];
    const key = JSON.stringify([repo.root, args.from, args.to ?? null, paths]);
    const existing = panels.get(key);
    if (existing) {
      existing.reveal();
      return;
    }
    const title = args.title ?? changesTitle(args.from, args.to, paths);
    const panel = vscode.window.createWebviewPanel('jbGit.changes', title, vscode.ViewColumn.Active, webviewOptions(ctx.extension.extensionUri));
    panel.iconPath = new vscode.ThemeIcon('diff-multiple');
    const init: ChangesInit = {
      repoRoot: repo.root,
      source: { from: args.from, to: args.to, paths },
      fromLabel: shortRev(args.from),
      toLabel: args.to ? shortRev(args.to) : undefined,
    };
    panel.webview.html = webviewHtml(panel.webview, ctx.extension.extensionUri, 'changes', init, title);
    const bridge = new RpcBridge(panel.webview, changesHandlers(repo, (s) => (s.swapped ? changesTitle(s.to ?? 'Local', s.from, paths) : changesTitle(s.from, s.to, paths))));
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
    showGitError(e, 'Cannot Show Changes');
  }
}
