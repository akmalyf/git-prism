import * as vscode from 'vscode';
import { gitConsole } from './core/console';
import type { Feature, FeatureContext } from './core/context';
import { RepositoryManager } from './core/repository';
import { registerWebviewMenus } from './core/webview';
import * as annotate from './features/annotate';
import * as branches from './features/branches';
import * as commit from './features/commit';
import * as commitOps from './features/commitOps';
import * as compare from './features/compare';
import * as conflicts from './features/conflicts';
import * as diff from './features/diff';
import * as log from './features/log';
import * as stash from './features/stash';
import * as sync from './features/sync';

const FEATURES: Record<string, Feature> = { diff, conflicts, commit, log, commitOps, compare, annotate, branches, sync, stash };

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const repos = new RepositoryManager();
  context.subscriptions.push(repos, gitConsole(), vscode.commands.registerCommand('gitPrism.console.show', () => vscode.commands.executeCommand('gitPrism.log.showConsoleTab')));
  registerWebviewMenus(context);
  const ctx: FeatureContext = { extension: context, repos };
  for (const [name, f] of Object.entries(FEATURES)) {
    try {
      await f.activate(ctx);
    } catch (e) {
      gitConsole().error(`feature ${name} failed to activate: ${e instanceof Error ? (e.stack ?? e.message) : e}`);
    }
  }
  vscode.commands.executeCommand('setContext', 'gitPrism.active', true);
  repos.discover();
}

export function deactivate(): void {}
