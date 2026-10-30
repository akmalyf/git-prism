// Reads a repository's in-progress operation details from its git dir (MERGE_HEAD/MERGE_MSG, rebase-merge/*,
// CHERRY_PICK_HEAD, REVERT_HEAD) and its unmerged index entries.
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Repository } from '../../core/repository';
import { headNameBranch, mergedRefName, parseUnmerged, pickBranchName, short, type CommitMeta, type RepoOpInfo, type UnmergedEntry } from './logic';

export function readGitFile(repo: Repository, rel: string): string | undefined {
  try {
    return fs.readFileSync(path.join(repo.gitDir, rel), 'utf8');
  } catch {
    return undefined;
  }
}

export function gitFileExists(repo: Repository, rel: string): boolean {
  return fs.existsSync(path.join(repo.gitDir, rel));
}

/** rebase-merge (interactive / merge backend) or rebase-apply (apply backend) dir name, if a rebase is running. */
export function rebaseDir(repo: Repository): string | undefined {
  if (gitFileExists(repo, 'rebase-merge')) return 'rebase-merge';
  if (gitFileExists(repo, 'rebase-apply/rebasing')) return 'rebase-apply';
  return undefined;
}

/** Unmerged index entries (`git ls-files -u`): cheap, reads the index only. */
export async function unmerged(repo: Repository): Promise<UnmergedEntry[]> {
  const r = await repo.run(['ls-files', '-u', '-z', '--full-name'], { quiet: true, allowFail: true });
  return r.code === 0 ? parseUnmerged(r.stdout) : [];
}

async function resolve(repo: Repository, rev: string): Promise<string | undefined> {
  const r = await repo.run(['rev-parse', '--verify', '--quiet', `${rev}^{commit}`], { quiet: true, allowFail: true });
  return r.code === 0 ? r.stdout.trim() : undefined;
}

async function commitMeta(repo: Repository, rev: string): Promise<CommitMeta | undefined> {
  const r = await repo.run(['log', '-1', '--no-show-signature', '--format=%H%x00%an%x00%B', rev, '--'], { quiet: true, allowFail: true });
  if (r.code !== 0 || !r.stdout) return undefined;
  const [hash, author, ...rest] = r.stdout.split('\0');
  return { hash, author, message: rest.join('\0').replace(/\s+$/, '') };
}

async function branchesAt(repo: Repository, hash: string, prefix: string): Promise<string[]> {
  const r = await repo.run(['for-each-ref', '--points-at', hash, '--format=%(refname:short)', prefix], { quiet: true, allowFail: true });
  return r.stdout
    .split('\n')
    .map((s) => s.trim())
    .filter((s) => s && !s.endsWith('/HEAD'));
}

async function branchNameFor(repo: Repository, hash: string, preferred?: string): Promise<string | undefined> {
  const local = await branchesAt(repo, hash, 'refs/heads');
  const remote = local.length ? [] : await branchesAt(repo, hash, 'refs/remotes');
  return pickBranchName(local, remote, preferred);
}

/** Current branch, or the short HEAD hash when detached; the rebased branch during a rebase. */
export async function currentName(repo: Repository): Promise<string | undefined> {
  const dir = rebaseDir(repo);
  if (dir) {
    const b = headNameBranch(readGitFile(repo, `${dir}/head-name`));
    if (b) return b;
  }
  const branch = await repo.currentBranch();
  if (branch) return branch;
  const head = await repo.headHash();
  return head ? short(head) : undefined;
}

/** Everything the Conflicts dialog and the widget show about the operation in progress. */
export async function readOpInfo(repo: Repository): Promise<RepoOpInfo> {
  const op = repo.operationState();
  const info: RepoOpInfo = { name: repo.name, op, current: await currentName(repo) };
  if (op === 'merge') {
    const mergeHead = await resolve(repo, 'MERGE_HEAD');
    if (mergeHead) info.mergeBranch = (await branchNameFor(repo, mergeHead, mergedRefName(readGitFile(repo, 'MERGE_MSG')))) ?? short(mergeHead);
  } else if (op === 'rebase') {
    const dir = rebaseDir(repo) ?? 'rebase-merge';
    info.rebasingBranch = headNameBranch(readGitFile(repo, `${dir}/head-name`));
    const onto = readGitFile(repo, `${dir}/onto`)?.trim();
    if (onto) {
      info.ontoHash = onto;
      info.ontoBranch = await branchNameFor(repo, onto);
    }
    if (gitFileExists(repo, 'REBASE_HEAD')) info.rebaseHead = await commitMeta(repo, 'REBASE_HEAD');
    info.editStop = dir === 'rebase-merge' && gitFileExists(repo, 'rebase-merge/amend');
  } else if (op === 'cherry-pick') {
    info.cherryPick = await commitMeta(repo, 'CHERRY_PICK_HEAD');
  } else if (op === 'revert') {
    info.revertHead = await commitMeta(repo, 'REVERT_HEAD');
  }
  return info;
}

/** Comment character for cleaning MERGE_MSG (core.commentChar, '#' by default; "auto" falls back to '#'). */
export async function commentChar(repo: Repository): Promise<string> {
  const c = await repo.config('core.commentChar');
  return c && c !== 'auto' ? c : '#';
}
