// Stash and patches: Stash Changes… / Unstash Changes… dialogs, Create / Apply Patch, and the contract commands
// gitPrism.stash.create, gitPrism.stash.unstash, gitPrism.patch.create and gitPrism.patch.apply.
import * as vscode from 'vscode';
import type { FeatureContext } from '../../core/context';
import type { Repository } from '../../core/repository';
import { PatchActions } from './patchOps';
import { StashActions, StashModel } from './stash';

type PathArgs = { repoRoot?: string; paths?: string[] };

export function activate(ctx: FeatureContext): void {
  const sub = ctx.extension.subscriptions;
  const stashes = new StashModel(ctx);
  const stash = new StashActions(ctx, stashes);
  const patch = new PatchActions(ctx);
  sub.push(stashes);

  /**
   * Commands are called with contract args ({ repoRoot, paths }) or from explorer / editor menus with (uri, uris).
   * Menu invocations become { repoRoot, paths } of the first repository of the selection.
   */
  const pathArgs = async (a?: unknown, b?: unknown): Promise<PathArgs> => {
    const uris = Array.isArray(b) && b.length ? (b as vscode.Uri[]) : a instanceof vscode.Uri ? [a] : [];
    if (!uris.length) return (a && typeof a === 'object' ? a : {}) as PathArgs;
    await ctx.repos.ready();
    let repo: Repository | undefined;
    const paths: string[] = [];
    for (const u of uris.filter((x) => x.scheme === 'file')) {
      const r = ctx.repos.forUri(u);
      if (!r || (repo && r !== repo)) continue;
      repo = r;
      paths.push(r.rel(u.fsPath) || '.');
    }
    if (!repo) return {};
    return { repoRoot: repo.root, paths: paths.includes('.') ? [] : paths };
  };
  const reg = (id: string, fn: (...args: any[]) => unknown) => sub.push(vscode.commands.registerCommand(id, fn));

  // contract commands
  reg('gitPrism.stash.create', async (a?: unknown, b?: unknown) => stash.create(await pathArgs(a, b)));
  reg('gitPrism.stash.unstash', async (a?: unknown) => stash.unstashDialog(await pathArgs(a)));
  reg('gitPrism.patch.create', async (a?: unknown, b?: unknown) => patch.create(await pathArgs(a, b)));
  reg('gitPrism.patch.apply', async (a?: unknown) => {
    const args = await pathArgs(a);
    const file = a instanceof vscode.Uri && /\.(patch|diff)$/i.test(a.fsPath) ? a.fsPath : undefined;
    return patch.apply({ repoRoot: args.repoRoot, file });
  });

  // extra commands of this feature
  reg('gitPrism.stash.silently', () => stash.silently());
  reg('gitPrism.patch.copyToClipboard', async (a?: unknown, b?: unknown) => {
    const args = await pathArgs(a, b);
    return patch.copyToClipboard(args.repoRoot, args.paths ?? []);
  });
  reg('gitPrism.patch.applyFromClipboard', async (a?: unknown) => patch.applyFromClipboard(await pathArgs(a)));
}
