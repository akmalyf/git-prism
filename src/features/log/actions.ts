// Git Log actions on commits and their changed files: changes of the selection (one commit, a merge with
// "Show Changes to Parents", or several commits combined like IntelliJ: oldest^..newest), diff windows,
// Get (restore files from a revision), Revert / Cherry-Pick Selected Changes.
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { invoke, type DiffFile } from '../../core/contracts';
import { gitRaw, showGitError } from '../../core/git';
import type { Repository } from '../../core/repository';
import type { FileChange } from '../../core/types';
import { LITERAL_PATHSPECS, type LogData } from './data';
import { EMPTY_TREE, type ChangeGroup, type ChangesRequest, type ChangesResult, type FilesAtRevision, type ShowDiffRequest } from './protocol';

const short = (h: string) => (h === EMPTY_TREE ? 'empty' : h.slice(0, 8));

/** Parents of a commit (real parents, not rewritten by a path filter). */
export async function realParents(data: LogData, repo: Repository, hash: string): Promise<string[]> {
  const row = data.row(repo.root, hash);
  if (row >= 0) {
    await data.ensureMeta(row, row + 1);
    const c = data.commitAt(row);
    if (c) return c.parents;
  }
  const r = await repo.run(['rev-list', '--parents', '--no-walk', hash], { quiet: true });
  return r.stdout.trim().split(' ').slice(1);
}

export async function computeChanges(data: LogData, req: ChangesRequest, toParents: boolean, affectedPaths?: Map<string, string[]>): Promise<ChangesResult> {
  const groups: ChangeGroup[] = [];
  const byRoot = new Map<string, string[]>();
  for (const c of req.commits) byRoot.set(c.root, [...(byRoot.get(c.root) ?? []), c.hash]);
  let merge = false;
  for (const [root, hashes] of byRoot) {
    const repo = data.roots.find((r) => r.repo.root === root)?.repo;
    if (!repo) continue;
    if (hashes.length === 1) {
      const hash = hashes[0];
      const parents = await realParents(data, repo, hash);
      if (parents.length <= 1) {
        const from = parents[0] ?? EMPTY_TREE;
        groups.push({ root, from, to: hash, files: await repo.changes(from, hash) });
      } else {
        if (req.commits.length === 1) merge = true;
        const perParent = await Promise.all(parents.map((p) => repo.changes(p, hash)));
        if (toParents) {
          parents.forEach((p, i) => groups.push({ root, from: p, to: hash, title: `Changes to ${short(p)}`, files: perParent[i] }));
        } else {
          // merged changes: files that differ from every parent
          const sets = perParent.slice(1).map((l) => new Set(l.map((f) => f.path)));
          groups.push({ root, from: parents[0], to: hash, files: perParent[0].filter((f) => sets.every((s) => s.has(f.path))) });
        }
      }
      continue;
    }
    // several commits: combined diff of oldest^..newest (table order: newest has the smallest row)
    const rows = hashes.map((h) => ({ h, row: data.row(root, h) }));
    const ordered = rows.every((r) => r.row >= 0) ? rows.sort((a, b) => a.row - b.row).map((r) => r.h) : await topoOrder(repo, hashes);
    const newest = ordered[0];
    const oldest = ordered[ordered.length - 1];
    const from = (await realParents(data, repo, oldest))[0] ?? EMPTY_TREE;
    groups.push({ root, from, to: newest, files: await repo.changes(from, newest) });
  }
  let affectedOnly = false;
  if (affectedPaths?.size) {
    affectedOnly = true;
    for (const g of groups) {
      const paths = affectedPaths.get(g.root);
      if (!paths?.length || paths.includes('.')) continue;
      const inside = (p: string | undefined) => !!p && paths.some((a) => p === a || p.startsWith(a + '/'));
      g.files = g.files.filter((f) => inside(f.path) || inside(f.oldPath));
    }
  }
  return { groups, merge, affectedOnly };
}

async function topoOrder(repo: Repository, hashes: string[]): Promise<string[]> {
  const r = await repo.run(['rev-list', '--topo-order', '--no-walk', ...hashes], { quiet: true });
  return r.stdout.split('\n').filter(Boolean);
}

/** Diff of one file of a change group; all files of the group are passed for next/previous file navigation. */
export async function showDiff(req: ShowDiffRequest): Promise<void> {
  const { group } = req;
  const mode = req.mode ?? 'commit';
  const side = (kind: FileChange['kind'], rev: string, path: string, isLeft: boolean) => {
    if (rev === EMPTY_TREE) return { empty: true as const };
    if (isLeft && kind === 'A') return { empty: true as const };
    if (!isLeft && kind === 'D') return { empty: true as const };
    return { rev, path };
  };
  const files: DiffFile[] = group.files.map((f) => {
    if (mode === 'local') {
      return {
        repoRoot: group.root,
        path: f.path,
        kind: f.kind,
        left: f.kind === 'D' ? { empty: true } : { rev: group.to, path: f.path },
        right: { worktree: true, path: f.path },
        leftTitle: short(group.to),
        rightTitle: 'Local Changes',
      };
    }
    if (mode === 'beforeLocal') {
      const before = f.oldPath ?? f.path;
      return {
        repoRoot: group.root,
        path: f.path,
        oldPath: f.oldPath,
        kind: f.kind,
        left: side(f.kind, group.from, before, true),
        right: { worktree: true, path: f.path },
        leftTitle: short(group.from),
        rightTitle: 'Local Changes',
      };
    }
    return {
      repoRoot: group.root,
      path: f.path,
      oldPath: f.oldPath,
      kind: f.kind,
      left: side(f.kind, group.from, f.oldPath ?? f.path, true),
      right: side(f.kind, group.to, f.path, false),
      leftTitle: short(group.from),
      rightTitle: short(group.to),
    };
  });
  const index = Math.max(0, group.files.findIndex((f) => f.path === req.path));
  await invoke('gitPrism.diff.show', { files, index, beside: req.beside });
}

/** "Get": replaces the working tree files with their version from the revision (files absent there are deleted). */
export async function getFromRevision(repo: Repository, req: FilesAtRevision): Promise<void> {
  if (!req.paths.length) return;
  const what = req.paths.length === 1 ? `'${req.paths[0]}'` : `${req.paths.length} files`;
  const ok = await vscode.window.showWarningMessage(
    `Get ${what} from revision ${short(req.rev)}?`,
    { modal: true, detail: 'Local changes in these files will be replaced with their content in that revision.' },
    'Get',
  );
  if (ok !== 'Get') return;
  try {
    const tree = await repo.run(['ls-tree', '-r', '--name-only', '-z', req.rev, '--', ...req.paths], { quiet: true, env: LITERAL_PATHSPECS });
    const present = new Set(tree.stdout.split('\0').filter(Boolean));
    const restore = req.paths.filter((p) => present.has(p));
    const remove = req.paths.filter((p) => !present.has(p));
    if (restore.length) await repo.exec(['restore', `--source=${req.rev}`, '--worktree', '--', ...restore], { env: LITERAL_PATHSPECS });
    for (const p of remove) {
      try {
        await vscode.workspace.fs.delete(vscode.Uri.file(repo.abs(p)), { useTrash: true });
      } catch {
        /* already absent */
      }
    }
    repo.fireChanged();
  } catch (e) {
    showGitError(e, 'Get Version failed');
  }
}

/**
 * Revert Selected Changes (reverse-apply) / Cherry-Pick Selected Changes (apply) of files of a commit to the
 * working tree. When the patch doesn't apply cleanly, every file is merged with `git merge-file` (local changes
 * kept, conflict markers where both sides changed the same lines), like IntelliJ's patch merge.
 */
export async function applySelectedChanges(repo: Repository, req: FilesAtRevision, revert: boolean): Promise<void> {
  const from = req.from ?? `${req.rev}^`;
  // explicit prefixes: `git apply` needs a/ b/ even with diff.noprefix / diff.mnemonicPrefix in the user's config
  const patch = await repo.buffer(
    ['diff', '--binary', '--no-ext-diff', '--no-color', '--no-renames', '--no-textconv', '--src-prefix=a/', '--dst-prefix=b/', from, req.rev, '--', ...req.paths],
    { quiet: true, env: LITERAL_PATHSPECS },
  );
  if (!patch.length) {
    vscode.window.showInformationMessage('No changes to apply.');
    return;
  }
  const base = ['apply', '--whitespace=nowarn', ...(revert ? ['-R'] : [])];
  const check = await repo.run([...base, '--check', '-'], { input: patch, allowFail: true, quiet: true });
  if (check.code === 0) {
    await repo.exec([...base, '-'], { input: patch });
    return;
  }
  const conflicts: string[] = [];
  const failed: string[] = [];
  const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'gitprism-apply-'));
  try {
    for (const p of req.paths) {
      const baseRev = revert ? req.rev : from;
      const theirsRev = revert ? from : req.rev;
      const [b, t] = await Promise.all([repo.show(baseRev, p), repo.show(theirsRev, p)]);
      const abs = repo.abs(p);
      const ours = await fs.promises.readFile(abs).catch(() => undefined);
      if (b && t && b.equals(t)) continue;
      if (!t) {
        // the result is a deletion
        if (!ours) continue;
        if (b && ours.equals(b)) await fs.promises.rm(abs);
        else failed.push(p);
        continue;
      }
      if (!ours) {
        if (!b) {
          await fs.promises.mkdir(path.dirname(abs), { recursive: true });
          await fs.promises.writeFile(abs, t);
        } else failed.push(p);
        continue;
      }
      const files = ['ours', 'base', 'theirs'].map((n) => path.join(tmp, n));
      await Promise.all([fs.promises.writeFile(files[0], ours), fs.promises.writeFile(files[1], b ?? ''), fs.promises.writeFile(files[2], t)]);
      const r = await gitRaw(repo.root, ['merge-file', '-p', '-L', 'Local Changes', '-L', short(baseRev), '-L', short(theirsRev), ...files], { allowFail: true, quiet: true });
      if (r.code < 0 || r.code > 127 || /binary/i.test(r.stderr)) {
        failed.push(p);
        continue;
      }
      await fs.promises.writeFile(abs, r.stdout);
      if (r.code > 0) conflicts.push(p);
    }
  } finally {
    await fs.promises.rm(tmp, { recursive: true, force: true });
    repo.fireChanged();
  }
  const verb = revert ? 'revert' : 'apply';
  if (failed.length) vscode.window.showErrorMessage(`Failed to ${verb} changes: ${failed.join(', ')}`);
  if (conflicts.length) {
    const pick = await vscode.window.showWarningMessage(`Changes were ${revert ? 'reverted' : 'applied'} with conflicts in ${conflicts.join(', ')}`, 'Open');
    if (pick) await vscode.window.showTextDocument(vscode.Uri.file(repo.abs(conflicts[0])));
  }
}
