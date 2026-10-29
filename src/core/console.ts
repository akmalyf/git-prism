// Git "Console" tab: every git command we run, with its duration and (on failure) its stderr,
// like PhpStorm's Git tool window Console. Backed by a LogOutputChannel.
import * as vscode from 'vscode';

let channel: vscode.LogOutputChannel | undefined;

export function gitConsole(): vscode.LogOutputChannel {
  return (channel ??= vscode.window.createOutputChannel('Git Console', { log: true }));
}

export function logCommand(cwd: string, args: string[], ms: number, code: number, stderr: string): void {
  const line = `[${cwd.split(/[\\/]/).pop()}] git ${args.map(quote).join(' ')}  (${ms} ms)`;
  if (code === 0) gitConsole().info(line);
  else gitConsole().error(`${line} → exit ${code}\n${stderr.trim()}`);
}

const quote = (a: string): string => (/^[\w./:@=+,-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`);
