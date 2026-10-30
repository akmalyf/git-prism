// Branch & tag operations behind the Branches popup actions: checkout (with Smart/Force Checkout),
// new branch, rename, delete (local/remote, with Restore), tags, update, pull into current, checkout & rebase.
import * as vscode from 'vscode';
import { invoke } from '../../core/contracts';
import { GitError, showGitError } from '../../core/git';
import type { Repository } from '../../core/repository';
import {
  blockedByUnmerged,
  classify,
  confirm,
  currentLabel,
  gitMessage,
  inputBox,
  loadState,
  locals,
  q,
  remoteBranches,
  reportOperationFailure,
  type RepoState,
  withProgress,
} from './common';
import { checkBranchName, parseOverwrittenFiles, parseWorktrees, refFormatProblem, splitRemoteBranch } from './logic';

const now = () => {
  const d = new Date();
  return `${d.toLocaleDateString(undefined, { day: '2-digit', month: '2-digit', year: '2-digit' })}, ${d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}`;
};

function flash(msg: string): void {
  vscode.window.setStatusBarMessage(`$(check) ${msg}`, 5000);
}

// ---------------- checkout ----------------

/**
 * Runs a checkout-like command (`git checkout …`). When local changes would be overwritten, offers IntelliJ's
 * Smart Checkout (stash → checkout → unstash) or Force Checkout. Returns true on success.
 */
export async function runCheckout(repo: Repository, args: string[], what: string, operation = 'checkout'): Promise<boolean> {
  if (await blockedByUnmerged(repo, operation)) return false;
  try {
    await withProgress(`Checking out ${what}…`, () => repo.exec(args));
    return true;
  } catch (e) {
    const over = e instanceof GitError ? parseOverwrittenFiles(e.stderr) : undefined;
    if (!over) {
      await showGitError(e, `Could not checkout ${what}`);
      return false;
    }
    const list = over.files.slice(0, 30).join('\n') + (over.files.length > 30 ? `\n… and ${over.files.length - 30} more` : '');
    if (over.kind === 'untracked') {
      await vscode.window.showErrorMessage('Untracked Files Preventing Checkout', {
        modal: true,
        detail: `The following untracked working tree files would be overwritten by checkout. Move or commit them before checkout:\n\n${list}`,
      });
      return false;
    }
    const pick = await vscode.window.showWarningMessage(
      'Git Checkout Problem',
      {
        modal: true,
        detail: `Your local changes to the following files would be overwritten by checkout.\nThe IDE can stash the changes, checkout and unstash them after that.\n\n${list}`,
      },
      'Smart Checkout',
      'Force Checkout',
    );
    if (pick === 'Force Checkout') {
      try {
        await withProgress(`Checking out ${what}…`, () => repo.exec([args[0], '-f', ...args.slice(1)]));
        return true;
      } catch (e2) {
        await showGitError(e2, `Could not checkout ${what}`);
        return false;
      }
    }
    if (pick !== 'Smart Checkout') return false;
    return smartRun(repo, args, what, operation);
  }
}

async function smartRun(repo: Repository, args: string[], what: string, operation: string): Promise<boolean> {
  const stashTop = async () => (await repo.run(['rev-parse', '-q', '--verify', 'refs/stash'], { quiet: true, allowFail: true })).stdout.trim();
  const before = await stashTop();
  try {
    await repo.exec(['stash', 'push', '-m', `Uncommitted changes before ${operation} at ${now()}`]);
  } catch (e) {
    await showGitError(e, `Could not stash local changes`);
    return false;
  }
  // nothing was stashed (e.g. only untracked files) → never pop someone else's stash
  const stashed = (await stashTop()) !== before;
  let ok = true;
  try {
    await withProgress(`Checking out ${what}…`, () => repo.exec(args));
  } catch (e) {
    ok = false;
    await showGitError(e, `Could not checkout ${what}`);
  }
  if (!stashed) return ok;
  try {
    await repo.exec(['stash', 'pop', '--index']);
  } catch {
    try {
      await repo.exec(['stash', 'pop']);
    } catch (e) {
      const conflicted = (await repo.run(['diff', '--name-only', '--diff-filter=U'], { quiet: true, allowFail: true })).stdout.trim();
      if (conflicted) {
        const pick = await vscode.window.showWarningMessage(
          'Local changes were restored with conflicts. Your uncommitted changes were saved to stash. Unstash is not complete, you have unresolved merges in your working tree. Resolve conflicts and drop the stash.',
          'Resolve conflicts…',
        );
        if (pick) invoke('jbGit.conflicts.resolve', { repoRoot: repo.root });
      } else await showGitError(e, 'Could not unstash local changes (they are kept in the stash)');
    }
  }
  return ok;
}

/** Checkout of a local branch, remote branch (creates/updates the tracking local branch), tag or revision. */
export async function checkout(repo: Repository, ref: string, state?: RepoState): Promise<boolean> {
  const s = state ?? (await loadState(repo));
  const c = classify(s, ref);
  if (c.kind === 'local') {
    if (c.name === s.current) return true;
    const ok = await runCheckout(repo, ['checkout', c.name, '--'], c.name);
    if (ok) flash(`Checked out ${c.name}`);
    return ok;
  }
  if (c.kind === 'remote') return checkoutRemote(repo, s, c.name);
  // tag / revision → detached HEAD
  const ok = await runCheckout(repo, ['checkout', '--detach', c.name], c.name);
  if (ok) flash(`Checked out ${c.name}`);
  return ok;
}

async function checkoutRemote(repo: Repository, s: RepoState, remoteRef: string): Promise<boolean> {
  const { branch } = splitRemoteBranch(remoteRef, s.remotes);
  const local = s.refs.find((r) => r.type === 'head' && r.short === branch);
  if (!local) {
    const ok = await runCheckout(repo, ['checkout', '--track', '-b', branch, remoteRef], remoteRef);
    if (ok) flash(`Checked out new branch ${branch} from ${remoteRef}`);
    return ok;
  }
  const ahead = +(await repo.run(['rev-list', '--count', `${remoteRef}..${branch}`], { quiet: true })).stdout.trim();
  if (!ahead) {
    if (branch === s.current) {
      try {
        await withProgress(`Checking out ${remoteRef}…`, () => repo.exec(['merge', '--ff-only', remoteRef]));
        flash(`Checked out ${branch}`);
        return true;
      } catch (e) {
        await showGitError(e, `Could not checkout ${remoteRef}`);
        return false;
      }
    }
    const ok = await runCheckout(repo, ['checkout', '-B', branch, remoteRef], remoteRef);
    if (ok) flash(`Checked out ${branch}`);
    return ok;
  }
  if (branch === s.current) {
    // the current branch can't be reset by checkout -B without losing the working tree state: offer the local one
    const pick = await vscode.window.showWarningMessage(
      `Checkout ${remoteRef}`,
      { modal: true, detail: `Local branch '${branch}' has commits that do not exist in '${remoteRef}'. Rebase '${branch}' onto '${remoteRef}', or checkout '${branch}'?` },
      'Rebase onto Remote',
      'Checkout Local Branch',
    );
    if (pick === 'Rebase onto Remote') return rebaseBranch(repo, remoteRef, branch);
    return pick === 'Checkout Local Branch';
  }
  const pick = await vscode.window.showWarningMessage(
    `Checkout ${remoteRef}`,
    { modal: true, detail: `Local branch '${branch}' has commits that do not exist in '${remoteRef}'. Rebase '${branch}' onto '${remoteRef}', or drop local commits?` },
    'Rebase onto Remote',
    'Drop Local Commits',
  );
  if (pick === 'Drop Local Commits') {
    const ok = await runCheckout(repo, ['checkout', '-B', branch, remoteRef], remoteRef);
    if (ok) flash(`Checked out ${branch}`);
    return ok;
  }
  if (pick === 'Rebase onto Remote') return rebaseBranch(repo, remoteRef, branch);
  return false;
}

async function rebaseBranch(repo: Repository, onto: string, branch: string): Promise<boolean> {
  if (await blockedByUnmerged(repo, 'rebase')) return false;
  try {
    await withProgress(`Rebasing ${branch}…`, () => repo.exec(['rebase', '--autostash', onto, branch]));
    flash(`Rebased ${branch} onto ${onto}`);
    return true;
  } catch (e) {
    await reportOperationFailure(repo, e, 'Rebase failed');
    return false;
  }
}

/** "Checkout and Rebase onto 'current'": checks out `ref` and rebases it onto the current branch in one step. */
export async function checkoutAndRebase(repo: Repository, ref: string): Promise<void> {
  const s = await loadState(repo);
  if (!s.current) {
    vscode.window.showErrorMessage('Rebase is not possible in the detached HEAD state');
    return;
  }
  const c = classify(s, ref);
  let branch = c.name;
  if (c.kind === 'remote') {
    branch = splitRemoteBranch(c.name, s.remotes).branch;
    if (branch === s.current) {
      vscode.window.showErrorMessage(`Checkout and Rebase failed: Cannot overwrite current branch ${branch}`);
      return;
    }
    const exists = locals(s).includes(branch);
    if (exists) {
      const ahead = +(await repo.run(['rev-list', '--count', `${c.name}..refs/heads/${branch}`], { quiet: true })).stdout.trim();
      if (ahead) {
        const pick = await vscode.window.showWarningMessage(
          `Checkout ${c.name}`,
          { modal: true, detail: `Local branch '${branch}' has commits that do not exist in '${c.name}'. Do you want to drop local commits?` },
          'Drop Local Commits',
        );
        if (pick !== 'Drop Local Commits') return;
      }
    }
    try {
      await repo.exec(['branch', ...(exists ? ['-f'] : ['--track']), branch, c.name]);
    } catch (e) {
      await showGitError(e, `Could not create new branch ${branch}`);
      return;
    }
  } else if (c.kind === 'local' && c.name === s.current) {
    return;
  }
  const wt = parseWorktrees((await repo.run(['worktree', 'list', '--porcelain'], { quiet: true, allowFail: true })).stdout).find(
    (w) => w.branch === branch && w.path !== repo.root,
  );
  if (wt) {
    vscode.window.showErrorMessage(`Checkout and Rebase failed: ${branch} is checked out in worktree ${wt.path}`);
    return;
  }
  if (await blockedByUnmerged(repo, 'rebase')) return;
  try {
    await withProgress(`Checking out ${branch} and rebasing onto current…`, () => repo.exec(['rebase', '--autostash', s.current!, branch]));
    flash(`Checked out ${branch} and rebased onto ${s.current}`);
  } catch (e) {
    await reportOperationFailure(repo, e, 'Checkout and Rebase failed');
  }
}

/** "Checkout and Update": checkout, then update the branch from its tracked branch. */
export async function checkoutAndUpdate(repo: Repository, branch: string): Promise<void> {
  if (await checkout(repo, branch)) invoke('jbGit.updateProject', { repoRoot: repo.root });
}

/** "Checkout Tag or Revision…" */
export async function checkoutRevision(repo: Repository): Promise<void> {
  const s = await loadState(repo);
  interface It extends vscode.QuickPickItem {
    ref?: string;
  }
  const qp = vscode.window.createQuickPick<It>();
  qp.title = 'Checkout Tag or Revision';
  qp.placeholder = 'Enter reference (branch, tag) name or commit hash:';
  const base: It[] = [
    ...s.refs.filter((r) => r.type === 'tag').map((r) => ({ label: `$(tag) ${r.short}`, description: r.subject, ref: r.short })),
    ...s.refs.filter((r) => r.type !== 'tag').map((r) => ({ label: `$(git-branch) ${r.short}`, description: r.subject, ref: r.short })),
  ];
  qp.items = base;
  qp.onDidChangeValue((v) => {
    const t = v.trim();
    qp.items = t && !base.some((i) => i.ref === t) ? [{ label: t, description: 'Checkout revision', ref: t, alwaysShow: true }, ...base] : base;
  });
  const ref = await new Promise<string | undefined>((resolve) => {
    qp.onDidAccept(() => {
      resolve(qp.selectedItems[0]?.ref ?? (qp.value.trim() || undefined));
      qp.hide();
    });
    qp.onDidHide(() => resolve(undefined));
    qp.show();
  });
  qp.dispose();
  if (!ref) return;
  const v = await repo.run(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { quiet: true, allowFail: true });
  if (v.code !== 0) {
    vscode.window.showErrorMessage(`Could not checkout ${ref}: Revision not found`);
    return;
  }
  const c = classify(s, ref);
  if (c.kind === 'local' || c.kind === 'remote') await checkout(repo, ref, s);
  else {
    const ok = await runCheckout(repo, ['checkout', '--detach', ref], ref);
    if (ok) flash(`Checked out ${ref}`);
  }
}

// ---------------- new branch / rename ----------------

/** IntelliJ's "Create New Branch" dialog: name + "Checkout branch" / "Overwrite existing branch" / "Set tracking branch". */
export async function newBranch(repo: Repository, start?: string, opts: { back?: boolean; defaultName?: string } = {}): Promise<boolean | 'back'> {
  const s = await loadState(repo);
  const startRef = start && start !== 'HEAD' ? start : undefined;
  const c = startRef ? classify(s, startRef) : undefined;
  const isRemote = c?.kind === 'remote';
  const ls = locals(s);
  const ctxNames = { locals: ls, remotes: remoteBranches(s) };
  const res = await inputBox({
    title: 'Create New Branch',
    prompt: startRef ? `New branch from ${q(c?.kind === 'revision' ? startRef.slice(0, 8) : startRef)}` : 'New branch from Current',
    value: opts.defaultName ?? (isRemote ? splitRemoteBranch(c!.name, s.remotes).branch : ''),
    placeholder: 'Branch Name:',
    back: opts.back,
    toggles: [
      { id: 'checkout', label: 'Checkout branch', value: true, icon: 'check' },
      { id: 'overwrite', label: 'Overwrite existing branch', value: false, icon: 'replace-all', visible: (v) => ls.includes(v.trim()) },
      { id: 'track', label: 'Set tracking branch', value: true, icon: 'link', visible: () => isRemote },
    ],
    validate: (v, t) => {
      const r = checkBranchName(v, ctxNames);
      if ('error' in r) return r.error;
      if ('exists' in r) {
        if (!t.overwrite) return `Branch name ${v} already exists. Change the name or overwrite existing branch`;
        if (v === s.current && !t.checkout) return `Cannot overwrite current branch ${v} without checking it out`;
      }
      return undefined;
    },
  });
  if (res === 'back') return 'back';
  if (!res) return false;
  const { value: name, toggles: t } = res;
  if (!s.head && !t.checkout) {
    vscode.window.showErrorMessage(`Could not create new branch ${name}: the repository has no commits yet. Check out the branch instead.`);
    return false;
  }
  const overwrite = t.overwrite && ls.includes(name);
  const track = isRemote ? [t.track ? '--track' : '--no-track'] : [];
  const from = startRef ? [startRef] : [];
  if (t.checkout) {
    const ok = await runCheckout(repo, ['checkout', ...track, overwrite ? '-B' : '-b', name, ...from], name);
    if (ok) flash(startRef ? `Checked out new branch ${name} from ${startRef}` : `Checked out new branch ${name}`);
    return ok;
  }
  try {
    await withProgress(`Creating branch ${name}…`, () => repo.exec(['branch', ...track, ...(overwrite ? ['-f'] : []), name, ...from]));
    flash(`Branch ${name} was created`);
    return true;
  } catch (e) {
    await showGitError(e, `Could not create new branch ${name}`);
    return false;
  }
}

export async function renameBranch(repo: Repository, branch?: string): Promise<void> {
  const s = await loadState(repo);
  const ls = locals(s);
  const old = branch ?? s.current ?? (await pickLocal(s, 'Select a branch to rename'));
  if (!old) return;
  if (!ls.includes(old) && old !== s.current) {
    vscode.window.showErrorMessage(`Branch ${old} not found`);
    return;
  }
  const res = await inputBox({
    title: `Rename Branch ${old}`,
    value: old,
    placeholder: 'New branch name',
    validate: (v) => {
      const r = checkBranchName(v, { locals: ls, remotes: remoteBranches(s), current: old });
      if ('error' in r) return r.error;
      if ('exists' in r) return `Branch name ${v} already exists`;
      return undefined;
    },
  });
  if (!res || res === 'back' || res.value === old) return;
  try {
    await withProgress(`Renaming ${old} to ${res.value}…`, () => repo.exec(['branch', '-m', old, res.value]));
    flash(`Renamed ${old} to ${res.value}`);
  } catch (e) {
    await showGitError(e, `Could not rename ${old}`);
  }
}

async function pickLocal(s: RepoState, placeHolder: string, excludeCurrent = false): Promise<string | undefined> {
  const items = s.refs.filter((r) => r.type === 'head' && !(excludeCurrent && r.short === s.current)).map((r) => ({ label: r.short, description: r.upstream }));
  if (!items.length) {
    vscode.window.showInformationMessage('No local branches');
    return undefined;
  }
  return (await vscode.window.showQuickPick(items, { placeHolder }))?.label;
}

// ---------------- delete ----------------

export async function deleteRef(repo: Repository, ref?: string): Promise<void> {
  const s = await loadState(repo);
  const name = ref ?? (await pickLocal(s, 'Select a branch to delete', true));
  if (!name) return;
  const c = classify(s, name);
  if (c.kind === 'remote') return deleteRemoteBranch(repo, c.name, s);
  if (c.kind === 'tag') return deleteTag(repo, c.name);
  if (c.kind !== 'local') {
    vscode.window.showErrorMessage(`Branch ${name} not found`);
    return;
  }
  return deleteLocalBranch(repo, c.name, s);
}

export async function deleteLocalBranch(repo: Repository, name: string, state?: RepoState): Promise<void> {
  const s = state ?? (await loadState(repo));
  if (name === s.current) {
    vscode.window.showErrorMessage(`Branch ${name} wasn't deleted: it is the current branch`);
    return;
  }
  const ref = s.refs.find((r) => r.type === 'head' && r.short === name);
  const hash = ref?.hash ?? (await repo.revParse(`refs/heads/${name}`));
  const upstream = ref?.upstream;
  let forced = false;
  try {
    await withProgress(`Deleting ${name}…`, () => repo.exec(['branch', '-d', name]));
  } catch (e) {
    if (!(e instanceof GitError) || !/not fully merged/.test(e.stderr)) {
      await showGitError(e, `Branch ${name} wasn't deleted`);
      return;
    }
    const base = s.current ?? 'HEAD';
    const log = await repo.run(['log', '--format=%h  %s  (%an)', '-n', '20', `${base}..refs/heads/${name}`], { quiet: true, allowFail: true });
    const pick = await vscode.window.showWarningMessage(
      'Branch Was Not Fully Merged',
      { modal: true, detail: `The branch ${name} was not fully merged to ${base}.\nBelow is the list of unmerged commits.\n\n${log.stdout.trim()}` },
      'Delete Anyway',
    );
    if (pick !== 'Delete Anyway') return;
    try {
      await withProgress(`Deleting ${name}…`, () => repo.exec(['branch', '-D', name]));
      forced = true;
    } catch (e2) {
      await showGitError(e2, `Branch ${name} wasn't deleted`);
      return;
    }
  }
  const remoteExists = !!upstream && s.refs.some((r) => r.type === 'remote' && r.short === upstream);
  const actions = ['Restore', ...(forced ? ['View Commits'] : []), ...(remoteExists ? ['Delete Tracked Branch'] : [])];
  const pick = await vscode.window.showInformationMessage(`Deleted branch ${name}${forced ? '. Unmerged commits were discarded' : ''}`, ...actions);
  if (pick === 'Restore') {
    try {
      await withProgress(`Restoring Branch ${name}…`, () => repo.exec(['branch', name, hash]));
      if (upstream) await repo.exec(['branch', `--set-upstream-to=${upstream}`, name], { allowFail: true });
      flash(`Restored branch ${name}`);
    } catch (e) {
      await showGitError(e, `Could not Restore ${name}`);
    }
  } else if (pick === 'View Commits') {
    invoke('jbGit.log.show', { repoRoot: repo.root, revision: hash });
  } else if (pick === 'Delete Tracked Branch' && upstream) {
    await deleteRemoteBranch(repo, upstream);
  }
}

export async function deleteRemoteBranch(repo: Repository, remoteRef: string, state?: RepoState): Promise<void> {
  const s = state ?? (await loadState(repo));
  const { remote, branch } = splitRemoteBranch(remoteRef, s.remotes);
  if (!s.remotes.includes(remote)) {
    vscode.window.showErrorMessage(`Could not find remote by name: ${remote}`);
    return;
  }
  const trackers = s.refs.filter((r) => r.type === 'head' && r.upstream === remoteRef && r.short !== s.current).map((r) => r.short);
  const pick = await confirm(
    'Delete Remote Branch',
    `Delete remote branch ${remoteRef}?${trackers.length ? `\n\n"Delete All" also deletes the tracking local ${trackers.length === 1 ? 'branch' : 'branches'}: ${trackers.join(', ')}` : ''}`,
    'Delete',
    ...(trackers.length ? ['Delete All'] : []),
  );
  if (!pick) return;
  try {
    await withProgress(`Deleting ${remoteRef}…`, () => repo.exec(['push', remote, '--delete', `refs/heads/${branch}`]));
  } catch (e) {
    await showGitError(e, `Failed to delete remote branch ${remoteRef}`);
    return;
  }
  const deleted: string[] = [];
  if (pick === 'Delete All') {
    for (const t of trackers) {
      const r = await repo.exec(['branch', '-D', t], { allowFail: true });
      if (r.code === 0) deleted.push(t);
    }
  }
  vscode.window.showInformationMessage(
    `Deleted remote branch ${remoteRef}${deleted.length ? `. Also deleted local ${deleted.length === 1 ? 'branch' : 'branches'}: ${deleted.join(', ')}` : ''}`,
  );
}

// ---------------- tags ----------------

export async function newTag(repo: Repository, target?: string): Promise<void> {
  const s = await loadState(repo);
  if (!s.head) {
    vscode.window.showErrorMessage('Could not create tag: the repository has no commits');
    return;
  }
  const on = target && target !== 'HEAD' ? target : undefined;
  const tags = s.refs.filter((r) => r.type === 'tag').map((r) => r.short);
  const title = `Create New Tag On ${on ? (/^[0-9a-f]{40}$/.test(on) ? on.slice(0, 8) : on) : currentLabel(s)}`;
  const res = await inputBox({
    title,
    placeholder: 'Enter the name of new tag',
    prompt: 'Tag Name',
    toggles: [{ id: 'force', label: 'Force', value: false, icon: 'warning', visible: (v) => tags.includes(v.trim()) }],
    validate: (v, t) => {
      if (!v) return 'Specify name for the new tag';
      if (refFormatProblem(v)) return `Tag name ${v} is not valid`;
      if (tags.includes(v) && !t.force) return 'The tag with the same name exists.';
      return undefined;
    },
  });
  if (!res || res === 'back') return;
  const message = await vscode.window.showInputBox({
    title,
    prompt: 'Message: If the message is not empty, an annotated tag is created.',
    placeHolder: 'Message (optional)',
    ignoreFocusOut: true,
  });
  if (message === undefined) return;
  const args = ['tag', ...(res.toggles.force ? ['-f'] : []), ...(message.trim() ? ['-a', '-m', message] : []), res.value, ...(on ? [on] : [])];
  try {
    await withProgress('Tagging…', () => repo.exec(args));
    flash(`Created tag ${res.value} successfully.`);
  } catch (e) {
    await showGitError(e, 'Could not create tag');
  }
}

export async function pickTag(repo: Repository, placeHolder: string): Promise<string | undefined> {
  const tags = (await repo.refs()).filter((r) => r.type === 'tag');
  if (!tags.length) {
    vscode.window.showInformationMessage('No tags');
    return undefined;
  }
  return (await vscode.window.showQuickPick(tags.map((t) => ({ label: t.short, description: t.subject })), { placeHolder }))?.label;
}

export async function deleteTag(repo: Repository, tag: string): Promise<void> {
  const obj = await repo.run(['rev-parse', '--verify', '--quiet', `refs/tags/${tag}`], { quiet: true, allowFail: true });
  if (obj.code !== 0) {
    vscode.window.showErrorMessage(`Could not find tag ${tag}`);
    return;
  }
  const hash = obj.stdout.trim();
  try {
    await withProgress(`Deleting ${tag}…`, () => repo.exec(['tag', '-d', tag]));
  } catch (e) {
    await showGitError(e, `Tag ${tag} wasn't deleted`);
    return;
  }
  const remotes = (await repo.remotes()).map((r) => r.name);
  const onRemote = remotes.length === 1 ? 'Delete on Remote' : 'Delete on Remotes';
  const pick = await vscode.window.showInformationMessage(`Deleted Tag: ${tag}`, 'Restore', ...(remotes.length ? [onRemote] : []));
  if (pick === 'Restore') {
    try {
      await withProgress(`Restoring Tag ${tag}…`, () => repo.exec(['tag', tag, hash]));
      flash(`Restored tag ${tag}`);
    } catch (e) {
      await showGitError(e, `Could not Restore ${tag}`);
    }
  } else if (pick === onRemote) {
    await deleteTagOnRemotes(repo, tag, remotes);
  }
}

async function deleteTagOnRemotes(repo: Repository, tag: string, remotes: string[]): Promise<void> {
  const deleted: string[] = [];
  const missing: string[] = [];
  const failed: string[] = [];
  await withProgress(`Deleting tag ${tag} on remote…`, async () => {
    for (const r of remotes) {
      const ls = await repo.run(['ls-remote', '--tags', r, `refs/tags/${tag}`], { allowFail: true });
      if (ls.code === 0 && !ls.stdout.trim()) {
        missing.push(r);
        continue;
      }
      const res = await repo.exec(['push', r, '--delete', `refs/tags/${tag}`], { allowFail: true });
      (res.code === 0 ? deleted : failed).push(r);
    }
  });
  const pl = (n: number) => (n === 1 ? 'Remote' : 'Remotes');
  const parts = [
    deleted.length ? `Deleted Tag on ${pl(deleted.length)}: ${deleted.join(', ')}` : '',
    missing.length ? `Tag Doesn't Exist on ${pl(missing.length)}: ${missing.join(', ')}` : '',
  ].filter(Boolean);
  if (failed.length) await showGitError(new Error(`Failed to delete tag ${tag} on ${pl(failed.length)} ${failed.join(', ')}`));
  if (parts.length) vscode.window.showInformationMessage(parts.join('. '));
}

export async function pushTag(repo: Repository, tag: string, remote: string): Promise<void> {
  try {
    await withProgress(`Pushing tag ${tag} to ${remote}…`, () => repo.exec(['push', remote, `refs/tags/${tag}`]));
    vscode.window.showInformationMessage(`Pushed tag ${tag} to ${remote}`);
  } catch (e) {
    await showGitError(e, `Failed to push tag ${tag}`);
  }
}

// ---------------- update / pull ----------------

/** "Update": fetch + fast-forward a (non-current) local branch from its tracked branch, like `git fetch origin b:b`. */
export async function updateBranch(repo: Repository, branch: string, state?: RepoState): Promise<void> {
  const s = state ?? (await loadState(repo));
  if (branch === s.current) {
    invoke('jbGit.updateProject', { repoRoot: repo.root });
    return;
  }
  const remote = await repo.config(`branch.${branch}.remote`);
  const merge = await repo.config(`branch.${branch}.merge`);
  if (!remote || !merge) {
    vscode.window.showWarningMessage(`Tracked branch is not configured for ${branch}`);
    return;
  }
  const wts = parseWorktrees((await repo.run(['worktree', 'list', '--porcelain'], { quiet: true, allowFail: true })).stdout);
  const elsewhere = wts.find((w) => w.branch === branch);
  if (elsewhere) {
    vscode.window.showErrorMessage(`Branch cannot be updated, as it is checked out in worktree ${elsewhere.path}`);
    return;
  }
  try {
    await withProgress('Updating branches…', () => repo.exec(['fetch', remote, `${merge}:refs/heads/${branch}`]));
    flash(`Updated ${branch}`);
  } catch (e) {
    const msg = gitMessage(e);
    if (/non-fast-forward|rejected/.test(msg)) {
      vscode.window.showErrorMessage(`Update failed: ${branch} has diverged from its tracked branch and can't be fast-forwarded. Checkout it and use Update Project.`);
    } else await showGitError(e, 'Update failed');
  }
}

/** "Pull into 'current' Using Rebase/Merge" for a remote branch. */
export async function pullInto(repo: Repository, remoteRef: string, rebase: boolean): Promise<void> {
  const s = await loadState(repo);
  const { remote, branch } = splitRemoteBranch(remoteRef, s.remotes);
  if (await blockedByUnmerged(repo, rebase ? 'rebase' : 'merge')) return;
  try {
    await withProgress(`Pull into ${currentLabel(s)} Using ${rebase ? 'Rebase' : 'Merge'}…`, () =>
      repo.exec(['pull', rebase ? '--rebase' : '--no-rebase', '--autostash', remote, branch]),
    );
    flash(`Pulled ${remoteRef} into ${currentLabel(s)}`);
  } catch (e) {
    await reportOperationFailure(repo, e, 'Pull failed');
  }
}
