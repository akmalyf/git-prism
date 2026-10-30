// Git panel "Console" tab (view jbGit.consoleView, bundle 'log-console'): streams every git command logged to the
// core "Git Console" channel (src/core/console.ts) with timestamps, highlighted command lines and red errors,
// like IntelliJ's VcsConsoleView. Core exposes no event source, so the channel's log methods are teed here.
import * as vscode from 'vscode';
import { gitConsole } from '../../core/console';
import type { FeatureContext } from '../../core/context';
import { RpcBridge, webviewHtml, webviewOptions } from '../../core/webview';
import { ConsoleBuffer, consoleText, parseConsoleMessage, type ConsoleLevel, type ConsoleLine } from './consoleparse';

export const CONSOLE_VIEW_ID = 'jbGit.consoleView';

/** Collects console lines from the moment the feature activates. */
class ConsoleFeed implements vscode.Disposable {
  readonly buffer = new ConsoleBuffer();
  private readonly emitter = new vscode.EventEmitter<{ added?: ConsoleLine[]; cleared?: boolean }>();
  readonly onDidChange = this.emitter.event;
  private restore: (() => void) | undefined;

  constructor() {
    const ch = gitConsole() as vscode.LogOutputChannel & Record<string, unknown>;
    const levels: ConsoleLevel[] = ['trace', 'debug', 'info', 'warn', 'error'];
    const originals: [string, unknown][] = [];
    try {
      for (const level of levels) {
        const orig = ch[level] as (msg: string | Error, ...args: unknown[]) => void;
        if (typeof orig !== 'function') continue;
        originals.push([level, orig]);
        ch[level] = (msg: string | Error, ...args: unknown[]) => {
          orig.call(ch, msg, ...args);
          this.add(level, msg instanceof Error ? (msg.stack ?? msg.message) : String(msg));
        };
      }
      for (const name of ['append', 'appendLine'] as const) {
        const orig = ch[name] as (v: string) => void;
        originals.push([name, orig]);
        ch[name] = (v: string) => {
          orig.call(ch, v);
          this.add('append', v);
        };
      }
      const clear = ch.clear as () => void;
      originals.push(['clear', clear]);
      ch.clear = () => {
        clear.call(ch);
        this.clearLines();
      };
      this.restore = () => {
        for (const [k, v] of originals) ch[k] = v;
      };
    } catch {
      // a frozen channel object: the tab stays empty but the output channel still works
      for (const [k, v] of originals) {
        try {
          ch[k] = v;
        } catch {
          /* ignore */
        }
      }
    }
  }

  private add(level: ConsoleLevel, message: string): void {
    const added = this.buffer.push(parseConsoleMessage(level, message), Date.now());
    if (added.length) this.emitter.fire({ added });
  }

  private clearLines(): void {
    this.buffer.clear();
    this.emitter.fire({ cleared: true });
  }

  /** Clear All: the tab and the output channel (which in turn clears the buffer). */
  clearAll(): void {
    gitConsole().clear();
    if (!this.restore) this.clearLines();
  }

  dispose(): void {
    this.restore?.();
    this.emitter.dispose();
  }
}

class ConsoleViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  private view: vscode.WebviewView | undefined;
  private readonly subs: vscode.Disposable[] = [];

  constructor(
    private readonly ctx: FeatureContext,
    readonly feed: ConsoleFeed,
  ) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    const ext = this.ctx.extension.extensionUri;
    this.view = view;
    view.webview.options = webviewOptions(ext);
    view.webview.html = webviewHtml(view.webview, ext, 'log-console', {}, 'Console');
    const bridge = new RpcBridge(view.webview, {
      snapshot: () => this.feed.buffer.all,
      clear: () => this.feed.clearAll(),
      copy: (p: { lines: ConsoleLine[]; timestamps: boolean }) => vscode.env.clipboard.writeText(consoleText(p.lines, p.timestamps)),
      copyText: (text: string) => vscode.env.clipboard.writeText(String(text)),
      openOutput: () => gitConsole().show(true),
    });
    const sub = this.feed.onDidChange((e) => {
      if (e.cleared) bridge.emit('clear');
      if (e.added) bridge.emit('append', e.added);
    });
    this.subs.push(bridge, sub);
    view.onDidDispose(() => {
      bridge.dispose();
      sub.dispose();
      if (this.view === view) this.view = undefined;
    });
  }

  async reveal(): Promise<void> {
    await vscode.commands.executeCommand(`${CONSOLE_VIEW_ID}.focus`);
  }

  dispose(): void {
    for (const s of this.subs.splice(0)) s.dispose();
  }
}

/** Registers the Console view and its commands; returns a function revealing the tab. */
export function activateConsole(ctx: FeatureContext): () => Promise<void> {
  const feed = new ConsoleFeed();
  const provider = new ConsoleViewProvider(ctx, feed);
  ctx.extension.subscriptions.push(
    feed,
    provider,
    vscode.window.registerWebviewViewProvider(CONSOLE_VIEW_ID, provider, { webviewOptions: { retainContextWhenHidden: true } }),
    vscode.commands.registerCommand('jbGit.log.showConsoleTab', () => provider.reveal()),
    vscode.commands.registerCommand('jbGit.log.clearConsole', () => feed.clearAll()),
  );
  return () => provider.reveal();
}
