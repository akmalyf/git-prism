// Webview plumbing shared by every panel/view: HTML shell (CSP, codicons, bundle from dist/media)
// and a request/response + event bridge (see src/webview/shared/rpc.ts for the other side).
import * as crypto from 'node:crypto';
import * as vscode from 'vscode';

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
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link href="${codicons}" rel="stylesheet" id="vscode-codicon-stylesheet">
<title>${title.replace(/</g, '&lt;')}</title>
</head>
<body>
<div id="app"></div>
<script nonce="${nonce}">window.__INIT__ = ${json};</script>
<script nonce="${nonce}" src="${script}"></script>
</body>
</html>`;
}

/** Standard webview options: scripts on, resources restricted to dist/media. */
export function webviewOptions(extensionUri: vscode.Uri): vscode.WebviewOptions & vscode.WebviewPanelOptions {
  return {
    enableScripts: true,
    localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'dist', 'media')],
    retainContextWhenHidden: true,
  };
}

/** Routes `rpc.call(method, params)` from the webview to `handlers[method]` and lets the host push events. */
export class RpcBridge implements vscode.Disposable {
  private readonly sub: vscode.Disposable;

  constructor(
    private readonly webview: vscode.Webview,
    private readonly handlers: RpcHandlers,
  ) {
    this.sub = webview.onDidReceiveMessage((m: RpcRequest) => this.handle(m));
  }

  private async handle(m: RpcRequest): Promise<void> {
    if (!m || m.kind !== 'req') return;
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
    this.sub.dispose();
  }
}
