// Stash model (stashes of every repository, `jbGit.hasStashes`) and the stash operations with IntelliJ's
// confirmations and notifications: Stash Changes… / Stash Silently, Unstash Changes… dialog, Apply / Pop / Drop /
// Clear / Unstash…, Show Diff and the file actions of the Stash view.
import * as vscode from 'vscode';
import type { FeatureContext } from '../../core/context';
import { invoke, type DiffFile } from '../../core/contracts';
import { showGitError } from '../../core/git';
import type { Repository } from '../../core/repository';
import { openDialog } from './dialogs';
import * as ops from './gitOps';
import { branchNameError, overwrittenPaths } from './logic';
import { applyPatchInteractive } from './patchOps';
import type { RepoChoice, StashFile, StashItem, StashRepo, StashRequest, UnstashInit, UnstashRequest } from './protocol';

const short = (h: string) => h.slice(0, 8);

export class StashModel implements vscode.Disposable {
  repos: StashRepo[] = [];
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChange = this._onDidChange.event;
  private readonly disposables: vscode.Disposable[] = [this._onDidChange];
  private timer: NodeJS.Timeout | undefined;
  private running: Promise<void> | undefined;
  private again = false;
  private last = '';

  constructor(private readonly ctx: FeatureContext) {
    this.disposables.push(
      ctx.repos.onDidChangeRepository(() => this.schedule()),
      ctx.repos.onDidChangeRepositories(() => this.schedule(0)),
    );
    this.schedule(0);
  }

  schedule(delay = 200): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.refresh(), delay);
  }

  refresh(): Promise<void> {
    if (this.running) {
      this.again = true;
      return this.running;
    }
    this.running = (async () => {
      do {
        this.again = false;
        await this.ctx.repos.ready();
        const repos: StashRepo[] = [];
        for (const repo of this.ctx.repos.all) {
          try {
            const [stashes, branch] = await Promise.all([repo.stashes(), repo.currentBranch()]);
            repos.push({ root: repo.root, name: repo.name, branch, stashes });
          } catch {
            repos.push({ root: repo.root, name: repo.name, stashes: [] });
          }
        }
        const json = JSON.stringify(repos);
        if (json !== this.last) {
          this.last = json;
          this.repos = repos;
          void vscode.commands.executeCommand('setContext', 'jbGit.hasStashes', repos.some((r) => r.stashes.length > 0));
          this._onDidChange.fire();
        }
      } while (this.again);
    })().finally(() => (this.running = undefined));
    return this.running;
  }

  dispose(): void {
    clearTimeout(this.timer);
    for (const d of this.disposables) d.dispose();
  }
}

export class StashActions {
  constructor(
    private readonly ctx: FeatureContext,
    private readonly model: StashModel,
  ) {}

  async repo(root?: string): Promise<Repository | undefined> {
    await this.ctx.repos.ready();
    if (root) return this.ctx.repos.get(root) ?? (await this.ctx.repos.open(root));
    return this.ctx.repos.pick();
  }

  private async choices(): Promise<RepoChoice[]> {
    await this.ctx.repos.ready();
    return Promise.all(this.ctx.repos.all.map(async (r) => ({ root: r.root, name: r.name, branch: await r.currentBranch().catch(() => undefined) })));
  }

  private async defaultRoot(root?: string): Promise<string | undefined> {
    await this.ctx.repos.ready();
    if (root) return root;
    const all = this.ctx.repos.all;
    if (!all.length) {
      vscode.window.showWarningMessage('No Git repository found in the workspace.');
      return undefined;
    }
    const active = vscode.window.activeTextEditor?.document.uri;
    return (active?.scheme === 'file' ? this.ctx.repos.forUri(active)?.root : undefined) ?? all[0].root;
  }

  // ------------------------------------------------------------ create

  /** "Stash Changes…": the Stash dialog (Git Root, Current branch, Message, Keep index, Include untracked files). */
  async create(args: { repoRoot?: string; paths?: string[] }): Promise<void> {
    const root = await this.defaultRoot(args.repoRoot);
    if (!root) return;
    const init: UnstashInit = { mode: 'stash', repos: await this.choices(), repoRoot: root, paths: args.paths?.length ? args.paths : undefined, locale: vscode.env.language };
    await openDialog<void>(this.ctx, { key: 'stash', bundle: 'unstash', title: 'Stash', icon: 'archive', init }, (done) => ({
      stash: async (req: StashRequest) => {
        const repo = await this.repo(req.repoRoot);
        if (!repo) return;
        // errors go back to the dialog (shown under the fields)
        const r = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Stashing changes from '${repo.name}'…` }, () =>
          ops.createStash(repo, req),
        );
        done(undefined);
        if (!r.created) {
          vscode.window.showInformationMessage(r.output || 'No local changes to save');
          return;
        }
        void this.model.refresh();
      },
      branch: async (p: { repoRoot: string }) => (await this.repo(p.repoRoot))?.currentBranch(),
    }));
  }

  /** "Stash Silently": `git stash push` in every repository that has local changes. */
  async silently(): Promise<void> {
    await this.ctx.repos.ready();
    let any = false;
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Stashing changes…' }, async () => {
      for (const repo of this.ctx.repos.all) {
        try {
          if (!(await ops.changedEntries(repo)).some((e) => e.kind !== '?')) continue;
          any = true;
          await ops.createStash(repo, { message: '', keepIndex: false, untracked: false });
        } catch (e) {
          showGitError(e, `Failed to stash ${repo.name}`);
        }
      }
    });
    if (!any) vscode.window.showInformationMessage('No local changes to save');
    void this.model.refresh();
  }

  // ------------------------------------------------------------ unstash

  /** "Unstash Changes…": IntelliJ's GitUnstashDialog. */
  async unstashDialog(args: { repoRoot?: string }): Promise<void> {
    const root = await this.defaultRoot(args.repoRoot);
    if (!root) return;
    const init: UnstashInit = { mode: 'unstash', repos: await this.choices(), repoRoot: root, locale: vscode.env.language };
    await openDialog<void>(
      this.ctx,
      { key: 'unstash', bundle: 'unstash', title: 'Unstash Changes', icon: 'archive', init },
      (done) => ({
        list: async (p: { repoRoot: string }) => {
          const repo = await this.repo(p.repoRoot);
          if (!repo) return { stashes: [] };
          return { branch: await repo.currentBranch(), stashes: await repo.stashes() };
        },
        view: async (p: { repoRoot: string; hash: string }) => this.view(p.repoRoot, p.hash),
        drop: async (p: { repoRoot: string; hash: string }) => this.drop(p.repoRoot, [p.hash]),
        clear: async (p: { repoRoot: string }) => this.clear(p.repoRoot),
        validateBranch: (name: string) => branchNameError(name),
        unstash: async (req: UnstashRequest) => {
          const ok = await this.unstash(req);
          if (ok) done(undefined);
          return ok;
        },
      }),
      ({ bridge }) => this.model.onDidChange(() => bridge.emit('refresh')),
    );
  }

  /** "Unstash…" of the Stash view: GitUnstashAsDialog (As new branch, Pop stash, Reinstate index). */
  async unstashAs(root: string, hash: string): Promise<void> {
    const repo = await this.repo(root);
    if (!repo) return;
    let stash: StashItem;
    try {
      stash = await ops.stashRef(repo, hash);
    } catch (e) {
      return showGitError(e);
    }
    const init: UnstashInit = { mode: 'unstashAs', repoRoot: repo.root, repoName: repo.name, branch: await repo.currentBranch(), stash, locale: vscode.env.language };
    await openDialog<void>(this.ctx, { key: `unstashAs:${repo.root}`, bundle: 'unstash', title: `Unstash Changes in ${repo.name}`, icon: 'archive', init }, (done) => ({
      validateBranch: (name: string) => branchNameError(name),
      unstash: async (req: UnstashRequest) => {
        const ok = await this.unstash(req);
        if (ok) done(undefined);
        return ok;
      },
    }));
  }

  /** Apply / pop / branch; reports conflicts and failures like IntelliJ. True when the changes were applied. */
  async unstash(req: UnstashRequest): Promise<boolean> {
    const repo = await this.repo(req.repoRoot);
    if (!repo) return false;
    if (repo.operationState() !== 'none' && repo.operationState() !== 'bisect') {
      vscode.window.showErrorMessage(`Cannot Unstash Changes Now: ${repo.name} is in the middle of a ${repo.operationState()}.`);
      return false;
    }
    let res: ops.ApplyResult;
    try {
      res = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Unstashing…' }, () =>
        ops.unstash(repo, req.hash, { pop: req.pop, index: req.index, branch: req.branch?.trim() || undefined }),
      );
    } catch (e) {
      await showGitError(e, 'Unstash failed');
      return false;
    } finally {
      void this.model.refresh();
    }
    return this.report(repo, res);
  }

  private async report(repo: Repository, res: ops.ApplyResult): Promise<boolean> {
    const err = (res.stderr || res.stdout).trim();
    switch (res.outcome) {
      case 'ok':
        vscode.window.showInformationMessage('Stash successfully applied');
        return true;
      case 'conflict': {
        void invoke('jbGit.conflicts.resolve', { repoRoot: repo.root });
        vscode.window
          .showWarningMessage('Conflicts were not resolved during unstash: Unstash is not complete, you have unresolved merges in your working tree.', 'Resolve conflicts…')
          .then((p) => p && invoke('jbGit.conflicts.resolve', { repoRoot: repo.root }));
        return true;
      }
      case 'index-conflict':
        await showGitError(new Error(err), 'Unstash failed due to an index conflict');
        return false;
      case 'local-changes': {
        const files = overwrittenPaths(res.stderr);
        await showGitError(new Error(`Your local changes to the following files would be overwritten by unstash: ${files.join(', ') || err}`), 'Unstash failed');
        return false;
      }
      case 'untracked':
        await showGitError(new Error(`Untracked working tree files would be overwritten by unstash. ${err}`), 'Unstash failed');
        return false;
      default:
        await showGitError(new Error(err || 'git stash failed'), 'Unstash failed');
        return false;
    }
  }

  async apply(root: string, hash: string, pop: boolean): Promise<void> {
    await this.unstash({ repoRoot: root, hash, pop, index: false });
  }

  async drop(root: string, hashes: string[]): Promise<boolean> {
    const repo = await this.repo(root);
    if (!repo) return false;
    try {
      const stashes = (await repo.stashes()).filter((s) => hashes.includes(s.hash)).sort((a, b) => b.index - a.index);
      if (!stashes.length) throw new Error('The stash does not exist anymore. Refresh the list of stashes.');
      for (const s of stashes) {
        const pick = await vscode.window.showWarningMessage(`Remove Stash ${s.ref}?`, { modal: true, detail: `Do you want to remove ${s.ref}?\n"${s.message}"` }, 'Yes', 'No');
        if (pick !== 'Yes') return false;
      }
      await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Removing Stash ${stashes.map((s) => s.ref).join(', ')}…` }, async () => {
        for (const s of stashes) await ops.dropStash(repo, s.hash);
      });
      return true;
    } catch (e) {
      await showGitError(e, 'Failed to drop stash');
      return false;
    } finally {
      void this.model.refresh();
    }
  }

  async clear(root: string): Promise<boolean> {
    const repo = await this.repo(root);
    if (!repo) return false;
    const pick = await vscode.window.showWarningMessage('Remove All Stashes?', { modal: true, detail: 'Remove all stashes? This cannot be undone.' }, 'Yes', 'No');
    if (pick !== 'Yes') return false;
    try {
      await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Clearing stashes…' }, () => ops.clearStashes(repo));
      return true;
    } catch (e) {
      await showGitError(e, 'Failed to clear stashes');
      return false;
    } finally {
      void this.model.refresh();
    }
  }

  // ------------------------------------------------------------ diffs & file actions

  diffFile(repo: Repository, stash: { hash: string; ref: string }, f: StashFile): DiffFile {
    const p = f.path;
    const base = `${stash.hash}^1`;
    if (f.source === 'untracked') {
      return { repoRoot: repo.root, path: p, kind: '?', left: { empty: true }, right: { rev: `${stash.hash}^3`, path: p }, leftTitle: short(stash.hash), rightTitle: `${stash.ref} (untracked)` };
    }
    const target = f.source === 'index' ? `${stash.hash}^2` : stash.hash;
    return {
      repoRoot: repo.root,
      path: p,
      oldPath: f.oldPath,
      kind: f.kind,
      left: f.kind === 'A' ? { empty: true } : { rev: base, path: f.oldPath ?? p },
      right: f.kind === 'D' ? { empty: true } : { rev: target, path: p },
      leftTitle: short(stash.hash),
      rightTitle: f.source === 'index' ? `${stash.ref} (index)` : stash.ref,
    };
  }

  async showDiff(root: string, hash: string, files: StashFile[] | undefined, index: number, beside = false, title?: string): Promise<void> {
    const repo = await this.repo(root);
    if (!repo) return;
    try {
      const s = await ops.stashRef(repo, hash);
      const list = files ?? (await ops.stashFiles(repo, hash));
      if (!list.length) {
        vscode.window.showInformationMessage(`${s.ref} contains no changes`);
        return;
      }
      await invoke('jbGit.diff.show', { title: title ?? `${s.ref}: ${s.message}`, files: list.map((f) => this.diffFile(repo, s, f)), index, beside });
    } catch (e) {
      showGitError(e, 'Cannot Show Diff');
    }
  }

  /** "View" of the Unstash dialog: all paths affected by the stash in the diff window. */
  view(root: string, hash: string): Promise<void> {
    return (async () => {
      const repo = await this.repo(root);
      if (!repo) return;
      const s = await ops.stashRef(repo, hash).catch(() => undefined);
      await this.showDiff(root, hash, undefined, 0, true, s ? `Paths Affected by ${s.ref}` : undefined);
    })();
  }

  async fileAction(action: 'compareLocal' | 'compareBeforeLocal' | 'editSource' | 'openRevision' | 'cherryPick', root: string, hash: string, files: StashFile[]): Promise<void> {
    const repo = await this.repo(root);
    if (!repo || !files.length) return;
    try {
      const s = await ops.stashRef(repo, hash);
      const rev = (f: StashFile) => (f.source === 'untracked' ? `${hash}^3` : f.source === 'index' ? `${hash}^2` : hash);
      switch (action) {
        case 'compareLocal':
        case 'compareBeforeLocal': {
          const diffs: DiffFile[] = files.map((f) => {
            const before = action === 'compareBeforeLocal';
            const left = before
              ? f.kind === 'A' || f.source === 'untracked' ? { empty: true as const } : { rev: `${hash}^1`, path: f.oldPath ?? f.path }
              : f.kind === 'D' ? { empty: true as const } : { rev: rev(f), path: f.path };
            return { repoRoot: repo.root, path: f.path, kind: f.kind, left, right: { worktree: true, path: f.path }, leftTitle: before ? short(hash) : s.ref, rightTitle: 'Your version' };
          });
          await invoke('jbGit.diff.show', { files: diffs, index: 0 });
          break;
        }
        case 'editSource':
          for (const f of files) {
            try {
              await vscode.window.showTextDocument(vscode.Uri.file(repo.abs(f.path)), { preview: files.length === 1 });
            } catch {
              vscode.window.showWarningMessage(`${f.path} does not exist in the working tree`);
            }
          }
          break;
        case 'openRevision':
          for (const f of files) if (f.kind !== 'D') await invoke('jbGit.openFileAtRevision', { repoRoot: repo.root, path: f.path, rev: rev(f) });
          break;
        case 'cherryPick': {
          const patch = await ops.stashPatch(repo, hash, files);
          if (!patch.length) return;
          await applyPatchInteractive(repo, patch, 1, 'Cherry-Pick Selected Changes', files.filter((f) => f.kind === 'A' || f.source === 'untracked').map((f) => f.path));
          break;
        }
      }
    } catch (e) {
      showGitError(e);
    }
  }
}
