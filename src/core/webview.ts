// Webview plumbing shared by every panel/view: HTML shell (CSP, codicons, bundle from dist/media)
// and a request/response + event bridge (see src/webview/shared/rpc.ts for the other side).
import * as crypto from 'node:crypto';
import * as vscode from 'vscode';
import { iconThemePayload, iconThemeRoots, onDidChangeIconTheme } from './iconTheme';

/** Messages webview → host */
export interface RpcRequest {
  kind: 'req';
  id: number;
  method: string;
  params?: unknown;
}
/** Messages host → webview */
export type RpcOut = { kind: 'res'; id: number; result?: unknown; error?: string } | { kind: 'event'; event: string; data?: unknown };

export type RpcHandlers = Record<string, (params: any) => unknown>;

/**
 * HTML for a webview whose script is dist/media/<bundle>.js (built from src/webview/<bundle>/main.ts).
 * `init` is exposed to the page as window.__INIT__.
 */
export function webviewHtml(webview: vscode.Webview, extensionUri: vscode.Uri, bundle: string, init: unknown = {}, title = ''): string {
  const media = vscode.Uri.joinPath(extensionUri, 'dist', 'media');
  const nonce = crypto.randomBytes(16).toString('base64');
  const codicons = webview.asWebviewUri(vscode.Uri.joinPath(media, 'codicon.css'));
  const script = webview.asWebviewUri(vscode.Uri.joinPath(media, `${bundle}.js`));
  const csp = [
    `default-src 'none'`,
    `font-src ${webview.cspSource}`,
    `style-src ${webview.cspSource} 'unsafe-inline'`,
    `img-src ${webview.cspSource} https: data:`,
    `script-src 'nonce-${nonce}'`,
  ].join('; ');
  const json = JSON.stringify(init).replace(/</g, '\\u003c');
  const icons = iconThemePayload(webview);
  const iconJson = JSON.stringify(icons ? { ...icons, css: undefined } : null).replace(/</g, '\\u003c');
  const iconCss = icons ? icons.css.replace(/</g, '\\3c ') : '';
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link href="${codicons}" rel="stylesheet" id="vscode-codicon-stylesheet">
<style id="jb-icon-theme">${iconCss}</style>
<title>${title.replace(/</g, '&lt;')}</title>
</head>
<body>
<div id="app"></div>
<script nonce="${nonce}">window.__INIT__ = ${json}; window.__ICONS__ = ${iconJson};</script>
<script nonce="${nonce}" src="${script}"></script>
</body>
</html>`;
}

/** Standard webview options: scripts on, resources restricted to dist/media (+ file icon theme images/fonts). */
export function webviewOptions(extensionUri: vscode.Uri): vscode.WebviewOptions & vscode.WebviewPanelOptions {
  return {
    enableScripts: true,
    localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'dist', 'media'), ...iconThemeRoots()],
    retainContextWhenHidden: true,
  };
}

/** Routes `rpc.call(method, params)` from the webview to `handlers[method]` and lets the host push events. */
export class RpcBridge implements vscode.Disposable {
  /** the bridge whose webview opened the last native context menu (see registerWebviewMenus) */
  static menuTarget: RpcBridge | undefined;
  private static readonly live = new Set<RpcBridge>();
  private readonly sub: vscode.Disposable;

  constructor(
    private readonly webview: vscode.Webview,
    private readonly handlers: RpcHandlers,
  ) {
    this.sub = webview.onDidReceiveMessage((m: RpcRequest) => this.handle(m));
    RpcBridge.live.add(this);
  }

  /** Sends the current file icon theme to every open webview. */
  static refreshIconTheme(): void {
    for (const b of RpcBridge.live) b.emit('__iconTheme', iconThemePayload(b.webview) ?? null);
  }

  private async handle(m: RpcRequest): Promise<void> {
    if (!m || m.kind !== 'req') return;
    if (m.method === '__menuOpened') {
      RpcBridge.menuTarget = this;
      this.webview.postMessage({ kind: 'res', id: m.id } satisfies RpcOut);
      return;
    }
    const fn = this.handlers[m.method];
    let out: RpcOut;
    try {
      if (!fn) throw new Error(`unknown method ${m.method}`);
      out = { kind: 'res', id: m.id, result: await fn(m.params) };
    } catch (e) {
      out = { kind: 'res', id: m.id, error: e instanceof Error ? e.message : String(e) };
    }
    this.webview.postMessage(out);
  }

  /** Pushes an event to the webview (`rpc.on(event, cb)` there). */
  emit(event: string, data?: unknown): void {
    this.webview.postMessage({ kind: 'event', event, data } satisfies RpcOut);
  }

  dispose(): void {
    if (RpcBridge.menuTarget === this) RpcBridge.menuTarget = undefined;
    RpcBridge.live.delete(this);
    this.sub.dispose();
  }
}

/**
 * Registers the jbGit.m.<bundle>.<section>.<key> commands generated from src/webview/<bundle>/menus.json: VS Code
 * runs them from a webview's native context menu and they hand the item key back to that webview.
 */
export function registerWebviewMenus(context: vscode.ExtensionContext): void {
  context.subscriptions.push(onDidChangeIconTheme(() => RpcBridge.refreshIconTheme()));
  const commands: { command: string }[] = context.extension.packageJSON.contributes?.commands ?? [];
  for (const { command } of commands) {
    if (!command.startsWith('jbGit.m.')) continue;
    const key = command.split('.').slice(4).join('.');
    context.subscriptions.push(vscode.commands.registerCommand(command, () => RpcBridge.menuTarget?.emit('__menuAction', key)));
  }
}
