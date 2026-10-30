// History-editing commit operations of the Git Log context menu: Undo Commit…, Edit Commit Message…,
// Squash Commits…, Drop Commits, Fixup… / Squash Into… (prepare a "fixup!"/"squash!" commit in the Commit view).
// Like IntelliJ, rewording and squashing consecutive commits happen in memory (no working tree changes);
// everything else is a scripted `git rebase -i` (rewrite.ts).
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { FeatureContext } from '../../core/context';
import { invoke, type CommitsArgs } from '../../core/contracts';
import type { Repository } from '../../core/repository';
import {
  checkInHead,
  checkNotProtected,
  checkState,
  confirmInitialCommit,
  fullMessage,
  hashesOf,
  loadCommits,
  messagesOf,
  moveHead,
  objectGit,
  OpError,
  protectedBranchContaining,
  pushedWarning,
  rangeToHead,
  repoOf,
  reportError,
  short,
} from './common';
import { editMessage } from './dialogs';
import { rewordInMemory, squashChainInMemory } from './inmemory';
import { isConsecutiveChain } from './objects';
import { offerUndo, runRebase, type UndoTexts } from './rewrite';
import { cleanMessage, commits as nCommits, planDrop, planSquash, prettySquash, prohibitedStateMessage, subjectOf } from './todo';

/** Runs `fn` with a resolved repository and hashes; pre-check failures and git errors become notifications. */
async function guarded(ctx: FeatureContext, args: CommitsArgs, title: string, fn: (repo: Repository, hashes: string[]) => Promise<void>): Promise<void> {
  const repo = await repoOf(ctx, args);
  const hashes = hashesOf(args);
  if (!repo || !hashes) return;
  try {
    await fn(repo, hashes);
  } catch (e) {
    await reportError(e, title);
  }
}

export const parentsText = (h: string, n: number, single: boolean) => (single ? `Selected commit has ${n} parents` : `Commit ${short(h)} has ${n} parents`);

function single(hashes: string[]): string {
  if (hashes.length !== 1) throw new OpError('Select a single commit');
  return hashes[0];
}

/**
 * Multiple-commit editing checks (IntelliJ checkHeadLinearHistory + protected branch): the commits from the oldest
 * selected one to HEAD must be a linear history without merge or root commits.
 */
async function editableRange(repo: Repository, hashes: string[], op: string) {
  checkState(repo, op);
  const head = await checkInHead(repo, hashes);
  const selected = await loadCommits(repo, hashes);
  for (const c of selected) {
    if (c.parents.length !== 1) throw new OpError(parentsText(c.hash, c.parents.length, hashes.length === 1));
  }
  const all = await rangeToHead(repo, await oldestOf(repo, hashes));
  if (all.merges.length) throw new OpError(parentsText(all.merges[0].hash, all.merges[0].parents.length, false));
  const msgs = await messagesOf(repo, ['--no-walk=unsorted', ...all.commits.map((c) => c.hash)]);
  const plan = all.commits.map((c) => ({ hash: c.hash, message: msgs.get(c.hash) ?? c.subject, parents: c.parents }));
  await checkNotProtected(repo, plan[0].hash);
  return { head, selected, plan, root: all.root, oldest: plan[0].hash };
}

async function oldestOf(repo: Repository, hashes: string[]): Promise<string> {
  if (hashes.length === 1) return hashes[0];
  // the commit that is an ancestor of every other selected one (walk from the end: selection is newest first)
  for (const h of [...hashes].reverse()) {
    let ok = true;
    for (const o of hashes) {
      if (o === h) continue;
      if ((await repo.run(['merge-base', '--is-ancestor', h, o], { allowFail: true, quiet: true })).code !== 0) {
        ok = false;
        break;
      }
    }
    if (ok) return h;
  }
  return hashes[hashes.length - 1];
}

const changedMessage = 'Cannot edit selected commit: repository state was changed';

/** Re-checks on OK of the message dialog (GitNewCommitMessageActionDialog.validateCommitsEditable). */
export function validator(repo: Repository, head: string, oldest: string, n: number) {
  return async (): Promise<string | undefined> => {
    if ((await repo.headHash()) !== head) return n === 1 ? changedMessage : 'Cannot edit selected commits: repository state was changed';
    const prot = await protectedBranchContaining(repo, oldest);
    if (prot) return `Cannot edit selected ${n === 1 ? 'commit' : 'commits'}: commit ${short(oldest)} was pushed to protected branch '${prot}'`;
    return undefined;
  };
}

const REWORD_UNDO: UndoTexts = { progress: 'Undoing reword…', notAllowed: 'Cannot undo commit message edit', failed: 'Undo commit message edit failed', soft: true };

// ---------- Undo Commit ----------

export function undoCommit(ctx: FeatureContext, args: CommitsArgs): Promise<void> {
  return guarded(ctx, args, 'Cannot Undo Commit', async (repo, hashes) => {
    const hash = single(hashes);
    const state = repo.operationState();
    // undoing the commit while stopped in a rebase (to split it) is fine; other operations are not
    if (state !== 'none' && state !== 'rebase') throw new OpError(prohibitedStateMessage(state, 'undo commit') ?? 'Cannot undo commit');
    const head = await repo.headHash();
    if (!head) throw new OpError('The repository has no commits yet');
    if (hash !== head) throw new OpError('The selected commit is not the last in the current branch');
    const [commit] = await loadCommits(repo, [hash]);
    if (commit.parents.length > 1) throw new OpError(parentsText(hash, commit.parents.length, true));
    await checkNotProtected(repo, hash);
    if (!commit.parents.length && !(await confirmInitialCommit())) return;
    const message = await fullMessage(repo, hash);
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Undoing Last Commit…' }, async () => {
      // the initial commit: the branch becomes unborn again, the files stay staged
      if (!commit.parents.length) await repo.exec(['update-ref', '-m', 'undo commit', '-d', 'HEAD', head]);
      else await repo.exec(['reset', '--soft', commit.parents[0]]);
    });
    vscode.window.showInformationMessage('Undo commit successful');
    // IntelliJ puts the undone commit's message into the commit message field
    void invoke('jbGit.commit.focus', { repoRoot: repo.root, message });
  });
}

// ---------- Edit Commit Message ----------

export function reword(ctx: FeatureContext, args: CommitsArgs): Promise<void> {
  return guarded(ctx, args, 'Could not Edit Commit Message', async (repo, hashes) => {
    const hash = single(hashes);
    const head = await repo.headHash();
    const isHead = hash === head;
    const state = repo.operationState();
    // amending HEAD is allowed while stopped in a rebase (GitRewordAction.getProhibitedStateMessage)
    if (!(state === 'rebase' && isHead)) checkState(repo, 'reword');
    await checkInHead(repo, [hash]);
    const [commit] = await loadCommits(repo, [hash]);
    // a merge commit can only be reworded when it is HEAD (amend)
    if (!isHead && commit.parents.length > 1) throw new OpError(parentsText(hash, commit.parents.length, true));
    await checkNotProtected(repo, hash);
    if (!commit.parents.length && !(await confirmInitialCommit())) return;
    const original = await fullMessage(repo, hash);
    const edited = await editMessage(
      ctx,
      {
        title: 'Edit Commit Message',
        label: `Edit message for commit ${short(hash)} by ${commit.author}`,
        message: original,
        okLabel: 'OK',
        warning: await pushedWarning(repo, hash),
      },
      validator(repo, head!, hash, 1),
    );
    if (edited === undefined || cleanMessage(edited) === cleanMessage(original)) return;
    const message = cleanMessage(edited);
    if (!message) throw new OpError('Commit message is empty');
    if ((await repo.headHash()) !== head) throw new OpError(changedMessage);
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Rewording…' }, async () => {
      if (isHead) await amendMessage(repo, message);
      else await moveHead(repo, await rewordInMemory(objectGit(repo), hash, head!, message), head!, `reword ${short(hash)}`);
    });
    const newHead = await repo.headHash();
    if (newHead) offerUndo(repo, 'Commit message changed', head!, newHead, REWORD_UNDO);
  });
}

async function amendMessage(repo: Repository, message: string): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jbgit-reword-'));
  const file = path.join(dir, 'COMMIT_MSG');
  fs.writeFileSync(file, message + '\n', 'utf8');
  try {
    // --only without paths: staged changes are not added to the amended commit
    await repo.exec(['commit', '--amend', '--only', '--allow-empty', '--no-verify', '--cleanup=verbatim', '-F', file]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ---------- Squash Commits ----------

export function squash(ctx: FeatureContext, args: CommitsArgs): Promise<void> {
  return guarded(ctx, args, 'Could not Squash Commits', async (repo, hashes) => {
    if (hashes.length < 2) throw new OpError('Select at least two commits to squash');
    const r = await editableRange(repo, hashes, 'squash');
    const set = new Set(hashes);
    const selected = r.plan.filter((c) => set.has(c.hash));
    const message = await editMessage(
      ctx,
      {
        title: 'Squashed Commit Message',
        label: 'Edit message for squashed commit',
        message: prettySquash(selected.map((c) => c.message)),
        okLabel: 'OK',
        warning: await pushedWarning(repo, r.oldest),
      },
      validator(repo, r.head, r.oldest, hashes.length),
    );
    if (message === undefined) return;
    if (!cleanMessage(message)) throw new OpError('Commit message is empty');
    const undo: UndoTexts = { progress: 'Undoing squash…', notAllowed: 'Cannot Undo Squash', failed: 'Undo Squash Failed' };
    if (isConsecutiveChain(selected)) {
      // in memory: the final tree is unchanged, so neither the working tree nor the index are touched
      if ((await repo.headHash()) !== r.head) throw new OpError(changedMessage);
      await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Squashing…' }, async () => {
        const newHead = await squashChainInMemory(objectGit(repo), selected.map((c) => c.hash), r.head, cleanMessage(message));
        await moveHead(repo, newHead, r.head, 'squash');
      });
      const newHead = await repo.headHash();
      if (newHead) offerUndo(repo, 'Commits Squashed', r.head, newHead, { ...undo, soft: true });
      return;
    }
    await runRebase(repo, {
      root: r.root,
      oldest: r.oldest,
      entries: planSquash(r.plan, hashes, message),
      expectedHead: r.head,
      progressTitle: 'Squashing…',
      successTitle: 'Commits Squashed',
      failureTitle: 'Could not Squash Commits',
      undo,
    });
  });
}

// ---------- Drop Commits ----------

export function drop(ctx: FeatureContext, args: CommitsArgs): Promise<void> {
  return guarded(ctx, args, 'Could not Drop Commits', async (repo, hashes) => {
    const r = await editableRange(repo, hashes, 'drop');
    const n = hashes.length;
    const cfg = vscode.workspace.getConfiguration('jbGit');
    if (cfg.get<boolean>('commitOps.showDropCommitDialog', true)) {
      const branch = await repo.currentBranch();
      const ok = 'OK';
      const dontAsk = "OK, Don't Ask Again";
      const detail = branch
        ? `Do you want to drop ${nCommits(n)} from the ${branch} branch?`
        : `The repository is in the detached HEAD state. Do you want to drop ${nCommits(n)}?`;
      const pick = await vscode.window.showWarningMessage(n === 1 ? 'Drop Commit' : 'Drop Commits', { modal: true, detail }, ok, dontAsk);
      if (!pick) return;
      if (pick === dontAsk) await cfg.update('commitOps.showDropCommitDialog', false, vscode.ConfigurationTarget.Global);
    }
    const subjects = r.selected.slice(0, 10).map((c) => `"${c.subject.length > 40 ? c.subject.slice(0, 39) + '…' : c.subject}"`);
    if (r.selected.length > 10) subjects.push('...');
    await runRebase(repo, {
      root: r.root,
      oldest: r.oldest,
      entries: planDrop(r.plan, hashes),
      expectedHead: r.head,
      progressTitle: n === 1 ? 'Dropping commit…' : 'Dropping commits…',
      successTitle: `Dropped ${nCommits(n)}: ${subjects.join(', ')}`,
      failureTitle: 'Could not Drop Commits',
      undo: { progress: 'Undoing drop…', notAllowed: 'Cannot undo drop', failed: 'Undo drop failed' },
    });
  });
}

// ---------- Fixup… / Squash Into… ----------

/** Fixup… / Squash Into…: opens the Commit view with "fixup! <subject>" / "squash! <subject>" for the local changes. */
export function prepareFixup(ctx: FeatureContext, args: CommitsArgs, kind: 'fixup' | 'squash'): Promise<void> {
  const title = kind === 'fixup' ? 'Cannot Create Fixup Commit' : 'Cannot Create Squash Commit';
  return guarded(ctx, args, title, async (repo, hashes) => {
    const hash = single(hashes);
    await checkInHead(repo, [hash]);
    const [commit] = await loadCommits(repo, [hash]);
    if (commit.parents.length > 1) throw new OpError(parentsText(hash, commit.parents.length, true));
    await checkNotProtected(repo, hash);
    const status = await repo.status();
    if (!status.entries.some((e) => e.kind !== '?' && e.kind !== '!')) {
      vscode.window.showInformationMessage('Nothing to Commit: No changes detected');
      return;
    }
    const subject = subjectOf(await fullMessage(repo, hash));
    await invoke('jbGit.commit.focus', { repoRoot: repo.root, message: `${kind}! ${subject}` });
  });
}
