// Commands of the "Git" file/editor submenu (diff group): Show Diff, Compare with Revision…, Compare with Branch or
// Tag…, Compare with Latest Repository Version, Show History, plus the 'gitPrism.compare.fileWithRevision' contract.
import * as fs from 'node:fs';
import * as vscode from 'vscode';
import { invoke, type DiffFile } from '../../core/contracts';
import type { FeatureContext } from '../../core/context';
import { showGitError } from '../../core/git';
import type { Repository } from '../../core/repository';
import { historyTitle, showHistory } from './changesRpc';
import { pickFileRevision, pickRef } from './pickers';
import { baseName, diffNameStatus, LITERAL, targets, type Target } from './util';

function byRepo(ts: Target[]): Map<Repository, Target[]> {
  const m = new Map<Repository, Target[]>();
  for (const t of ts) m.set(t.repo, [...(m.get(t.repo) ?? []), t]);
  return m;
}

function localSide(repo: Repository, rel: string): DiffFile['right'] {
  return fs.existsSync(repo.abs(rel)) ? { worktree: true, path: rel } : { empty: true };
}

/** Diff of `rel` at `rev` (left) against the working tree (right). */
export async function diffWithLocal(repo: Repository, rel: string, rev: string, revPath = rel, leftTitle?: string): Promise<void> {
  const exists = !!(await repo.show(rev, revPath));
  await invoke('gitPrism.diff.show', {
    files: [{ repoRoot: repo.root, path: rel, oldPath: revPath !== rel ? revPath : undefined, left: exists ? { rev, path: revPath } : { empty: true }, right: localSide(repo, rel), leftTitle }],
  });
}

/** Show Diff (Compare with Same Repository Version): HEAD vs local for files, a changes browser for folders. */
export async function showDiffWithHead(ctx: FeatureContext, arg?: unknown, all?: unknown): Promise<void> {
  try {
    for (const [repo, ts] of byRepo(await targets(ctx.repos, arg, all))) {
      const head = await repo.headHash();
      if (ts.some((t) => t.isDir)) {
        if (!head) throw new Error(`The repository ${repo.name} has no commits yet.`);
        await invoke('gitPrism.changes.show', { repoRoot: repo.root, from: 'HEAD', paths: ts.map((t) => t.rel).filter(Boolean) });
        continue;
      }
      const changes = head ? await diffNameStatus(repo, 'HEAD', undefined, ts.map((t) => t.rel)) : [];
      const files: DiffFile[] = [];
      for (const t of ts) {
        const c = changes.find((x) => x.path === t.rel);
        const oldPath = c?.oldPath ?? t.rel;
        const inHead = head && c?.kind !== 'A' ? !!(await repo.show(head, oldPath)) : false;
        files.push({
          repoRoot: repo.root,
          path: t.rel,
          oldPath: oldPath !== t.rel ? oldPath : undefined,
          kind: c?.kind,
          left: inHead && head ? { rev: head, path: oldPath } : { empty: true },
          right: localSide(repo, t.rel),
        });
      }
      await invoke('gitPrism.diff.show', { files });
    }
  } catch (e) {
    showGitError(e, 'Cannot show diff');
  }
}

export async function compareWithRevision(ctx: FeatureContext, arg?: unknown): Promise<void> {
  try {
    const [t] = await targets(ctx.repos, arg);
    if (!t) return;
    if (t.isDir) {
      vscode.window.showWarningMessage('Compare with Revision works for files only.');
      return;
    }
    const rev = await pickFileRevision(t.repo, t.rel, baseName(t.rel, t.repo));
    if (!rev) return;
    await invoke('gitPrism.diff.show', {
      files: [{
        repoRoot: t.repo.root,
        path: t.rel,
        oldPath: rev.path !== t.rel ? rev.path : undefined,
        left: rev.kind === 'D' ? { empty: true } : { rev: rev.hash, path: rev.path },
        right: localSide(t.repo, t.rel),
      }],
    });
  } catch (e) {
    showGitError(e, 'Cannot compare with revision');
  }
}

export async function compareWithBranch(ctx: FeatureContext, arg?: unknown): Promise<void> {
  try {
    const [t] = await targets(ctx.repos, arg);
    if (!t) return;
    if (!(await t.repo.headHash())) throw new Error(`The repository ${t.repo.name} has no commits yet.`);
    const ref = await pickRef(t.repo, { title: 'Select Branch to Compare' });
    if (!ref) return;
    // like GitCompareWithRefAction: an error only when git sees no difference and the path doesn't exist in the ref
    const missing = t.rel && (await t.repo.run(['cat-file', '-e', `${ref}:${t.rel}`], { allowFail: true, quiet: true })).code !== 0;
    if (missing && !(await diffNameStatus(t.repo, ref, undefined, [t.rel])).length) {
      const isTag = ref.startsWith('refs/tags/') || (await t.repo.run(['show-ref', '--verify', '--quiet', `refs/tags/${ref}`], { allowFail: true, quiet: true })).code === 0;
      const name = ref.replace(/^refs\/(heads|remotes|tags)\//, '');
      vscode.window.showWarningMessage(`${t.isDir ? 'Directory' : 'File'} ${t.uri.fsPath} doesn't exist in ${isTag ? 'tag' : 'branch'} '${name}'`);
      return;
    }
    if (t.isDir || !t.rel) {
      await invoke('gitPrism.changes.show', { repoRoot: t.repo.root, from: ref, paths: t.rel ? [t.rel] : [] });
      return;
    }
    await diffWithLocal(t.repo, t.rel, ref, t.rel, ref);
  } catch (e) {
    showGitError(e, 'Cannot compare with branch');
  }
}

/** Compare with Latest Repository Version: the version on the upstream of the current branch (HEAD without one). */
export async function compareWithLatest(ctx: FeatureContext, arg?: unknown): Promise<void> {
  try {
    const [t] = await targets(ctx.repos, arg);
    if (!t) return;
    const up = await t.repo.run(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'], { allowFail: true, quiet: true });
    const latest = up.code === 0 && up.stdout.trim() ? up.stdout.trim() : 'HEAD';
    if (!(await t.repo.headHash())) throw new Error(`The repository ${t.repo.name} has no commits yet.`);
    if (t.isDir || !t.rel) {
      await invoke('gitPrism.changes.show', { repoRoot: t.repo.root, from: latest, paths: t.rel ? [t.rel] : [] });
      return;
    }
    const last = (await t.repo.run([LITERAL, 'log', '-n1', '--format=%H', latest, '--', t.rel], { quiet: true })).stdout.trim();
    await diffWithLocal(t.repo, t.rel, latest, t.rel, last ? `${last.slice(0, 8)} (${latest})` : latest);
  } catch (e) {
    showGitError(e, 'Cannot compare with latest repository version');
  }
}

export async function showFileHistory(ctx: FeatureContext, arg?: unknown, all?: unknown): Promise<void> {
  try {
    for (const [repo, ts] of byRepo(await targets(ctx.repos, arg, all))) {
      const paths = ts.map((t) => t.rel).filter(Boolean);
      const title = paths.length === 0 ? `History: ${repo.name}` : paths.length === 1 ? historyTitle(paths[0]) : `History: ${paths.map((p) => baseName(p, repo)).join(', ')}`;
      await showHistory(repo, paths, title);
    }
  } catch (e) {
    showGitError(e, 'Cannot show history');
  }
}

/** Show Current Revision: selects the last commit that touched the file (at HEAD) in the Git log. */
export async function showCurrentRevision(ctx: FeatureContext, arg?: unknown): Promise<void> {
  try {
    const [t] = await targets(ctx.repos, arg);
    if (!t) return;
    if (t.isDir || !t.rel) {
      vscode.window.showWarningMessage('Show Current Revision works for files only.');
      return;
    }
    const hash = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Window, title: 'Loading Current Revision…' },
      async () => {
        if (!(await t.repo.headHash())) return '';
        return (await t.repo.run([LITERAL, 'log', '-1', '--format=%H', 'HEAD', '--', t.rel], { quiet: true })).stdout.trim();
      },
    );
    if (!hash) {
      vscode.window.showWarningMessage(`Cannot find the current revision for ${t.uri.fsPath}`);
      return;
    }
    await invoke('gitPrism.log.show', { repoRoot: t.repo.root, revision: hash });
  } catch (e) {
    showGitError(e, 'Failed to fetch current revision');
  }
}

/** Contract 'gitPrism.compare.fileWithRevision'. */
export async function compareFileWithRevision(ctx: FeatureContext, args: { repoRoot: string; path: string; rev: string }): Promise<void> {
  try {
    await ctx.repos.ready();
    const repo = ctx.repos.get(args.repoRoot) ?? (await ctx.repos.open(args.repoRoot));
    if (!repo) throw new Error(`Repository ${args.repoRoot} is not available.`);
    let rev = args.rev;
    try {
      rev = await repo.revParse(args.rev);
    } catch {
      /* keep symbolic */
    }
    await diffWithLocal(repo, args.path, rev);
  } catch (e) {
    showGitError(e, 'Cannot compare with local');
  }
}
