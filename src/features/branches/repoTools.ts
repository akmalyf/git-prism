// Repository-level commands: Clone…, Create Git Repository…, Unshallow repository (+ the "Shallow repository
// detected" hint), Clean Up Branches…, merged branches, Copy Branch Name and the VCS Operations popup.
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { git, showGitError } from '../../core/git';
import type { Repository } from '../../core/repository';
import { showBranchActions } from './actions';
import { confirm, type Ctx, fmtDate, inputBox, loadState, withProgress } from './common';
import { cleanupCandidates, cloneDirName, parseWorktrees } from './logic';

// ---------------- clone / init ----------------

export async function cloneRepository(ctx: Ctx): Promise<void> {
  const clip = (await vscode.env.clipboard.readText()).trim();
  const looksLikeUrl = /^(https?:\/\/|git@|ssh:\/\/|git:\/\/|file:\/\/)\S+$/.test(clip);
  const url = await inputBox({
    title: 'Clone Repository',
    prompt: 'URL:',
    value: looksLikeUrl ? clip : '',
    placeholder: 'Repository URL',
    validate: (v) => (!v ? 'Empty repository URL' : undefined),
  });
  if (!url || url === 'back') return;
  const folders = vscode.workspace.workspaceFolders;
  const defParent = folders?.length ? path.dirname(folders[0].uri.fsPath) : os.homedir();
  const parentPick = await vscode.window.showOpenDialog({
    title: 'Destination Directory',
    openLabel: 'Select as Parent Directory',
    canSelectFolders: true,
    canSelectFiles: false,
    canSelectMany: false,
    defaultUri: vscode.Uri.file(defParent),
  });
  if (!parentPick?.length) return;
  const parent = parentPick[0].fsPath;
  const dir = await inputBox({
    title: 'Clone Repository',
    prompt: `Directory: (in ${parent})`,
    value: cloneDirName(url.value),
    validate: (v) => {
      if (!v) return 'Invalid directory path';
      const abs = path.resolve(parent, v);
      try {
        if (fs.existsSync(abs)) {
          if (!fs.statSync(abs).isDirectory()) return 'Destination is not a directory';
          if (fs.readdirSync(abs).length) return 'The directory already exists and it is not empty';
        }
      } catch {
        return 'Invalid directory path';
      }
      return undefined;
    },
  });
  if (!dir || dir === 'back') return;
  const target = path.resolve(parent, dir.value);
  const existed = fs.existsSync(target);
  let cancelled = false;
  try {
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Cloning repository… ${url.value}`, cancellable: true },
      (_p, token) => {
        token.onCancellationRequested(() => (cancelled = true));
        return git(parent, ['clone', '--progress', '--', url.value, target], { token });
      },
    );
    if (cancelled) throw new Error('Clone cancelled');
  } catch (e) {
    // a killed clone leaves a half-written directory behind: remove what we created
    if (cancelled) {
      try {
        if (existed) for (const f of fs.readdirSync(target)) fs.rmSync(path.join(target, f), { recursive: true, force: true });
        else fs.rmSync(target, { recursive: true, force: true });
      } catch {
        /* best effort */
      }
      return;
    }
    await showGitError(e, 'Clone failed');
    return;
  }
  const uri = vscode.Uri.file(target);
  const hasWs = !!vscode.workspace.workspaceFolders?.length;
  const pick = await vscode.window.showInformationMessage(
    `Cloned ${path.basename(target)}`,
    'Open',
    'Open in New Window',
    ...(hasWs ? ['Add to Workspace'] : []),
  );
  if (pick === 'Open') vscode.commands.executeCommand('vscode.openFolder', uri);
  else if (pick === 'Open in New Window') vscode.commands.executeCommand('vscode.openFolder', uri, { forceNewWindow: true });
  else if (pick === 'Add to Workspace') {
    vscode.workspace.updateWorkspaceFolders(vscode.workspace.workspaceFolders?.length ?? 0, 0, { uri });
    await ctx.repos.discover();
  }
}

export async function initRepository(ctx: Ctx, uri?: vscode.Uri): Promise<void> {
  let dir = uri?.scheme === 'file' ? uri.fsPath : undefined;
  if (dir && fs.existsSync(dir) && !fs.statSync(dir).isDirectory()) dir = path.dirname(dir);
  if (!dir) {
    const folders = vscode.workspace.workspaceFolders ?? [];
    let browse = !folders.length;
    if (folders.length) {
      const pick = await vscode.window.showQuickPick(
        [...folders.map((f) => ({ label: `$(folder) ${f.name}`, description: f.uri.fsPath, dir: f.uri.fsPath })), { label: '$(folder-opened) Browse…', description: '', dir: '' }],
        { title: 'Create Git Repository', placeHolder: 'Select directory where the new Git repository will be created.' },
      );
      if (!pick) return;
      if (pick.dir) dir = pick.dir;
      else browse = true;
    }
    if (browse) {
      const sel = await vscode.window.showOpenDialog({
        title: 'Create Git Repository',
        openLabel: 'Create Repository',
        canSelectFolders: true,
        canSelectFiles: false,
        defaultUri: folders[0]?.uri,
      });
      if (!sel?.length) return;
      dir = sel[0].fsPath;
    }
  }
  if (!dir) return;
  const top = await git(dir, ['rev-parse', '--show-toplevel'], { allowFail: true, quiet: true }).catch(() => undefined);
  if (top && top.code === 0) {
    const ok = await confirm(
      'Git Init',
      `The selected directory ${dir} is already under Git.\nAre you sure that you want to create a new VCS root?`,
      'Create',
    );
    if (!ok) return;
  }
  try {
    await withProgress('Initializing repository…', () => git(dir!, ['init']));
  } catch (e) {
    await showGitError(e, 'Git init failed');
    return;
  }
  // discover() drops repositories outside the workspace folders, so open the new one afterwards
  await ctx.repos.discover();
  await ctx.repos.open(dir);
  vscode.window.setStatusBarMessage(`$(check) Created Git repository in ${dir}`, 5000);
}

// ---------------- unshallow ----------------

async function isShallow(repo: Repository): Promise<boolean> {
  const r = await repo.run(['rev-parse', '--is-shallow-repository'], { quiet: true, allowFail: true });
  return r.stdout.trim() === 'true';
}

export async function unshallow(repo: Repository): Promise<void> {
  if (!(await isShallow(repo))) {
    vscode.window.showInformationMessage(`${repo.name} is already a complete repository`);
    return;
  }
  try {
    await withProgress('Unshallowing repository…', (token) => repo.exec(['fetch', '--unshallow'], { token }), true);
    vscode.window.showInformationMessage('The repository was converted to a complete one');
  } catch (e) {
    await showGitError(e, 'Failed to unshallow repository');
  }
}

/** IntelliJ's "Shallow repository detected" notification, once per repository (until "Don't Show Again"). */
export async function checkShallow(ctx: Ctx, repo: Repository, notified: Set<string>): Promise<void> {
  if (notified.has(repo.root)) return;
  notified.add(repo.root);
  const key = `gitPrism.branches.unshallowDismissed:${repo.root}`;
  if (ctx.extension.workspaceState.get<boolean>(key)) return;
  if (!(await isShallow(repo))) return;
  const pick = await vscode.window.showInformationMessage(
    `Shallow repository detected: ${repo.name}. This repository can be converted to a complete one`,
    'Unshallow repository',
    "Don't Show Again",
  );
  if (pick === 'Unshallow repository') await unshallow(repo);
  else if (pick) await ctx.extension.workspaceState.update(key, true);
}

// ---------------- clean up / merged branches ----------------

async function defaultBranch(repo: Repository, locals: string[]): Promise<string | undefined> {
  const r = await repo.run(['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'], { quiet: true, allowFail: true });
  const remoteHead = r.code === 0 ? r.stdout.trim() : undefined;
  if (remoteHead) {
    const local = remoteHead.slice(remoteHead.indexOf('/') + 1);
    return locals.includes(local) ? local : remoteHead;
  }
  return ['main', 'master', 'develop', 'trunk'].find((b) => locals.includes(b));
}

export async function cleanupBranches(repo: Repository): Promise<void> {
  const s = await loadState(repo);
  const locals = s.refs.filter((r) => r.type === 'head').map((r) => r.short);
  const target = (await defaultBranch(repo, locals)) ?? s.current;
  if (!target) {
    vscode.window.showWarningMessage('Cannot determine the branch to check merge status against');
    return;
  }
  const [refsOut, mergedOut, wtOut] = await withProgress('Calculating Merge Status…', () =>
    Promise.all([
      repo.run(['for-each-ref', '--format=%(refname:short)%1f%(upstream:short)%1f%(upstream:track)%1f%(committerdate:unix)', 'refs/heads'], { quiet: true }),
      repo.run(['for-each-ref', '--merged', target, '--format=%(refname:short)', 'refs/heads'], { quiet: true }),
      repo.run(['worktree', 'list', '--porcelain'], { quiet: true, allowFail: true }),
    ]),
  );
  const checkedOut = parseWorktrees(wtOut.stdout).map((w) => w.branch).filter((b): b is string => !!b);
  const exclude = [target, ...(s.current ? [s.current] : []), ...checkedOut];
  const candidates = cleanupCandidates(refsOut.stdout, mergedOut.stdout.split('\n').filter(Boolean), exclude);
  if (!candidates.length) {
    vscode.window.showInformationMessage(`No branches to clean up: no local branches are merged to ${target} or have a gone tracked branch`);
    return;
  }
  const items = candidates.map((c) => ({
    label: c.name,
    description: [c.merged ? 'Merged' : 'Not merged', c.gone ? 'tracked branch is gone' : ''].filter(Boolean).join(' · '),
    detail: [c.date ? `Last Commit Date: ${fmtDate(c.date)}` : '', c.upstream ? `Tracked Branch: ${c.upstream}` : ''].filter(Boolean).join('    '),
    picked: c.merged,
    c,
  }));
  const sel = await vscode.window.showQuickPick(items, {
    title: `Branches Cleanup — merged to ${target}`,
    placeHolder: 'Filter by Prefix (optional), select branches to delete',
    canPickMany: true,
    matchOnDescription: true,
  });
  if (!sel?.length) return;
  const names = sel.map((x) => x.label);
  const ok = await confirm(
    'Delete Branches',
    `Delete ${names.length === 1 ? 'the selected branch' : `the selected ${names.length} branches`}?\n${names.join('\n')}`,
    'Delete',
  );
  if (!ok) return;
  const restore: { name: string; hash: string; upstream?: string }[] = [];
  const failed: string[] = [];
  await withProgress('Deleting branches…', async () => {
    for (const n of names) {
      const ref = s.refs.find((r) => r.type === 'head' && r.short === n);
      const res = await repo.exec(['branch', '-D', n], { allowFail: true });
      if (res.code === 0 && ref) restore.push({ name: n, hash: ref.hash, upstream: ref.upstream });
      else failed.push(n);
    }
  });
  if (failed.length) await showGitError(new Error(`Errors during deleting ${failed.join(', ')}`));
  if (!restore.length) return;
  const pick = await vscode.window.showInformationMessage(
    `Deleted ${restore.length === 1 ? 'branch' : `${restore.length} branches`}: ${restore.map((r) => r.name).join(', ')}`,
    'Restore',
  );
  if (pick !== 'Restore') return;
  for (const r of restore) {
    await repo.exec(['branch', r.name, r.hash], { allowFail: true });
    if (r.upstream) await repo.exec(['branch', `--set-upstream-to=${r.upstream}`, r.name], { allowFail: true });
  }
  vscode.window.setStatusBarMessage('$(check) Branches restored', 5000);
}

export async function findMergedBranches(ctx: Ctx, repo: Repository): Promise<void> {
  const s = await loadState(repo);
  const r = await repo.run(['for-each-ref', '--merged', 'HEAD', '--format=%(refname)', 'refs/heads', 'refs/remotes'], { quiet: true, allowFail: true });
  const names = new Set(r.stdout.split('\n').filter(Boolean));
  const merged = s.refs.filter((x) => names.has(x.name) && x.short !== s.current);
  const cur = s.current ?? 'HEAD';
  if (!merged.length) {
    vscode.window.showInformationMessage(`No branches are merged into '${cur}'`);
    return;
  }
  const pick = await vscode.window.showQuickPick(
    [
      { label: 'Local', kind: vscode.QuickPickItemKind.Separator },
      ...merged.filter((x) => x.type === 'head').map((x) => ({ label: `$(git-branch) ${x.short}`, description: fmtDate(x.date), ref: x.short })),
      { label: 'Remote', kind: vscode.QuickPickItemKind.Separator },
      ...merged.filter((x) => x.type === 'remote').map((x) => ({ label: `$(git-branch) ${x.short}`, description: fmtDate(x.date), ref: x.short })),
    ] as (vscode.QuickPickItem & { ref?: string })[],
    { title: `Branches Merged into '${cur}'`, placeHolder: 'Select a branch to see its actions' },
  );
  if (pick?.ref) await showBranchActions(ctx, repo, pick.ref);
}

export async function copyBranchName(repo: Repository, ref?: string): Promise<void> {
  const name = ref ?? (await repo.currentBranch());
  if (!name) {
    vscode.window.showWarningMessage('Not on a branch (detached HEAD)');
    return;
  }
  await vscode.env.clipboard.writeText(name);
  vscode.window.setStatusBarMessage(`$(copy) Copied ${name}`, 3000);
}

// ---------------- VCS Operations popup ----------------

interface Op {
  label: string;
  /** candidate command ids, the first registered one is used */
  ids: string[];
  icon?: string;
}

const OPS: (Op | '-')[] = [
  { label: 'Commit…', ids: ['gitPrism.commit.focus'], icon: 'check' },
  { label: 'Push…', ids: ['gitPrism.push'], icon: 'arrow-up' },
  { label: 'Update Project…', ids: ['gitPrism.updateProject'], icon: 'sync' },
  { label: 'Pull…', ids: ['gitPrism.pull'], icon: 'arrow-down' },
  { label: 'Fetch', ids: ['gitPrism.fetch'], icon: 'repo-fetch' },
  '-',
  { label: 'Merge…', ids: ['gitPrism.merge'], icon: 'git-merge' },
  { label: 'Rebase…', ids: ['gitPrism.rebase'] },
  '-',
  { label: 'Branches…', ids: ['gitPrism.branches.show'], icon: 'git-branch' },
  { label: 'New Branch…', ids: ['gitPrism.branch.new'] },
  { label: 'New Tag…', ids: ['gitPrism.tag.new'], icon: 'tag' },
  '-',
  { label: 'Reset HEAD…', ids: ['gitPrism.resetHead'] },
  { label: 'Stash Changes…', ids: ['gitPrism.stash.create'] },
  { label: 'Unstash Changes…', ids: ['gitPrism.stash.unstash'] },
  '-',
  { label: 'Annotate with Git Blame', ids: ['gitPrism.annotate.toggle'] },
  { label: 'Show History', ids: ['gitPrism.showHistory'], icon: 'history' },
  { label: 'Compare with Branch or Tag…', ids: ['gitPrism.compareWithBranch'] },
  { label: 'Rollback…', ids: ['gitPrism.commit.rollback', 'gitPrism.rollback', 'gitPrism.changes.rollback', 'gitPrism.commit.rollbackAll'], icon: 'discard' },
  '-',
  { label: 'Show Git Log', ids: ['gitPrism.log.show'], icon: 'git-commit' },
  { label: 'Clone…', ids: ['gitPrism.clone'] },
  { label: 'Manage Remotes…', ids: ['gitPrism.remotes.manage'] },
];

export async function vcsOperations(): Promise<void> {
  const registered = new Set(await vscode.commands.getCommands(true));
  const items: (vscode.QuickPickItem & { id?: string })[] = [];
  for (const op of OPS) {
    if (op === '-') {
      if (items.length && items[items.length - 1].kind !== vscode.QuickPickItemKind.Separator) items.push({ label: '', kind: vscode.QuickPickItemKind.Separator });
      continue;
    }
    const id = op.ids.find((i) => registered.has(i));
    if (!id) continue;
    items.push({ label: `${op.icon ? `$(${op.icon}) ` : ''}${op.label}`, id });
  }
  while (items.length && items[items.length - 1].kind === vscode.QuickPickItemKind.Separator) items.pop();
  const pick = await vscode.window.showQuickPick(items, { title: 'VCS Operations', placeHolder: 'Git' });
  if (pick?.id) vscode.commands.executeCommand(pick.id);
}
