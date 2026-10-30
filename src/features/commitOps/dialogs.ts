// Small webview dialogs of the commit operations: commit message editor (Edit Commit Message, Squashed Commit
// Message) and the "Git Checkout Problem" smart-operation dialog. Each resolves when a button is pressed or the tab closes.
import * as vscode from 'vscode';
import type { FeatureContext } from '../../core/context';
import { invoke } from '../../core/contracts';
import { RpcBridge, webviewHtml, webviewOptions } from '../../core/webview';
import type { MessageDialogInit, SmartChoice, SmartDialogInit } from './protocol';

function openDialog<T>(
  ctx: FeatureContext,
  bundle: string,
  title: string,
  init: unknown,
  handlers: (done: (v: T | undefined) => void) => Record<string, (p: any) => unknown>,
): Promise<T | undefined> {
  return new Promise((resolve) => {
    const ext = ctx.extension.extensionUri;
    const panel = vscode.window.createWebviewPanel(`gitPrism.${bundle}`, title, vscode.ViewColumn.Active, webviewOptions(ext));
    panel.iconPath = new vscode.ThemeIcon('git-commit');
    let settled = false;
    const done = (v: T | undefined) => {
      if (settled) return;
      settled = true;
      resolve(v);
      panel.dispose();
    };
    const bridge = new RpcBridge(panel.webview, handlers(done));
    panel.webview.html = webviewHtml(panel.webview, ext, bundle, init, title);
    panel.onDidDispose(() => {
      bridge.dispose();
      if (!settled) {
        settled = true;
        resolve(undefined);
      }
    });
  });
}

/**
 * Multiline commit message editor; resolves with the new message or undefined when cancelled. `validate` runs on OK
 * (IntelliJ re-checks that the repository did not change); a returned text is shown in the dialog, which stays open.
 */
export function editMessage(ctx: FeatureContext, init: MessageDialogInit, validate?: () => Promise<string | undefined>): Promise<string | undefined> {
  return openDialog<string>(ctx, 'commitops-message', init.title, init, (done) => ({
    ok: async (message: string) => {
      const error = await validate?.();
      if (error) return { error };
      done(message);
      return {};
    },
    cancel: () => done(undefined),
  }));
}

/** "Git Checkout Problem": Smart Checkout / Force Checkout / Don't Checkout. */
export function smartOperationDialog(ctx: FeatureContext, repoRoot: string, init: SmartDialogInit): Promise<SmartChoice> {
  return openDialog<SmartChoice>(ctx, 'commitops-smart', init.title, init, (done) => ({
    choose: (c: SmartChoice) => done(c),
    showDiff: (p: { path: string; index: number }) =>
      invoke('gitPrism.diff.show', {
        files: init.files.map((f) => ({ repoRoot, path: f, left: { rev: 'HEAD', path: f }, right: { worktree: true, path: f } })),
        index: p.index,
        beside: true,
      }),
  })).then((c) => c ?? 'dont');
}
