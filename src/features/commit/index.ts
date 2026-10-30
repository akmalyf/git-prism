// File-level commit actions of the Git editor menu: Add, Add to .gitignore, Rollback…. gitPrism.commit.focus (used by
// Fixup…/Squash Into… and "Commit merge") opens VS Code's Source Control view with the message prefilled.
import * as fs from 'node:fs';
import * as vscode from 'vscode';
import type { FeatureContext } from '../../core/context';
import { implement } from '../../core/contracts';
import { showGitError } from '../../core/git';
import type { Repository } from '../../core/repository';
import * as ops from './ops';
import type { Item } from './protocol';

interface GitApi {
  repositories: { rootUri: vscode.Uri; inputBox: { value: string } }[];
}

export function activate(ctx: FeatureContext): void {
  const sub = ctx.extension.subscriptions;
  const reg = (id: string, fn: (...args: any[]) => unknown) => sub.push(vscode.commands.registerCommand(id, fn));

  sub.push(
    implement('gitPrism.commit.focus', async ({ repoRoot, message }) => {
      if (message !== undefined) {
        const api = vscode.extensions.getExtension<{ getAPI(v: 1): GitApi }>('vscode.git')?.exports?.getAPI(1);
        const repo = api?.repositories.find((r) => !repoRoot || r.rootUri.fsPath === repoRoot) ?? api?.repositories[0];
        if (repo) repo.inputBox.value = message;
      }
      await vscode.commands.executeCommand('workbench.view.scm');
    }),
  );

  /** Explorer / editor selection → file uris (falls back to the active editor). */
  const targets = (uri?: vscode.Uri, uris?: vscode.Uri[]): vscode.Uri[] => {
    const list = uris?.length ? uris : uri instanceof vscode.Uri ? [uri] : [];
    if (list.length) return list.filter((u) => u.scheme === 'file');
    const active = vscode.window.activeTextEditor?.document.uri;
    return active?.scheme === 'file' ? [active] : [];
  };
  const byRepo = (uris: vscode.Uri[]) => {
    const map = new Map<Repository, string[]>();
    for (const u of uris) {
      const repo = ctx.repos.forUri(u);
      if (!repo) continue;
      const rel = repo.rel(u.fsPath) || '.';
      map.set(repo, [...(map.get(repo) ?? []), rel]);
    }
    return map;
  };

  reg('gitPrism.rollback', async (uri?: vscode.Uri, uris?: vscode.Uri[]) => {
    await ctx.repos.ready();
    for (const [repo, paths] of byRepo(targets(uri, uris))) {
      try {
        const status = await repo.status();
        const hasHead = !!status.branch.oid;
        const inside = (p: string) => paths.some((t) => t === '.' || p === t || p.startsWith(`${t}/`));
        const items: Item[] = status.entries
          .filter((e) => e.kind !== '?' && e.kind !== '!' && !e.conflict && (inside(e.path) || (e.oldPath !== undefined && inside(e.oldPath))))
          .map((e) => ({ key: e.path, repo: repo.root, path: e.path, oldPath: e.oldPath, kind: e.kind, area: 'changes' }));
        if (!items.length) {
          vscode.window.showInformationMessage('No changes to rollback.');
          continue;
        }
        const names = items.length === 1 ? items[0].path : `${items.length} files`;
        const hasAdded = items.some((i) => i.kind === 'A' || i.kind === 'C' || !hasHead);
        const buttons = hasAdded ? ['Rollback', 'Rollback and Delete Added Files'] : ['Rollback'];
        const pick = await vscode.window.showWarningMessage(`Rollback changes in ${names}?`, { modal: true, detail: 'Local changes will be lost.' }, ...buttons);
        if (!pick) return;
        await ops.rollback(repo, items, pick !== 'Rollback', hasHead);
      } catch (e) {
        showGitError(e, 'Rollback failed');
      }
    }
  });
  reg('gitPrism.add', async (uri?: vscode.Uri, uris?: vscode.Uri[]) => {
    await ctx.repos.ready();
    for (const [repo, paths] of byRepo(targets(uri, uris))) {
      try {
        await ops.execPaths(repo, ['add', '-A'], paths);
      } catch (e) {
        showGitError(e, 'Failed to add files');
      }
    }
  });
  reg('gitPrism.addToGitignore', async (uri?: vscode.Uri, uris?: vscode.Uri[]) => {
    await ctx.repos.ready();
    for (const [repo, paths] of byRepo(targets(uri, uris))) {
      const rels = paths.map((p) => {
        try {
          return fs.statSync(repo.abs(p)).isDirectory() && p !== '.' ? `${p}/` : p;
        } catch {
          return p;
        }
      }).filter((p) => p !== '.');
      if (!rels.length) continue;
      const list = ops.ignoreTargets(repo, rels);
      const pick = await vscode.window.showQuickPick(list.map((t) => ({ label: t.label, description: t.exists ? undefined : 'new file', t })), {
        placeHolder: `Add to .gitignore (${repo.name})`,
      });
      if (!pick) return;
      if (!pick.t.exists) {
        const ok = await vscode.window.showWarningMessage(`Create .gitignore file in ${pick.t.dir ? repo.abs(pick.t.dir) : repo.root}?`, { modal: true, detail: 'Create .gitignore' }, 'Create');
        if (ok !== 'Create') return;
      }
      try {
        await ops.addToIgnore(repo, pick.t, rels);
      } catch (e) {
        showGitError(e, 'Failed to update ignore file');
      }
    }
  });
}
