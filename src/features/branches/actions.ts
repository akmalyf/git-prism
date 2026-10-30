// The per-ref action list of the Branches popup ('jbGit.branch.actions'), in IntelliJ's order and wording
// (Git.Branch.Backend.Checkout + Git.Branch.Backend groups): Checkout, New Branch from 'x'…, Compare with…, Merge…, …
import * as vscode from 'vscode';
import { invoke } from '../../core/contracts';
import { showGitError } from '../../core/git';
import type { Repository } from '../../core/repository';
import { classify, type Ctx, currentLabel, isFav, loadState, q, type RepoState, toggleFav } from './common';
import {
  checkout,
  checkoutAndRebase,
  checkoutAndUpdate,
  deleteLocalBranch,
  deleteRemoteBranch,
  deleteTag,
  newBranch,
  pullInto,
  pushTag,
  renameBranch,
  updateBranch,
} from './ops';
import { listWorktrees, newWorktree, openFolder } from './worktrees';

interface ActionItem extends vscode.QuickPickItem {
  run?: () => unknown;
}

const sep = (): ActionItem => ({ label: '', kind: vscode.QuickPickItemKind.Separator });

/** Builds the action list for `ref` in `s`. */
export async function buildActions(ctx: Ctx, s: RepoState, ref: string, reopen: () => void): Promise<{ title: string; items: ActionItem[] }> {
  const repo = s.repo;
  const c = classify(s, ref);
  const cur = currentLabel(s);
  const qc = q(cur);
  const qn = q(c.kind === 'revision' && /^[0-9a-f]{40}$/.test(c.name) ? c.name.slice(0, 8) : c.name);
  const isCurrent = c.kind === 'local' && c.name === s.current;
  const detached = !s.current;
  const items: ActionItem[] = [];
  const add = (label: string, run: () => unknown, description?: string) => items.push({ label, run, description });
  const compareArgs = { repoRoot: repo.root, ref: c.name };

  if (c.kind === 'local') {
    const wt = isCurrent ? undefined : (await listWorktrees(repo).catch(() => [])).find((w) => w.branch === c.name && w.path !== repo.root);
    if (!isCurrent) {
      add('Checkout', () => checkout(repo, c.name, s));
      if (wt) add('Open Worktree…', () => openFolder(wt.path, 'new'), wt.path);
    }
    add(`New Branch from ${qn}…`, async () => {
      if ((await newBranch(repo, c.name, { back: true })) === 'back') reopen();
    });
    if (!isCurrent) {
      if (!detached && !wt) add(`Checkout and Rebase onto ${qc}`, () => checkoutAndRebase(repo, c.name));
      if (c.ref?.upstream && !wt) add('Checkout and Update', () => checkoutAndUpdate(repo, c.name), `Checkout ${c.name}, fetch its tracked branch ${c.ref?.upstream}, and update it in one step`);
      items.push(sep());
      add(`Compare with ${qc}`, () => invoke('jbGit.compare.withCurrent', compareArgs));
      add('Show Diff with Working Tree', () => vscode.commands.executeCommand('jbGit.compare.withWorkingTree', compareArgs));
      items.push(sep());
      if (!detached) add(`Rebase ${qc} onto ${qn}`, () => invoke('jbGit.rebase', compareArgs));
      add(`Merge ${qn} into ${qc}`, () => invoke('jbGit.merge', compareArgs));
    } else {
      items.push(sep());
      add('Show Diff with Working Tree', () => vscode.commands.executeCommand('jbGit.compare.withWorkingTree', compareArgs));
    }
    items.push(sep());
    add(`New Worktree from ${qn}…`, () => newWorktree(repo, c.name));
    items.push(sep());
    if (s.remotes.length && (c.ref?.upstream || isCurrent)) add('Update', () => updateBranch(repo, c.name, s), wt ? `Branch cannot be updated, as it is checked out in worktree ${wt.path}` : undefined);
    add('Push…', () => (isCurrent ? invoke('jbGit.push', { repoRoot: repo.root }) : vscode.commands.executeCommand('jbGit.sync.pushBranch', { repoRoot: repo.root, branch: c.name })));
    const up = c.ref?.upstream;
    if (up && s.refs.some((r) => r.type === 'remote' && r.short === up)) {
      add(`Tracked Branch ${q(up)}`, () => showBranchActions(ctx, repo, up, reopen), '$(chevron-right)');
    }
    items.push(sep());
    add('Rename…', () => renameBranch(repo, c.name));
    if (!isCurrent) add('Delete', () => deleteLocalBranch(repo, c.name, s));
  } else if (c.kind === 'remote') {
    add('Checkout', () => checkout(repo, c.name, s));
    add(`New Branch from ${qn}…`, async () => {
      if ((await newBranch(repo, c.name, { back: true })) === 'back') reopen();
    });
    if (!detached) add(`Checkout and Rebase onto ${qc}`, () => checkoutAndRebase(repo, c.name));
    items.push(sep());
    add(`Compare with ${qc}`, () => invoke('jbGit.compare.withCurrent', compareArgs));
    add('Show Diff with Working Tree', () => vscode.commands.executeCommand('jbGit.compare.withWorkingTree', compareArgs));
    items.push(sep());
    if (!detached) add(`Rebase ${qc} onto ${qn}`, () => invoke('jbGit.rebase', compareArgs));
    add(`Merge ${qn} into ${qc}`, () => invoke('jbGit.merge', compareArgs));
    items.push(sep());
    add(`New Worktree from ${qn}…`, () => newWorktree(repo, c.name));
    items.push(sep());
    add(`Pull into ${qc} Using Rebase`, () => pullInto(repo, c.name, true));
    add(`Pull into ${qc} Using Merge`, () => pullInto(repo, c.name, false));
    items.push(sep());
    add('Delete', () => deleteRemoteBranch(repo, c.name, s));
  } else {
    // tag or plain revision
    add('Checkout', () => checkout(repo, c.name, s));
    add(`New Branch from ${qn}…`, async () => {
      if ((await newBranch(repo, c.name, { back: true })) === 'back') reopen();
    });
    items.push(sep());
    add(`Compare with ${qc}`, () => invoke('jbGit.compare.withCurrent', compareArgs));
    add('Show Diff with Working Tree', () => vscode.commands.executeCommand('jbGit.compare.withWorkingTree', compareArgs));
    items.push(sep());
    if (!detached && c.kind === 'revision') add(`Rebase ${qc} onto ${qn}`, () => invoke('jbGit.rebase', compareArgs));
    add(`Merge ${qn} into ${qc}`, () => invoke('jbGit.merge', compareArgs));
    items.push(sep());
    add(`New Worktree from ${qn}…`, () => newWorktree(repo, c.name));
    if (c.kind === 'tag') {
      if (s.remotes.length) {
        items.push(sep());
        if (s.remotes.length === 1) add('Push Tag', () => pushTag(repo, c.name, s.remotes[0]), `Push to ${s.remotes[0]}`);
        else for (const r of s.remotes) add(`Push to ${r}`, () => pushTag(repo, c.name, r));
      }
      items.push(sep());
      add('Delete', () => deleteTag(repo, c.name));
    }
  }
  // drop leading/trailing/double separators
  const clean: ActionItem[] = [];
  for (const it of items) {
    if (it.kind === vscode.QuickPickItemKind.Separator && (!clean.length || clean[clean.length - 1].kind === vscode.QuickPickItemKind.Separator)) continue;
    clean.push(it);
  }
  while (clean.length && clean[clean.length - 1].kind === vscode.QuickPickItemKind.Separator) clean.pop();
  const title =
    c.kind === 'tag' ? `Tag ${q(c.name)}` : c.kind === 'revision' ? `Revision ${qn}` : `Branch ${q(c.name)}${c.kind === 'remote' ? '' : isCurrent ? ' (current)' : ''}`;
  return { title, items: clean };
}

const FAV_ON: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon('star-full'), tooltip: 'Mark/Unmark As Favorite' };
const FAV_OFF: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon('star-empty'), tooltip: 'Mark/Unmark As Favorite' };

/** Shows the action list of `ref`. `back` (when opened from the popup) adds a Back button that reopens it. */
export async function showBranchActions(ctx: Ctx, repo: Repository, ref: string, back?: () => void): Promise<void> {
  const s = await loadState(repo);
  const c = classify(s, ref);
  if (c.kind === 'revision') {
    const v = await repo.run(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { quiet: true, allowFail: true });
    if (v.code !== 0) {
      vscode.window.showErrorMessage(`Revision not found: ${ref}`);
      return;
    }
  }
  const reopen = () => showBranchActions(ctx, repo, ref, back);
  const { title, items } = await buildActions(ctx, s, ref, reopen);
  const qp = vscode.window.createQuickPick<ActionItem>();
  qp.title = title + (ctx.repos.all.length > 1 ? ` in ${repo.name}` : '');
  qp.placeholder = c.ref ? [c.ref.subject, c.kind === 'local' && c.ref.upstream ? `tracks ${c.ref.upstream}` : ''].filter(Boolean).join('  ·  ') : undefined;
  qp.items = items;
  const favButton = () => (c.ref && c.kind !== 'tag' ? [isFav(ctx, repo, c.ref.name) ? FAV_ON : FAV_OFF] : []);
  qp.buttons = [...(back ? [vscode.QuickInputButtons.Back] : []), ...favButton()];
  qp.onDidTriggerButton(async (b) => {
    if (b === vscode.QuickInputButtons.Back) {
      qp.hide();
      back?.();
    } else if (c.ref) {
      await toggleFav(ctx, repo, c.ref.name);
      qp.buttons = [...(back ? [vscode.QuickInputButtons.Back] : []), ...favButton()];
    }
  });
  qp.onDidAccept(() => {
    const it = qp.selectedItems[0];
    qp.hide();
    Promise.resolve(it?.run?.()).catch((e) => showGitError(e));
  });
  qp.onDidHide(() => qp.dispose());
  qp.show();
}
