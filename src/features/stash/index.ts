// Stash, Shelf and patches: the Stash / Shelf views of the Commit tool window, Stash Changes… / Unstash Changes…
// dialogs, Shelve / Unshelve, Create / Apply Patch, and the contract commands jbGit.stash.create, jbGit.stash.unstash,
// jbGit.shelf.shelve, jbGit.patch.create and jbGit.patch.apply.
import * as vscode from 'vscode';
import type { FeatureContext } from '../../core/context';
import type { Repository } from '../../core/repository';
import { PatchActions } from './patchOps';
import { ShelfActions, ShelfStore } from './shelf';
import { StashActions, StashModel } from './stash';
import { SHELF_VIEW, ShelfView, STASH_VIEW, StashView } from './views';

type PathArgs = { repoRoot?: string; paths?: string[] };

export function activate(ctx: FeatureContext): void {
  const sub = ctx.extension.subscriptions;
  const stashes = new StashModel(ctx);
  const store = new ShelfStore(ctx);
  const stash = new StashActions(ctx, stashes);
  const shelf = new ShelfActions(ctx, store);
  const patch = new PatchActions(ctx);
  const stashView = new StashView(ctx, stashes, stash);
  const shelfView = new ShelfView(ctx, store, shelf);
  const opts = { webviewOptions: { retainContextWhenHidden: true } };
  sub.push(stashes, store, stashView, shelfView, vscode.window.registerWebviewViewProvider(STASH_VIEW, stashView, opts), vscode.window.registerWebviewViewProvider(SHELF_VIEW, shelfView, opts));

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
  reg('jbGit.stash.create', async (a?: unknown, b?: unknown) => stash.create(await pathArgs(a, b)));
  reg('jbGit.stash.unstash', async (a?: unknown) => stash.unstashDialog(await pathArgs(a)));
  reg('jbGit.shelf.shelve', async (a?: unknown, b?: unknown) => shelf.shelve(await pathArgs(a, b)));
  reg('jbGit.patch.create', async (a?: unknown, b?: unknown) => patch.create(await pathArgs(a, b)));
  reg('jbGit.patch.apply', async (a?: unknown) => {
    const args = await pathArgs(a);
    const file = a instanceof vscode.Uri && /\.(patch|diff)$/i.test(a.fsPath) ? a.fsPath : undefined;
    return patch.apply({ repoRoot: args.repoRoot, file });
  });

  // extra commands of this feature
  reg('jbGit.stash.silently', () => stash.silently());
  reg('jbGit.stash.refresh', () => stashes.refresh());
  reg('jbGit.stash.togglePreview', () => stashView.togglePreview());
  reg('jbGit.stash.show', async () => {
    await stashes.refresh();
    if (!stashes.repos.some((r) => r.stashes.length)) {
      vscode.window.showInformationMessage('No stashes. Use Stash Changes… to save local changes to the stash.');
      return;
    }
    await vscode.commands.executeCommand(`${STASH_VIEW}.focus`);
  });
  reg('jbGit.shelf.shelveSilently', async (a?: unknown, b?: unknown) => shelf.shelveSilently(await pathArgs(a, b)));
  reg('jbGit.shelf.saveToShelf', async (a?: unknown, b?: unknown) => shelf.shelve(await pathArgs(a, b), true));
  reg('jbGit.shelf.unshelve', () => shelf.unshelve(undefined));
  reg('jbGit.shelf.unshelveSilently', () => shelf.unshelveSilently([]));
  reg('jbGit.shelf.importPatches', () => shelf.importPatches());
  reg('jbGit.shelf.toggleShowApplied', () => shelfView.toggleShowApplied());
  reg('jbGit.shelf.refresh', () => store.load());
  reg('jbGit.shelf.show', async () => {
    await store.load();
    if (!store.all.some((s) => !s.deleted)) {
      vscode.window.showInformationMessage('No shelved changes. Use Shelve Changes… to put local changes on the shelf.');
      return;
    }
    await vscode.commands.executeCommand(`${SHELF_VIEW}.focus`);
  });
  reg('jbGit.patch.copyToClipboard', async (a?: unknown, b?: unknown) => {
    const args = await pathArgs(a, b);
    return patch.copyToClipboard(args.repoRoot, args.paths ?? []);
  });
  reg('jbGit.patch.applyFromClipboard', async (a?: unknown) => patch.applyFromClipboard(await pathArgs(a)));
}
