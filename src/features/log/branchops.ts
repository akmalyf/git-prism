// Branch actions of the log's branches tree that have no contract command: Checkout and Rebase onto Current,
// Update (fast-forward a non-current branch from its tracked branch), Pull into Current Using Rebase/Merge, plus
// the extra log RPCs (file contents for the diff preview, cherry-picked commits for the highlighter).
import * as vscode from 'vscode';
import { invoke } from '../../core/contracts';
import { showGitError } from '../../core/git';
import type { Repository } from '../../core/repository';
import { EMPTY_TREE, type FileContentsRequest, type FileContentsResult } from './protocol';

const MAX_PREVIEW = 2 * 1024 * 1024;

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function progress<T>(title: string, fn: () => Promise<T>): Thenable<T> {
  return vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title }, fn);
}

/** After a failed rebase/merge: offers Resolve Conflicts when an operation is left in progress. */
async function reportFailure(repo: Repository, e: unknown, title: string): Promise<void> {
  const op = repo.operationState();
  if (op !== 'none') {
    const pick = await vscode.window.showWarningMessage(`${title}: conflicts need to be resolved.`, 'Resolve Conflicts…', 'Abort');
    if (pick === 'Resolve Conflicts…') await invoke('jbGit.conflicts.resolve', { repoRoot: repo.root });
    else if (pick === 'Abort') await invoke('jbGit.operation.abort', { repoRoot: repo.root });
    return;
  }
  await showGitError(e, title);
}

/** IntelliJ "Checkout and Rebase onto 'current'": `git rebase <current> <ref>` (checks out ref, then rebases). */
export async function checkoutAndRebase(repo: Repository, ref: string): Promise<void> {
  const current = await repo.currentBranch();
  if (!current) {
    vscode.window.showErrorMessage('Rebase is not possible in the detached HEAD state');
    return;
  }
  if (ref === current) {
    vscode.window.showErrorMessage(`Checkout and Rebase failed: Cannot overwrite current branch ${current}`);
    return;
  }
  // a remote branch is checked out as a new local tracking branch first (like IntelliJ)
  const remotes = (await repo.remotes()).map((r) => r.name);
  const slash = ref.indexOf('/');
  const remote = slash > 0 ? ref.slice(0, slash) : undefined;
  let branch = ref;
  try {
    if (remote && remotes.includes(remote)) {
      branch = ref.slice(slash + 1);
      const exists = await repo.run(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], { quiet: true, allowFail: true });
      if (exists.code !== 0) await repo.exec(['branch', '--track', branch, ref]);
      else branch = ref;
    }
    await progress(`Checking out ${ref} and rebasing onto ${current}…`, () => repo.exec(['rebase', current, branch]));
    vscode.window.setStatusBarMessage(`Checked out ${branch} and rebased onto ${current}`, 4000);
  } catch (e) {
    await reportFailure(repo, e, 'Checkout and Rebase failed');
  }
}

/** "Update" of a branch: the current one → Update Project; another → `git fetch <remote> <merge>:refs/heads/<b>`. */
export async function updateBranch(repo: Repository, branch: string): Promise<void> {
  if (branch === (await repo.currentBranch())) {
    await invoke('jbGit.updateProject', { repoRoot: repo.root });
    return;
  }
  const remote = await repo.config(`branch.${branch}.remote`);
  const merge = await repo.config(`branch.${branch}.merge`);
  if (!remote || !merge || remote === '.') {
    vscode.window.showWarningMessage(`Tracked branch is not configured for ${branch}`);
    return;
  }
  try {
    await progress('Updating branches…', () => repo.exec(['fetch', remote, `${merge}:refs/heads/${branch}`]));
    vscode.window.setStatusBarMessage(`Updated ${branch}`, 4000);
  } catch (e) {
    if (/non-fast-forward|rejected/.test(message(e))) {
      vscode.window.showErrorMessage(`Update failed: ${branch} has diverged from its tracked branch and can't be fast-forwarded. Checkout it and use Update Project.`);
    } else await showGitError(e, 'Update failed');
  }
}

/** Pull into Current Using Rebase / Merge from a remote branch (`origin/feature`). */
export async function pullInto(repo: Repository, remoteRef: string, rebase: boolean): Promise<void> {
  const current = await repo.currentBranch();
  const label = current ? `'${current}'` : 'HEAD';
  const remotes = (await repo.remotes()).map((r) => r.name).sort((a, b) => b.length - a.length);
  const remote = remotes.find((r) => remoteRef.startsWith(`${r}/`));
  if (!remote) {
    vscode.window.showErrorMessage(`${remoteRef} is not a remote branch`);
    return;
  }
  try {
    await progress(`Pull into ${label} Using ${rebase ? 'Rebase' : 'Merge'}…`, () =>
      repo.exec(['pull', rebase ? '--rebase' : '--no-rebase', '--autostash', remote, remoteRef.slice(remote.length + 1)]),
    );
  } catch (e) {
    await reportFailure(repo, e, 'Pull failed');
  }
}

function isBinary(b: Buffer): boolean {
  const n = Math.min(b.length, 8000);
  for (let i = 0; i < n; i++) if (b[i] === 0) return true;
  return false;
}

/** Both sides of a changed file for the embedded diff preview. */
export async function fileContents(repo: Repository, req: FileContentsRequest): Promise<FileContentsResult> {
  const left = req.kind === 'A' || req.from === EMPTY_TREE ? undefined : await repo.show(req.from, req.oldPath ?? req.path);
  const right = req.kind === 'D' ? undefined : await repo.show(req.to, req.path);
  const bufs = [left, right].filter((b): b is Buffer => !!b);
  if (bufs.some((b) => b.length > MAX_PREVIEW)) return { original: '', modified: '', tooLarge: true };
  if (bufs.some(isBinary)) return { original: '', modified: '', binary: true };
  return { original: left?.toString('utf8') ?? '', modified: right?.toString('utf8') ?? '' };
}

/** Commits of `branch` whose change already exists in HEAD (`git cherry HEAD <branch>`, lines starting with '-'). */
export async function cherryPicked(repo: Repository, branch: string): Promise<string[]> {
  const r = await repo.run(['cherry', 'HEAD', branch], { quiet: true, allowFail: true });
  if (r.code !== 0) return [];
  return r.stdout
    .split('\n')
    .filter((l) => l.startsWith('- '))
    .map((l) => l.slice(2).trim());
}
