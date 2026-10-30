// Webview panels used as modal-like dialogs (Stash, Unstash Changes, Shelve / Unshelve Changes, Create / Apply Patch):
// opens the bundle, routes its rpc calls and resolves when a button is pressed or the tab is closed.
import * as vscode from 'vscode';
import type { FeatureContext } from '../../core/context';
import { RpcBridge, webviewHtml, webviewOptions } from '../../core/webview';

export interface DialogHandle {
  bridge: RpcBridge;
  panel: vscode.WebviewPanel;
}

const open = new Map<string, vscode.WebviewPanel>();

/**
 * Opens `bundle` with `init` in an editor tab. `handlers(done, handle)` receives `done(value)` to close the dialog.
 * A dialog with the same `key` that is already open is revealed instead (resolves undefined).
 */
export function openDialog<T>(
  ctx: FeatureContext,
  opts: { key: string; bundle: string; title: string; icon: string; init: unknown },
  handlers: (done: (v: T | undefined) => void, handle: () => DialogHandle) => Record<string, (p: any) => unknown>,
  onOpen?: (handle: DialogHandle) => vscode.Disposable | void,
): Promise<T | undefined> {
  const existing = open.get(opts.key);
  if (existing) {
    existing.reveal();
    return Promise.resolve(undefined);
  }
  return new Promise((resolve) => {
    const ext = ctx.extension.extensionUri;
    const panel = vscode.window.createWebviewPanel(`gitPrism.${opts.bundle}`, opts.title, vscode.ViewColumn.Active, webviewOptions(ext));
    panel.iconPath = new vscode.ThemeIcon(opts.icon);
    open.set(opts.key, panel);
    let settled = false;
    let bridge: RpcBridge | undefined;
    const handle = (): DialogHandle => ({ bridge: bridge!, panel });
    const done = (v: T | undefined) => {
      if (settled) return;
      settled = true;
      resolve(v);
      panel.dispose();
    };
    bridge = new RpcBridge(panel.webview, { ...handlers(done, handle), cancel: () => done(undefined) });
    panel.webview.html = webviewHtml(panel.webview, ext, opts.bundle, opts.init, opts.title);
    const extra = onOpen?.(handle());
    panel.onDidDispose(() => {
      open.delete(opts.key);
      bridge?.dispose();
      extra?.dispose();
      if (!settled) {
        settled = true;
        resolve(undefined);
      }
    });
  });
}
