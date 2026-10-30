// File History ("History: <file>" tab) actions of the host: Vcs.FileHistory.ContextMenu / Vcs.FileHistory.Toolbar
// items that work on "the file in the selected revision" (following renames) — Show Diff / Compare, Show Diff in a
// New Tab, Compare with Local, Show File at Revision, Annotate, Get, Show All Affected Files, Show in Git Log.
import * as fs from 'node:fs';
import * as vscode from 'vscode';
import { invoke, type DiffFile } from '../../core/contracts';
import type { Repository } from '../../core/repository';
import type { FileChange } from '../../core/types';
import { getFromRevision, realParents, showDiff } from './actions';
import { LITERAL_PATHSPECS, type LogData, type RootData } from './data';
import { affectedFiles, compareChange, historyChange, pathAtRevision } from './historyfile';
import { EMPTY_TREE, type CommitId, type HistoryActionRequest, type HistoryFileInfo } from './protocol';

const short = (h: string) => (h === EMPTY_TREE ? 'empty' : h.slice(0, 8));

interface Resolved extends HistoryFileInfo {
  repo: Repository;
  /** first parent (EMPTY_TREE for a root commit) */
  from: string;
  /** changes of the commit inside the history paths */
  files: FileChange[];
  /** the file's change in the commit (single file) */
  change?: FileChange;
  /** current repo-relative path of the history file / directory */
  current?: string;
}

export class FileHistoryActions {
  constructor(
    private readonly data: LogData,
    /** absolute history paths of the tab */
    private readonly historyPaths: readonly string[],
  ) {}

  private rootData(root: string): RootData {
    const rd = this.data.roots.find((r) => r.repo.root === root);
    if (!rd) throw new Error(`${root} is not a Git repository`);
    return rd;
  }

  /** A directory, the whole repository or several paths: no single file to open/annotate/get. */
  private isDir(rd: RootData): boolean {
    if (this.historyPaths.length !== 1 || rd.paths.includes('.')) return true;
    try {
      return fs.statSync(this.historyPaths[0]).isDirectory();
    } catch {
      return false; // deleted file
    }
  }

  private async resolve(c: CommitId): Promise<Resolved> {
    const rd = this.rootData(c.root);
    const repo = rd.repo;
    const dir = this.isDir(rd);
    const parents = await realParents(this.data, repo, c.hash);
    const from = parents[0] ?? EMPTY_TREE;
    const files = affectedFiles(await repo.changes(from, c.hash), rd.paths);
    const current = rd.paths[0];
    const base: Resolved = { root: c.root, hash: c.hash, repo, from, files, dir, deleted: false, changed: files.length > 0, current };
    if (dir) return base;
    const change = historyChange(files, rd.paths);
    let present: string[] = [];
    if (!change) {
      const tree = await repo.run(['ls-tree', '--name-only', '-z', c.hash, '--', ...rd.paths], { quiet: true, allowFail: true, env: LITERAL_PATHSPECS });
      const names = new Set(tree.stdout.split('\0').filter(Boolean));
      present = rd.paths.filter((p) => names.has(p));
    }
    const at = pathAtRevision(change, present);
    return { ...base, change, path: at.path, deleted: at.deleted, changed: !!change };
  }

  async info(c: CommitId): Promise<HistoryFileInfo> {
    const r = await this.resolve(c);
    return { root: r.root, hash: r.hash, dir: r.dir, path: r.path, deleted: r.deleted, changed: r.changed };
  }

  async run(req: HistoryActionRequest): Promise<unknown> {
    const commits = req.commits ?? [];
    if (!commits.length) return;
    if (req.action === 'showDiff' && commits.length === 2) return this.compare(commits);
    const r = await this.resolve(commits[0]);
    switch (req.action) {
      case 'showDiff':
      case 'showDiffNewTab':
        return this.showDiff(r, req.action === 'showDiffNewTab');
      case 'compareWithLocal':
        return this.compareWithLocal(r);
      case 'openFile':
        if (!r.path || r.deleted) return this.noFile(r);
        return invoke('gitPrism.openFileAtRevision', { repoRoot: r.root, path: r.path, rev: r.hash });
      case 'annotate':
        if (!r.path || r.deleted) return this.noFile(r);
        return vscode.commands.executeCommand('gitPrism.annotate.revision', { repoRoot: r.root, path: r.path, rev: r.hash });
      case 'get':
        return this.get(r);
      case 'showAllAffected':
        return invoke('gitPrism.changes.show', { repoRoot: r.root, from: r.from, to: r.hash, title: `Paths affected in commit ${short(r.hash)}` });
      case 'selectInLog':
        return invoke('gitPrism.log.show', { repoRoot: r.root, revision: r.hash });
    }
  }

  private noFile(r: Resolved): void {
    vscode.window.showWarningMessage(`The file doesn't exist in revision ${short(r.hash)}.`);
  }

  /** Show Diff of one row: the file's change in the commit (a directory: every affected file). */
  private async showDiff(r: Resolved, beside: boolean): Promise<void> {
    let files = r.dir ? r.files : r.change ? [r.change] : [];
    if (!files.length && !r.dir && r.path) files = [{ path: r.path, kind: 'M' }];
    if (!files.length) {
      vscode.window.showInformationMessage(`No changes in commit ${short(r.hash)}.`);
      return;
    }
    await showDiff({ group: { root: r.root, from: r.from, to: r.hash, files }, path: files[0].path, beside });
  }

  /** "Compare" of two selected revisions (older → newer). */
  private async compare(commits: CommitId[]): Promise<unknown> {
    if (commits[0].root !== commits[1].root) {
      vscode.window.showWarningMessage('Select two commits from the same repository.');
      return;
    }
    const rows = commits.map((c) => this.data.row(c.root, c.hash));
    const [newer, older] = rows[0] >= 0 && rows[1] >= 0 && rows[1] < rows[0] ? [commits[1], commits[0]] : [commits[0], commits[1]];
    const [a, b] = await Promise.all([this.resolve(older), this.resolve(newer)]);
    if (a.dir) {
      return invoke('gitPrism.changes.show', { repoRoot: a.root, from: older.hash, to: newer.hash, paths: a.current && a.current !== '.' ? [a.current] : undefined, title: `${short(older.hash)} ↔ ${short(newer.hash)}` });
    }
    const change = compareChange(a.deleted ? undefined : a.path, b.deleted ? undefined : b.path);
    if (!change) {
      vscode.window.showInformationMessage('The file doesn\'t exist in the selected revisions.');
      return;
    }
    await showDiff({ group: { root: a.root, from: older.hash, to: newer.hash, files: [change] }, path: change.path });
  }

  private async compareWithLocal(r: Resolved): Promise<unknown> {
    if (r.dir) {
      const paths = r.current && r.current !== '.' ? [r.current] : undefined;
      return invoke('gitPrism.changes.show', { repoRoot: r.root, from: r.hash, paths, title: `${short(r.hash)} ↔ Local Changes` });
    }
    const current = r.current ?? r.path;
    if (!current) return;
    const exists = fs.existsSync(r.repo.abs(current));
    if (r.deleted && !exists) {
      vscode.window.showInformationMessage('Contents are identical.');
      return;
    }
    const file: DiffFile = {
      repoRoot: r.root,
      path: current,
      kind: r.deleted ? 'A' : !exists ? 'D' : r.path !== current ? 'R' : 'M',
      left: r.deleted || !r.path ? { empty: true } : { rev: r.hash, path: r.path },
      right: exists ? { worktree: true, path: current } : { empty: true },
      leftTitle: short(r.hash),
      rightTitle: 'Local Changes',
    };
    if (r.path && r.path !== current) file.oldPath = r.path;
    return invoke('gitPrism.diff.show', { files: [file] });
  }

  /** Get: the file's content in that revision replaces the local file (renamed: written to the current name). */
  private async get(r: Resolved): Promise<void> {
    if (r.dir) return;
    const current = r.current ?? r.path;
    if (!current) return;
    if (r.deleted || !r.path || r.path === current) {
      // absent in the revision → getFromRevision deletes the local file
      await getFromRevision(r.repo, { root: r.root, paths: [current], rev: r.hash });
      return;
    }
    const ok = await vscode.window.showWarningMessage(
      `Get '${current}' from revision ${short(r.hash)}?`,
      { modal: true, detail: `Local changes in this file will be replaced with the content of '${r.path}' in that revision.` },
      'Get',
    );
    if (ok !== 'Get') return;
    const content = await r.repo.show(r.hash, r.path);
    if (!content) throw new Error(`Cannot load '${r.path}' at ${short(r.hash)}`);
    await vscode.workspace.fs.writeFile(vscode.Uri.file(r.repo.abs(current)), content);
    r.repo.fireChanged();
  }
}
