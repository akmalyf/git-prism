// Thin wrapper around the git CLI. Every feature talks to git through Git.run()/Git.buffer()
// so commands land in the Git Console and errors surface as GitError.
import { spawn } from 'node:child_process';
import * as vscode from 'vscode';
import { logCommand } from './console';

export interface RunOptions {
  /** written to stdin */
  input?: string | Buffer;
  env?: Record<string, string>;
  /** resolve instead of throwing on a non-zero exit code */
  allowFail?: boolean;
  /** don't log this command in the Git Console (high-frequency polling, e.g. status) */
  quiet?: boolean;
  token?: vscode.CancellationToken;
}

export interface GitResult {
  stdout: string;
  stderr: string;
  code: number;
}

export class GitError extends Error {
  constructor(
    readonly args: string[],
    readonly code: number,
    readonly stderr: string,
    readonly stdout: string,
  ) {
    super(stderr.trim() || stdout.trim() || `git ${args[0]} failed with exit code ${code}`);
    this.name = 'GitError';
  }
}

export function gitPath(): string {
  return vscode.workspace.getConfiguration('gitPrism').get<string>('gitPath') || 'git';
}

/** Runs git in `cwd`; returns raw stdout bytes. */
export function gitRaw(cwd: string, args: string[], opts: RunOptions = {}): Promise<{ stdout: Buffer; stderr: string; code: number }> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const child = spawn(gitPath(), args, {
      cwd,
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: '0',
        GIT_OPTIONAL_LOCKS: '0',
        LC_ALL: 'C.UTF-8',
        GIT_EDITOR: 'true',
        GIT_SEQUENCE_EDITOR: 'true',
        ...opts.env,
      },
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on('data', (d: Buffer) => out.push(d));
    child.stderr.on('data', (d: Buffer) => err.push(d));
    const sub = opts.token?.onCancellationRequested(() => child.kill());
    child.on('error', (e) => {
      sub?.dispose();
      reject(e);
    });
    child.on('close', (code) => {
      sub?.dispose();
      const stderr = Buffer.concat(err).toString('utf8');
      const stdout = Buffer.concat(out);
      const exit = code ?? -1;
      if (!opts.quiet || exit !== 0) logCommand(cwd, args, Date.now() - started, exit, stderr);
      if (exit !== 0 && !opts.allowFail) reject(new GitError(args, exit, stderr, stdout.toString('utf8')));
      else resolve({ stdout, stderr, code: exit });
    });
    if (opts.input !== undefined) child.stdin.end(opts.input);
    else child.stdin.end();
  });
}

export async function git(cwd: string, args: string[], opts: RunOptions = {}): Promise<GitResult> {
  const r = await gitRaw(cwd, args, opts);
  return { stdout: r.stdout.toString('utf8'), stderr: r.stderr, code: r.code };
}

/** Shows a GitError (or any error) as a notification with a "Show Console" button. */
export async function showGitError(e: unknown, prefix?: string): Promise<void> {
  const msg = e instanceof Error ? e.message : String(e);
  const pick = await vscode.window.showErrorMessage(prefix ? `${prefix}: ${msg}` : msg, 'Show Console');
  if (pick) vscode.commands.executeCommand('gitPrism.console.show');
}
