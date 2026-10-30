// "Worktrees…" (IntelliJ's Worktrees tab as a quick pick): list, open (new window / current window / add to
// workspace), New Worktree… from a branch or commit, Delete, Prune and Refresh.
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { GitError, showGitError } from '../../core/git';
import type { Repository } from '../../core/repository';
import { classify, confirm, inputBox, loadState, locals, remoteBranches, withProgress } from './common';
import { checkBranchName, parseWorktrees, splitRemoteBranch, type Worktree, worktreeDirName } from './logic';

export async function listWorktrees(repo: Repository): Promise<Worktree[]> {
  return parseWorktrees((await repo.run(['worktree', 'list', '--porcelain'], { quiet: true })).stdout);
}

export function openFolder(dir: string, how: 'new' | 'current' | 'add'): void {
  if (!fs.existsSync(dir)) {
    vscode.window.showErrorMessage(`Worktree directory \`${dir}\` no longer exists`);
    return;
  }
  const uri = vscode.Uri.file(dir);
  if (how === 'add') {
    const n = vscode.workspace.workspaceFolders?.length ?? 0;
    vscode.workspace.updateWorkspaceFolders(n, 0, { uri });
  } else vscode.commands.executeCommand('vscode.openFolder', uri, { forceNewWindow: how === 'new' });
}

interface WtItem extends vscode.QuickPickItem {
  wt?: Worktree;
}

const BTN_CURRENT: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon('folder-opened'), tooltip: 'Open in Current Window' };
const BTN_ADD: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon('root-folder'), tooltip: 'Add to Workspace' };
const BTN_DELETE: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon('trash'), tooltip: 'Delete worktree…' };
const BTN_NEW: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon('add'), tooltip: 'New Worktree…' };
const BTN_PRUNE: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon('clear-all'), tooltip: 'Prune Worktrees' };
const BTN_REFRESH: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon('refresh'), tooltip: 'Refresh' };

/** The "Worktrees" list. Enter opens the worktree as a project in a new window. */
export async function showWorktrees(repo: Repository): Promise<void> {
  const qp = vscode.window.createQuickPick<WtItem>();
  qp.title = `Worktrees — ${repo.name}`;
  qp.placeholder = 'Select a worktree to open it in a new window';
  qp.matchOnDescription = true;
  qp.matchOnDetail = true;
  qp.buttons = [BTN_NEW, BTN_PRUNE, BTN_REFRESH];
  const load = async () => {
    qp.busy = true;
    try {
      const wts = await listWorktrees(repo);
      const items: WtItem[] = wts.map((w) => {
        const flags = [w.main ? 'main' : '', w.locked ? 'Locked' : '', w.prunable ? 'Prunable' : '', w.path === repo.root ? 'current' : ''].filter(Boolean);
        return {
          label: `$(${w.main ? 'repo' : 'folder'}) ${path.basename(w.path)}`,
          description: [w.branch ?? (w.bare ? 'bare' : w.head ? `detached ${w.head.slice(0, 8)}` : ''), flags.join(', ')].filter(Boolean).join('  ·  '),
          detail: w.path,
          wt: w,
          buttons: w.main ? [BTN_CURRENT, BTN_ADD] : [BTN_CURRENT, BTN_ADD, BTN_DELETE],
        };
      });
      if (wts.length <= 1) items.push({ label: 'No linked worktrees', description: 'Create worktree…', alwaysShow: true });
      qp.items = items;
    } catch (e) {
      qp.items = [];
      qp.placeholder = `Failed to get a list of worktrees: ${e instanceof Error ? e.message : e}`;
    } finally {
      qp.busy = false;
    }
  };
  qp.onDidTriggerButton(async (b) => {
    if (b === BTN_REFRESH) return load();
    qp.hide();
    if (b === BTN_NEW) await newWorktree(repo);
    else if (b === BTN_PRUNE) await pruneWorktrees(repo);
  });
  qp.onDidTriggerItemButton(async (e) => {
    const w = e.item.wt;
    if (!w) return;
    if (e.button === BTN_CURRENT) {
      qp.hide();
      openFolder(w.path, 'current');
    } else if (e.button === BTN_ADD) {
      qp.hide();
      openFolder(w.path, 'add');
    } else if (e.button === BTN_DELETE) {
      if (await deleteWorktree(repo, w)) load();
    }
  });
  qp.onDidAccept(async () => {
    const it = qp.selectedItems[0];
    qp.hide();
    if (it?.wt) openFolder(it.wt.path, 'new');
    else if (it) await newWorktree(repo);
  });
  qp.onDidHide(() => qp.dispose());
  qp.show();
  await load();
}

interface RefItem extends vscode.QuickPickItem {
  ref?: string;
}

/** "New Worktree…" / "New Worktree from 'x'…": branch/commit → (new branch name) → location → `git worktree add`. */
export async function newWorktree(repo: Repository, from?: string): Promise<void> {
  const s = await loadState(repo);
  if (!s.head) {
    vscode.window.showErrorMessage('Worktree creation failed: the repository has no commits');
    return;
  }
  let ref = from;
  if (!ref) {
    const items: RefItem[] = [
      { label: 'Local', kind: vscode.QuickPickItemKind.Separator },
      ...s.refs.filter((r) => r.type === 'head').map((r) => ({ label: `$(git-branch) ${r.short}`, description: r.short === s.current ? 'current' : r.upstream, ref: r.short })),
      { label: 'Remote', kind: vscode.QuickPickItemKind.Separator },
      ...s.refs.filter((r) => r.type === 'remote').map((r) => ({ label: `$(git-branch) ${r.short}`, ref: r.short })),
      { label: 'Tags', kind: vscode.QuickPickItemKind.Separator },
      ...s.refs.filter((r) => r.type === 'tag').map((r) => ({ label: `$(tag) ${r.short}`, ref: r.short })),
    ];
    const qp = vscode.window.createQuickPick<RefItem>();
    qp.title = 'New Worktree';
    qp.placeholder = 'Select a branch to create the worktree (or type a commit hash)';
    qp.items = items;
    qp.onDidChangeValue((v) => {
      const t = v.trim();
      qp.items = t ? [{ label: t, description: 'Commit', ref: t, alwaysShow: true }, ...items] : items;
    });
    ref = await new Promise<string | undefined>((resolve) => {
      qp.onDidAccept(() => {
        resolve(qp.selectedItems[0]?.ref);
        qp.hide();
      });
      qp.onDidHide(() => resolve(undefined));
      qp.show();
    });
    qp.dispose();
    if (!ref) return;
  }
  const c = classify(s, ref);
  const wts = await listWorktrees(repo);
  const checkedOut = c.kind === 'local' && wts.some((w) => w.branch === c.name);
  // a new branch is needed unless an existing, not checked out local branch is used
  let newBranch: string | undefined;
  if (c.kind !== 'local' || checkedOut) {
    const suggested = c.kind === 'remote' ? splitRemoteBranch(c.name, s.remotes).branch : '';
    const ls = locals(s);
    const res = await inputBox({
      title: 'New Worktree',
      prompt: checkedOut ? `${c.name} is already checked out — a new branch is needed` : `Branch in the worktree, created from ${c.name}`,
      value: suggested && !ls.includes(suggested) ? suggested : '',
      placeholder: 'Branch name',
      validate: (v) => {
        if (!v) return 'A name for the branch in the worktree must be provided explicitly';
        const r = checkBranchName(v, { locals: ls, remotes: remoteBranches(s) });
        if ('error' in r) return r.error;
        if ('exists' in r) return `Local branch ${v} already exists, provide explicit name for the branch in the worktree`;
        return undefined;
      },
    });
    if (!res || res === 'back') return;
    newBranch = res.value;
  }
  const main = wts.find((w) => w.main)?.path ?? repo.root;
  const def = path.join(path.dirname(main), worktreeDirName(path.basename(main), newBranch ?? c.name));
  const loc = await inputBox({
    title: 'New Worktree',
    prompt: 'Worktree Location',
    value: def,
    validate: (v) => {
      if (!v) return 'Provide a location for the worktree';
      const abs = path.resolve(repo.root, v);
      try {
        if (fs.existsSync(abs) && (!fs.statSync(abs).isDirectory() || fs.readdirSync(abs).length)) return 'The directory already exists and it is not empty';
      } catch {
        return 'Invalid directory path';
      }
      return { warning: `The worktree will be created in: ${abs}` };
    },
  });
  if (!loc || loc === 'back') return;
  const dir = path.resolve(repo.root, loc.value);
  const args = ['worktree', 'add', ...(newBranch ? ['-b', newBranch] : []), dir, c.name];
  try {
    await withProgress('Creating worktree', () => repo.exec(args));
  } catch (e) {
    await showGitError(e, 'Worktree creation failed');
    return;
  }
  const pick = await vscode.window.showInformationMessage(`Created worktree ${path.basename(dir)}`, 'Open in New Window', 'Open', 'Add to Workspace');
  if (pick) openFolder(dir, pick === 'Open' ? 'current' : pick === 'Add to Workspace' ? 'add' : 'new');
}

export async function deleteWorktree(repo: Repository, w: Worktree): Promise<boolean> {
  if (w.main) return false;
  const open = vscode.workspace.workspaceFolders?.some((f) => f.uri.fsPath === w.path);
  const pick = await confirm('Delete Worktree', `Delete worktree at \`${w.path}\`?${open ? '\nIt is currently opened in this window.' : ''}`, 'Delete Worktree');
  if (!pick) return false;
  try {
    await withProgress('Deleting worktree…', () => repo.exec(['worktree', 'remove', w.path]));
  } catch (e) {
    const msg = e instanceof GitError ? e.stderr : '';
    if (!/modified or untracked|locked|--force|-f -f/.test(msg)) {
      await showGitError(e, 'Worktree deletion failed');
      return false;
    }
    const force = await confirm('Delete Worktree', `${msg.trim()}\n\nDelete the worktree anyway? Uncommitted changes in it will be lost.`, 'Force Delete');
    if (!force) return false;
    try {
      await withProgress('Deleting worktree…', () => repo.exec(['worktree', 'remove', '--force', ...(w.locked ? ['--force'] : []), w.path]));
    } catch (e2) {
      await showGitError(e2, 'Worktree deletion failed');
      return false;
    }
  }
  vscode.window.showInformationMessage(`Successfully deleted worktree \`${path.basename(w.path)}\``);
  return true;
}

export async function pruneWorktrees(repo: Repository): Promise<void> {
  let prunable: string[];
  try {
    const r = await withProgress('Getting prunable worktrees…', () => repo.run(['worktree', 'prune', '--dry-run', '-v']));
    prunable = (r.stdout + r.stderr)
      .split('\n')
      .map((l) => /^Removing worktrees\/([^:]+)/.exec(l.trim())?.[1])
      .filter((x): x is string => !!x);
  } catch (e) {
    await showGitError(e, 'Failed to get a list of worktrees');
    return;
  }
  if (!prunable.length) {
    vscode.window.showInformationMessage('No worktrees to prune');
    return;
  }
  const pick = await confirm('Prune Worktrees', `Remove Git records for missing worktrees: \`${prunable.join('`, `')}\`?`, 'Prune Worktrees');
  if (!pick) return;
  try {
    await withProgress('Pruning worktrees…', () => repo.exec(['worktree', 'prune']));
    vscode.window.showInformationMessage('Successfully pruned worktrees');
  } catch (e) {
    await showGitError(e, 'Failed to prune worktrees');
  }
}
