// Git Console at the bottom of the Log view: streams every git command logged to the core "Git Console" channel
// (src/core/console.ts) with timestamps, highlighted command lines and red errors, like IntelliJ's VcsConsoleView.
// Core exposes no event source, so the channel's log methods are teed here.
import * as vscode from 'vscode';
import { gitConsole } from '../../core/console';
import type { FeatureContext } from '../../core/context';
import { ConsoleBuffer, consoleText, parseConsoleMessage, type ConsoleLevel, type ConsoleLine } from './consoleparse';

/** Collects console lines from the moment the feature activates. */
export class ConsoleFeed implements vscode.Disposable {
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

/** RPC handlers of the console pane (webview/log/console.ts). */
export function consoleHandlers(feed: ConsoleFeed) {
  return {
    'console.snapshot': () => feed.buffer.all,
    'console.clear': () => feed.clearAll(),
    'console.copy': (p: { lines: ConsoleLine[]; timestamps: boolean }) => vscode.env.clipboard.writeText(consoleText(p.lines, p.timestamps)),
    'console.copyText': (text: string) => vscode.env.clipboard.writeText(String(text)),
    'console.openOutput': () => gitConsole().show(true),
  };
}

/** Starts collecting console lines; the Log view shows them in its bottom pane. */
export function activateConsole(ctx: FeatureContext): ConsoleFeed {
  const feed = new ConsoleFeed();
  ctx.extension.subscriptions.push(feed, vscode.commands.registerCommand('jbGit.log.clearConsole', () => feed.clearAll()));
  return feed;
}
