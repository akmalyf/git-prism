// Commit tool window feature: the "Commit" webview view (changelists / staging area, commit message, amend,
// Commit and Push…), jbGit.commit.focus, and the Git file menu actions Commit File…, Add, Add to .gitignore, Rollback….
import * as fs from 'node:fs';
import * as vscode from 'vscode';
import type { FeatureContext } from '../../core/context';
import { implement } from '../../core/contracts';
import { showGitError } from '../../core/git';
import type { Repository } from '../../core/repository';
import * as ops from './ops';
import { CommitView, VIEW_ID } from './view';

export function activate(ctx: FeatureContext): void {
  const view = new CommitView(ctx);
  const sub = ctx.extension.subscriptions;
  const reg = (id: string, fn: (...args: any[]) => unknown) => sub.push(vscode.commands.registerCommand(id, fn));

  sub.push(
    view,
    vscode.window.registerWebviewViewProvider(VIEW_ID, view, { webviewOptions: { retainContextWhenHidden: true } }),
    implement('jbGit.commit.focus', (args) => view.focus(args)),
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

  reg('jbGit.commit.commitAndPush', () => view.commitAndPush());
  // Git.Stage.Local.File.Menu (editor / explorer): staged version of the file
  reg('jbGit.commit.showStagedVersion', (uri?: vscode.Uri, uris?: vscode.Uri[]) => view.stageFileAction('showStaged', targets(uri, uris)));
  reg('jbGit.commit.compareWithStaged', (uri?: vscode.Uri, uris?: vscode.Uri[]) => view.stageFileAction('compareLocalStaged', targets(uri, uris)));
  reg('jbGit.commit.compareThreeVersions', (uri?: vscode.Uri, uris?: vscode.Uri[]) => view.stageFileAction('threeWay', targets(uri, uris)));
  reg('jbGit.commitFile', (uri?: vscode.Uri, uris?: vscode.Uri[]) => view.commitFiles(targets(uri, uris)));
  reg('jbGit.rollback', (uri?: vscode.Uri, uris?: vscode.Uri[]) => view.rollbackFiles(targets(uri, uris)));
  reg('jbGit.add', async (uri?: vscode.Uri, uris?: vscode.Uri[]) => {
    await ctx.repos.ready();
    for (const [repo, paths] of byRepo(targets(uri, uris))) {
      try {
        await ops.execPaths(repo, ['add', '-A'], paths);
      } catch (e) {
        showGitError(e, 'Failed to add files');
      }
    }
  });
  reg('jbGit.addToGitignore', async (uri?: vscode.Uri, uris?: vscode.Uri[]) => {
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

  // view title (⋮) toggles
  reg('jbGit.commit.view.stagingArea', () => view.setSetting('stagingArea', true));
  reg('jbGit.commit.view.changelists', () => view.setSetting('stagingArea', false));
  reg('jbGit.commit.view.showIgnored', () => view.setSetting('showIgnored', !view.settings.showIgnored));
  reg('jbGit.commit.view.doubleClickDiff', () => view.setSetting('doubleClick', 'diff'));
  reg('jbGit.commit.view.doubleClickSource', () => view.setSetting('doubleClick', 'source'));
  reg('jbGit.commit.view.previewDiff', () => view.setSetting('previewDiff', !view.settings.previewDiff));
  reg('jbGit.commit.view.commitAll', () => view.setSetting('commitAll', !view.settings.commitAll));
}
