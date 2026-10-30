// Shared helpers of the commit operations: repository lookup, IntelliJ's pre-checks for history editing
// (repository state, commit in current branch, merge/root commits, pushed to protected branches), the
// byte-preserving runner for in-memory edits and conflict / stopped-operation notifications.
import * as vscode from 'vscode';
import type { FeatureContext } from '../../core/context';
import { invoke, type CommitsArgs } from '../../core/contracts';
import type { Repository } from '../../core/repository';
import type { Commit } from '../../core/types';
import { gitRaw } from '../../core/git';
import type { ObjectGit } from './inmemory';
import { isProtectedBranch, prohibitedStateMessage } from './todo';

export const short = (h: string) => h.slice(0, 8);

export async function repoOf(ctx: FeatureContext, args: CommitsArgs | undefined): Promise<Repository | undefined> {
  if (args?.repoRoot) {
    const r = ctx.repos.get(args.repoRoot) ?? (await ctx.repos.open(args.repoRoot));
    if (r) return r;
    vscode.window.showErrorMessage(`${args.repoRoot} is not a Git repository.`);
    return undefined;
  }
  return ctx.repos.pick();
}

/** Selected hashes (newest first) or a warning when nothing is selected. */
export function hashesOf(args: CommitsArgs | undefined): string[] | undefined {
  const hs = (args?.hashes ?? []).filter(Boolean);
  if (!hs.length) {
    vscode.window.showWarningMessage('No commits selected.');
    return undefined;
  }
  return hs;
}

export class OpError extends Error {}

/** Throws OpError when an operation is in progress ("Cannot reword during rebase"). */
export function checkState(repo: Repository, op: string): void {
  const msg = prohibitedStateMessage(repo.operationState(), op);
  if (msg) throw new OpError(msg);
}

export async function isAncestor(repo: Repository, a: string, b: string): Promise<boolean> {
  return (await repo.run(['merge-base', '--is-ancestor', a, b], { allowFail: true, quiet: true })).code === 0;
}

/** Throws when a commit is not reachable from HEAD (IntelliJ: "The commit is not in the current branch"). */
export async function checkInHead(repo: Repository, hashes: string[]): Promise<string> {
  const head = await repo.headHash();
  if (!head) throw new OpError('The repository has no commits yet');
  for (const h of hashes) {
    if (!(await isAncestor(repo, h, head))) {
      throw new OpError(hashes.length === 1 ? 'The commit is not in the current branch' : `Commit ${short(h)} is not in the current branch`);
    }
  }
  return head;
}

export async function loadCommits(repo: Repository, hashes: string[]): Promise<Commit[]> {
  if (!hashes.length) return [];
  return repo.log(['--no-walk=unsorted', ...hashes]);
}

/** Full message (subject + body) of a commit. */
export async function fullMessage(repo: Repository, hash: string): Promise<string> {
  return (await repo.run(['show', '-s', '--format=%B', hash], { quiet: true })).stdout.replace(/\n+$/, '');
}

/** Commits oldest-first in `from..HEAD` including `from` (no merges); also reports merges in the range. */
export async function rangeToHead(repo: Repository, from: string): Promise<{ commits: Commit[]; merges: Commit[]; root: boolean }> {
  const parents = (await repo.run(['rev-list', '--parents', '-n', '1', from], { quiet: true })).stdout.trim().split(' ').slice(1);
  const root = parents.length === 0;
  const range = root ? ['HEAD'] : [`${from}^..HEAD`];
  const all = await repo.log(['--topo-order', '--reverse', ...range]);
  return { commits: all.filter((c) => c.parents.length <= 1), merges: all.filter((c) => c.parents.length > 1), root };
}

/** IntelliJ has one "Protected branches" setting (Settings | Git); here it is the Push setting gitPrism.push.protectedBranches. */
export function protectedPatterns(): string[] {
  const v = vscode.workspace.getConfiguration('gitPrism').get<string[] | string>('push.protectedBranches') ?? 'master, main';
  return (Array.isArray(v) ? v : v.split(/[;,]/)).map((s) => s.trim()).filter(Boolean);
}

/** Remote branches containing the commit (short names, e.g. origin/main). */
export async function remoteBranchesContaining(repo: Repository, hash: string): Promise<string[]> {
  const r = await repo.run(['for-each-ref', '--contains', hash, '--format=%(refname:short)%09%(symref)', 'refs/remotes'], { quiet: true, allowFail: true });
  return r.stdout
    .split('\n')
    .map((l) => l.split('\t'))
    .filter(([name, sym]) => name && !sym)
    .map(([name]) => name);
}

/** Splits origin/feature/x → feature/x using the known remote names. */
export function branchOfRemoteRef(ref: string, remotes: string[]): string {
  const r = remotes.filter((x) => ref.startsWith(x + '/')).sort((a, b) => b.length - a.length)[0];
  return r ? ref.slice(r.length + 1) : ref.slice(ref.indexOf('/') + 1);
}

/** The protected remote branch (e.g. origin/main) containing the commit, if any. */
export async function protectedBranchContaining(repo: Repository, hash: string): Promise<string | undefined> {
  const branches = await remoteBranchesContaining(repo, hash);
  if (!branches.length) return undefined;
  const remotes = (await repo.remotes()).map((r) => r.name);
  const patterns = protectedPatterns();
  return branches.find((b) => isProtectedBranch(branchOfRemoteRef(b, remotes), patterns));
}

/**
 * IntelliJ refuses to edit commits pushed to a protected branch ("The commit is already pushed to protected
 * branch 'origin/main'"). If any selected commit is pushed, the oldest one is too: checking it is enough.
 */
export async function checkNotProtected(repo: Repository, oldest: string): Promise<void> {
  const prot = await protectedBranchContaining(repo, oldest);
  if (prot) throw new OpError(`The commit is already pushed to protected branch '${prot}'`);
}

/** Warning shown in the message dialogs when the commit is already pushed (rewriting it requires a force push). */
export async function pushedWarning(repo: Repository, oldest: string): Promise<string | undefined> {
  const branches = await remoteBranchesContaining(repo, oldest);
  if (!branches.length) return undefined;
  const shown = branches.slice(0, 3).join(', ') + (branches.length > 3 ? ` and ${branches.length - 3} more` : '');
  return `The commit is already pushed to ${shown}. Changing it will require a force push.`;
}

/** "Editing Initial Commit": Continue / Cancel; returns false when cancelled. */
export async function confirmInitialCommit(): Promise<boolean> {
  const cont = 'Continue';
  return (
    (await vscode.window.showWarningMessage('Editing Initial Commit', { modal: true, detail: 'Are you sure you want to edit the initial commit?' }, cont)) === cont
  );
}

/** Byte-preserving runner for the in-memory operations (inmemory.ts). */
export function objectGit(repo: Repository): ObjectGit {
  return {
    run: async (args, input, env) =>
      (await gitRaw(repo.root, args, { quiet: true, env, input: input === undefined ? undefined : Buffer.from(input, 'latin1') })).stdout.toString('latin1'),
  };
}

/** Moves HEAD (the current branch, or HEAD itself when detached) from `oldHead` to `newHead` without touching files. */
export async function moveHead(repo: Repository, newHead: string, oldHead: string, reason: string): Promise<void> {
  await repo.exec(['update-ref', '-m', reason, 'HEAD', newHead, oldHead]);
}

/** Shows an error of a pre-check (OpError) or a git failure. */
export async function reportError(e: unknown, title: string): Promise<void> {
  if (e instanceof OpError) {
    vscode.window.showErrorMessage(`${title}: ${e.message}`);
    return;
  }
  const msg = e instanceof Error ? e.message : String(e);
  const pick = await vscode.window.showErrorMessage(`${title}: ${msg}`, 'Show Console');
  if (pick) invoke('gitPrism.console.show', undefined);
}

export async function unmergedFiles(repo: Repository): Promise<string[]> {
  const r = await repo.run(['diff', '--name-only', '--diff-filter=U', '-z'], { quiet: true, allowFail: true });
  return r.stdout.split('\0').filter(Boolean);
}

/** After `git rebase` left a rebase in progress: conflicts, stop for editing or a failed exec. */
export async function notifyRebaseStopped(repo: Repository, output: string): Promise<void> {
  const conflicts = await unmergedFiles(repo);
  const abort = 'Abort';
  if (conflicts.length) {
    const resolve = 'Resolve…';
    const cont = 'Continue';
    invoke('gitPrism.conflicts.resolve', { repoRoot: repo.root });
    const pick = await vscode.window.showWarningMessage(
      `Rebase stopped due to conflicts: ${conflicts.length === 1 ? conflicts[0] : `${conflicts.length} files`} in ${repo.name}`,
      resolve,
      cont,
      abort,
    );
    if (pick === resolve) invoke('gitPrism.conflicts.resolve', { repoRoot: repo.root });
    else if (pick === cont) invoke('gitPrism.operation.continue', { repoRoot: repo.root });
    else if (pick === abort) invoke('gitPrism.operation.abort', { repoRoot: repo.root });
    return;
  }
  const cont = 'Continue';
  const failedExec = /execution failed|Could not execute/i.exec(output);
  const text = failedExec
    ? `Rebase failed: ${lastLine(output)}`
    : `Rebase stopped for editing in ${repo.name}. Once you are satisfied with your changes you may continue.`;
  const pick = await (failedExec ? vscode.window.showErrorMessage(text, cont, abort) : vscode.window.showInformationMessage(text, cont, abort));
  if (pick === cont) invoke('gitPrism.operation.continue', { repoRoot: repo.root });
  else if (pick === abort) invoke('gitPrism.operation.abort', { repoRoot: repo.root });
}

function lastLine(s: string): string {
  return s.trim().split('\n').filter((l) => l.trim() && !/^(hint|Rebasing)/.test(l)).slice(-1)[0] ?? '';
}

export function autostashConflict(output: string): boolean {
  return /Applying autostash resulted in conflicts/i.test(output);
}

export function warnAutostashConflict(repo: Repository): void {
  const view = 'View Stash…';
  vscode.window
    .showWarningMessage(`Local changes could not be restored in ${repo.name}: applying the autostash resulted in conflicts. Your changes are safe in the stash.`, view)
    .then((p) => p && invoke('gitPrism.stash.unstash', { repoRoot: repo.root }));
}

export function stashMessage(op: string): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `Uncommitted changes before ${op} at ${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Exact full messages (`%B`) of the commits listed by `git log <args>`. */
export async function messagesOf(repo: Repository, args: string[]): Promise<Map<string, string>> {
  const out = (await repo.run(['log', '--format=%H%x1f%B%x1e', ...args], { quiet: true })).stdout;
  const map = new Map<string, string>();
  for (const rec of out.split('\x1e')) {
    const i = rec.indexOf('\x1f');
    if (i < 0) continue;
    map.set(rec.slice(0, i).trim(), rec.slice(i + 1).replace(/\n+$/, ''));
  }
  return map;
}
