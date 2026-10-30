// Host helpers of the compare feature: resolving explorer/editor command arguments to (repository, paths),
// the empty tree hash, ref listing for pickers and DiffFile construction for a changes list.
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { DiffFile } from '../../core/contracts';
import type { Repository, RepositoryManager } from '../../core/repository';
import { parseNameStatus } from '../../core/parse';
import type { FileChange } from '../../core/types';
import type { ChangesSource } from './protocol';
import { parseRevQuery } from './parse';

export const REV_SCHEME = 'gitprism-rev';

export interface Target {
  repo: Repository;
  /** repo-relative path ('' = repository root) */
  rel: string;
  uri: vscode.Uri;
  /** the uri the command was invoked on (a gitprism-rev uri for revision documents) */
  source: vscode.Uri;
  isDir: boolean;
  /** the revision shown when the target is a gitprism-rev document */
  rev?: string;
}

function uriOf(arg: unknown): vscode.Uri | undefined {
  if (arg instanceof vscode.Uri) return arg;
  const a = arg as { resourceUri?: vscode.Uri; uri?: vscode.Uri } | undefined;
  return a?.resourceUri ?? (a?.uri instanceof vscode.Uri ? a.uri : undefined);
}

/** Targets of a file-menu command (`(uri, uris)` from explorer/editor menus, else the active editor). */
export async function targets(repos: RepositoryManager, arg?: unknown, all?: unknown): Promise<Target[]> {
  await repos.ready();
  let uris: vscode.Uri[] = Array.isArray(all) ? all.map(uriOf).filter((u): u is vscode.Uri => !!u) : [];
  if (!uris.length) {
    const u = uriOf(arg) ?? vscode.window.activeTextEditor?.document.uri;
    if (u) uris = [u];
  }
  const res: Target[] = [];
  for (const uri of uris) {
    if (uri.scheme === REV_SCHEME) {
      const d = parseRevQuery(uri.query);
      const repo = d && repos.get(d.repoRoot);
      if (d && repo) res.push({ repo, rel: d.path, uri: vscode.Uri.file(repo.abs(d.path)), source: uri, isDir: false, rev: d.rev });
      continue;
    }
    if (uri.scheme !== 'file') continue;
    const repo = repos.forUri(uri) ?? (await repos.open(path.dirname(uri.fsPath)));
    if (!repo) continue;
    let isDir = false;
    try {
      isDir = fs.statSync(uri.fsPath).isDirectory();
    } catch {
      /* deleted file */
    }
    res.push({ repo, rel: repo.rel(uri.fsPath), uri, source: uri, isDir });
  }
  if (!res.length) vscode.window.showWarningMessage(uris.length ? 'The selected file is not under Git version control.' : 'No file selected.');
  return res;
}

export function baseName(rel: string, repo: Repository): string {
  return rel ? rel.slice(rel.lastIndexOf('/') + 1) : repo.name;
}

/** Global option making `-- paths` literal: folders like `app/[id]` or files with `*` must not act as globs. */
export const LITERAL = '--literal-pathspecs';

/**
 * Changed files between `from` and `to` (undefined = working tree), limited to literal `paths`.
 * Same output as Repository.changes(), but without pathspec magic.
 */
export async function diffNameStatus(repo: Repository, from: string, to: string | undefined, paths: readonly string[] = []): Promise<FileChange[]> {
  const args = [LITERAL, 'diff', '--name-status', '-z', '-M', '--no-ext-diff', '--no-textconv', from];
  if (to) args.push(to);
  args.push('--', ...paths);
  return parseNameStatus((await repo.run(args, { quiet: true })).stdout);
}

/** Resolves a commit-ish or tree-ish (e.g. the empty tree) to its hash; throws a readable error. */
export async function resolveTreeish(repo: Repository, rev: string): Promise<string> {
  if (!rev || rev.startsWith('-')) throw new Error(`Unknown revision '${rev}'.`);
  const r = await repo.run(['rev-parse', '--verify', '--quiet', `${rev}^{tree}`], { allowFail: true, quiet: true });
  if (r.code !== 0) throw new Error(`Unknown revision '${rev}'.`);
  return r.stdout.trim();
}

const emptyTrees = new Map<string, string>();

/** Hash of the empty tree in this repository's object format (sha1 or sha256). */
export async function emptyTree(repo: Repository): Promise<string> {
  let h = emptyTrees.get(repo.root);
  if (!h) {
    h = (await repo.run(['hash-object', '-t', 'tree', '--stdin'], { input: '', quiet: true })).stdout.trim();
    emptyTrees.set(repo.root, h);
  }
  return h;
}

/** Throws a readable error for an empty repository (no HEAD yet). */
export async function requireHead(repo: Repository): Promise<string> {
  const h = await repo.headHash();
  if (!h) throw new Error(`The repository ${repo.name} has no commits yet.`);
  return h;
}

/** Current branch name or the 8-char hash when detached. */
export async function currentLabel(repo: Repository): Promise<string> {
  const b = await repo.currentBranch();
  if (b) return b;
  const h = await repo.headHash();
  return h ? h.slice(0, 8) : 'HEAD';
}

/**
 * DiffFiles for a changes list. Sides: `from` (left) → `to` or the working tree (right); swapped puts the working
 * tree / `to` on the left. `changes` are already oriented (inverted when swapped).
 */
export function diffFiles(repo: Repository, src: ChangesSource, changes: readonly FileChange[]): DiffFile[] {
  const fromRef = (p: string) => ({ rev: src.from, path: p });
  const toRef = (p: string) => (src.to ? { rev: src.to, path: p } : { worktree: true as const, path: p });
  const left = src.swapped ? toRef : fromRef;
  const right = src.swapped ? fromRef : toRef;
  return changes.map((c) => ({
    repoRoot: repo.root,
    path: c.path,
    oldPath: c.oldPath,
    kind: c.kind,
    left: c.kind === 'A' || c.kind === '?' ? { empty: true } : left(c.oldPath ?? c.path),
    right: c.kind === 'D' ? { empty: true } : right(c.path),
  }));
}
