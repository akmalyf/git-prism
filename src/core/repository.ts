// A git repository (one working tree) and the manager that discovers repositories in the workspace
// and fires change events when .git state or working files change.
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { git, gitRaw, type GitResult, type RunOptions } from './git';
import { LOG_FORMAT, parseLog, parseNameStatus, parseRefs, parseStatusV2, REF_FORMAT } from './parse';
import type { Commit, FileChange, OperationState, Ref, Remote, Stash, Status } from './types';

export class Repository implements vscode.Disposable {
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  /** fires (debounced) after anything in .git or the working tree changed */
  readonly onDidChange = this._onDidChange.event;
  private readonly disposables: vscode.Disposable[] = [this._onDidChange];
  private timer: NodeJS.Timeout | undefined;

  constructor(
    /** absolute path of the working tree root */
    readonly root: string,
    /** absolute path of this worktree's git dir (.git or .git/worktrees/x) */
    readonly gitDir: string,
    /** absolute path of the common git dir (shared by worktrees) */
    readonly commonDir: string,
  ) {
    const watch = (base: string, glob: string) => {
      const w = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(base), glob));
      w.onDidChange((u) => this.onFsEvent(u));
      w.onDidCreate((u) => this.onFsEvent(u));
      w.onDidDelete((u) => this.onFsEvent(u));
      this.disposables.push(w);
    };
    watch(root, '**/*');
    if (!gitDir.startsWith(root + path.sep)) watch(gitDir, '**/*');
    if (commonDir !== gitDir && !commonDir.startsWith(root + path.sep)) watch(commonDir, '{HEAD,refs/**,packed-refs,config}');
  }

  get name(): string {
    return path.basename(this.root);
  }

  private onFsEvent(uri: vscode.Uri): void {
    const p = uri.fsPath;
    // ignore lock files and git's own object writes
    if (p.endsWith('.lock') || p.includes(`${path.sep}objects${path.sep}`)) return;
    this.fireChanged();
  }

  /** Schedules a (debounced) change event; call after running a mutating git command. */
  fireChanged(): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this._onDidChange.fire(), 300);
  }

  run(args: string[], opts?: RunOptions): Promise<GitResult> {
    return git(this.root, args, opts);
  }

  /** Runs a mutating command and fires onDidChange afterwards (also on failure). */
  async exec(args: string[], opts?: RunOptions): Promise<GitResult> {
    try {
      return await git(this.root, args, opts);
    } finally {
      this.fireChanged();
    }
  }

  async buffer(args: string[], opts?: RunOptions): Promise<Buffer> {
    return (await gitRaw(this.root, args, opts)).stdout;
  }

  /** Absolute path of a repo-relative path. */
  abs(rel: string): string {
    return path.join(this.root, ...rel.split('/'));
  }

  /** Repo-relative (forward slashes) path of an absolute path. */
  rel(abs: string): string {
    return path.relative(this.root, abs).split(path.sep).join('/');
  }

  async status(opts: { ignored?: boolean } = {}): Promise<Status> {
    const args = ['status', '--porcelain=v2', '-z', '--branch', '--untracked-files=all', '--find-renames'];
    if (opts.ignored) args.push('--ignored=matching');
    return parseStatusV2((await this.run(args, { quiet: true })).stdout);
  }

  async refs(): Promise<Ref[]> {
    return parseRefs((await this.run(['for-each-ref', REF_FORMAT, 'refs/heads', 'refs/remotes', 'refs/tags'], { quiet: true })).stdout);
  }

  /** Current branch short name, or undefined when detached. */
  async currentBranch(): Promise<string | undefined> {
    const r = await this.run(['symbolic-ref', '--quiet', '--short', 'HEAD'], { allowFail: true, quiet: true });
    return r.code === 0 ? r.stdout.trim() : undefined;
  }

  async headHash(): Promise<string | undefined> {
    const r = await this.run(['rev-parse', '--verify', '--quiet', 'HEAD'], { allowFail: true, quiet: true });
    return r.code === 0 ? r.stdout.trim() : undefined;
  }

  async revParse(rev: string): Promise<string> {
    return (await this.run(['rev-parse', '--verify', `${rev}^{commit}`], { quiet: true })).stdout.trim();
  }

  operationState(): OperationState {
    const has = (p: string) => fs.existsSync(path.join(this.gitDir, p));
    if (has('rebase-merge') || has('rebase-apply/rebasing')) return 'rebase';
    if (has('rebase-apply/applying')) return 'am';
    if (has('MERGE_HEAD')) return 'merge';
    if (has('CHERRY_PICK_HEAD')) return 'cherry-pick';
    if (has('REVERT_HEAD')) return 'revert';
    if (has('BISECT_LOG')) return 'bisect';
    return 'none';
  }

  /** File content at a revision (':0' = index stage 0, ':2'/':3' = ours/theirs while conflicted). Undefined if the path doesn't exist there. */
  async show(rev: string, rel: string): Promise<Buffer | undefined> {
    const r = await gitRaw(this.root, ['show', `${rev}:${rel}`], { allowFail: true, quiet: true });
    return r.code === 0 ? r.stdout : undefined;
  }

  /**
   * Changed files between two revisions. `to` undefined = working tree; `to` === ':index' = index (staged).
   * `from` may be a commit, branch, tag or an empty tree hash.
   */
  async changes(from: string, to?: string, paths: string[] = []): Promise<FileChange[]> {
    const args = ['diff', '--name-status', '-z', '-M', '--no-ext-diff'];
    if (to === ':index') args.push('--cached', from);
    else if (to) args.push(from, to);
    else args.push(from);
    if (paths.length) args.push('--', ...paths);
    return parseNameStatus((await this.run(args, { quiet: true })).stdout);
  }

  /** Files changed by a commit relative to its first parent (or all files for a root commit). */
  async commitChanges(hash: string, parentIndex = 1): Promise<FileChange[]> {
    const args = ['diff-tree', '--no-commit-id', '--name-status', '-z', '-r', '-M', '--root'];
    if (parentIndex > 1) args.push(`${hash}^${parentIndex}`, hash);
    else args.push(hash);
    return parseNameStatus((await this.run(args, { quiet: true })).stdout);
  }

  async log(args: string[]): Promise<Commit[]> {
    return parseLog((await this.run(['log', LOG_FORMAT, ...args], { quiet: true })).stdout);
  }

  async commit(hash: string): Promise<Commit> {
    const [c] = parseLog((await this.run(['show', '-s', LOG_FORMAT, hash], { quiet: true })).stdout);
    return c;
  }

  async remotes(): Promise<Remote[]> {
    const out = (await this.run(['remote', '-v'], { quiet: true })).stdout;
    const map = new Map<string, Remote>();
    for (const line of out.split('\n')) {
      const m = /^(\S+)\t(\S+) \((fetch|push)\)$/.exec(line);
      if (!m) continue;
      const r = map.get(m[1]) ?? { name: m[1], fetchUrl: '', pushUrl: '' };
      if (m[3] === 'fetch') r.fetchUrl = m[2];
      else r.pushUrl = m[2];
      map.set(m[1], r);
    }
    return [...map.values()];
  }

  async stashes(): Promise<Stash[]> {
    const r = await this.run(['stash', 'list', '--format=%gd%x1f%H%x1f%gs%x1f%ct'], { quiet: true, allowFail: true });
    return r.stdout
      .split('\n')
      .filter(Boolean)
      .map((l) => {
        const [ref, hash, msg, date] = l.split('\x1f');
        const m = /^(?:WIP on|On) ([^:]+): (.*)$/.exec(msg);
        return { index: +ref.replace(/\D/g, ''), ref, hash, message: m ? m[2] : msg, branch: m?.[1], date: +date };
      });
  }

  async config(key: string): Promise<string | undefined> {
    const r = await this.run(['config', '--get', key], { allowFail: true, quiet: true });
    return r.code === 0 ? r.stdout.trim() : undefined;
  }

  dispose(): void {
    clearTimeout(this.timer);
    for (const d of this.disposables) d.dispose();
  }
}

export class RepositoryManager implements vscode.Disposable {
  private readonly repos = new Map<string, Repository>();
  private readonly _onDidChangeRepositories = new vscode.EventEmitter<void>();
  readonly onDidChangeRepositories = this._onDidChangeRepositories.event;
  private readonly _onDidChangeRepository = new vscode.EventEmitter<Repository>();
  /** any repository changed (debounced per repository) */
  readonly onDidChangeRepository = this._onDidChangeRepository.event;
  private readonly disposables: vscode.Disposable[] = [this._onDidChangeRepositories, this._onDidChangeRepository];
  private discovering: Promise<void> | undefined;

  constructor() {
    this.disposables.push(vscode.workspace.onDidChangeWorkspaceFolders(() => this.discover()));
  }

  get all(): Repository[] {
    return [...this.repos.values()].sort((a, b) => a.root.localeCompare(b.root));
  }

  /** (Re)discovers repositories for all workspace folders, plus nested repositories one level deep. */
  discover(): Promise<void> {
    return (this.discovering = (async () => {
      const found = new Set<string>();
      for (const f of vscode.workspace.workspaceFolders ?? []) {
        const candidates = [f.uri.fsPath];
        try {
          for (const e of fs.readdirSync(f.uri.fsPath, { withFileTypes: true })) {
            if (e.isDirectory() && fs.existsSync(path.join(f.uri.fsPath, e.name, '.git'))) candidates.push(path.join(f.uri.fsPath, e.name));
          }
        } catch {
          /* unreadable folder */
        }
        for (const c of candidates) {
          const r = await this.open(c);
          if (r) found.add(r.root);
        }
      }
      let changed = false;
      for (const [root, repo] of this.repos) {
        if (!found.has(root)) {
          repo.dispose();
          this.repos.delete(root);
          changed = true;
        }
      }
      if (changed) this._onDidChangeRepositories.fire();
    })());
  }

  async ready(): Promise<void> {
    await (this.discovering ?? this.discover());
  }

  /** Opens (or returns the already open) repository containing `dir`. */
  async open(dir: string): Promise<Repository | undefined> {
    const r = await git(dir, ['rev-parse', '--show-toplevel', '--absolute-git-dir', '--git-common-dir'], { allowFail: true, quiet: true }).catch(() => undefined);
    if (!r || r.code !== 0) return undefined;
    const [top, gitDir, common] = r.stdout.trim().split('\n');
    const root = path.normalize(top);
    const existing = this.repos.get(root);
    if (existing) return existing;
    const repo = new Repository(root, path.normalize(gitDir), path.resolve(root, common));
    repo.onDidChange(() => this._onDidChangeRepository.fire(repo));
    this.repos.set(root, repo);
    this._onDidChangeRepositories.fire();
    return repo;
  }

  get(root: string): Repository | undefined {
    return this.repos.get(path.normalize(root));
  }

  /** Repository containing a file/folder uri (deepest root wins). */
  forUri(uri: vscode.Uri): Repository | undefined {
    const p = uri.fsPath;
    let best: Repository | undefined;
    for (const r of this.repos.values()) {
      if ((p === r.root || p.startsWith(r.root + path.sep)) && (!best || r.root.length > best.root.length)) best = r;
    }
    return best;
  }

  /**
   * The repository to act on: the one of `uri` (or the active editor), else the only one,
   * else asks with a quick pick. Returns undefined if there is none or the user cancelled.
   */
  async pick(uri?: vscode.Uri, placeHolder = 'Select a Git repository'): Promise<Repository | undefined> {
    await this.ready();
    const target = uri ?? vscode.window.activeTextEditor?.document.uri;
    const byUri = target && target.scheme === 'file' ? this.forUri(target) : undefined;
    if (byUri) return byUri;
    const all = this.all;
    if (all.length <= 1) {
      if (!all.length) vscode.window.showWarningMessage('No Git repository found in the workspace.');
      return all[0];
    }
    const sel = await vscode.window.showQuickPick(
      all.map((r) => ({ label: r.name, description: r.root, repo: r })),
      { placeHolder },
    );
    return sel?.repo;
  }

  dispose(): void {
    for (const r of this.repos.values()) r.dispose();
    for (const d of this.disposables) d.dispose();
  }
}
