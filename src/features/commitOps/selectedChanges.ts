// "Drop Selected Changes" and "Extract Selected Changes to Separate Commit…" of the Log's changed-files menu
// (IntelliJ Git.Drop.Selected.Changes / Git.InMemory.Extract.Selected.Changes) for one non-merge commit of the
// current branch. Extract is in memory (no working tree changes); drop rewrites the commit in memory and replays
// the later commits onto it with `git rebase -i --onto --autostash`, since their trees change.
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { FeatureContext } from '../../core/context';
import type { CommitsArgs } from '../../core/contracts';
import type { Repository } from '../../core/repository';
import {
  checkInHead,
  checkNotProtected,
  checkState,
  fullMessage,
  loadCommits,
  messagesOf,
  moveHead,
  objectGit,
  OpError,
  pushedWarning,
  rangeToHead,
  repoOf,
  reportError,
  short,
} from './common';
import { editMessage } from './dialogs';
import { parentsText, validator } from './edit';
import { dropChangesCommit, extractChangesInMemory, splitCommit, SplitError, type CommitSplit } from './inmemory';
import { offerUndo, runRebase } from './rewrite';
import { cleanMessage } from './todo';

/** Args of gitPrism.commitOps.dropSelectedChanges / gitPrism.commitOps.extractSelectedChanges. */
export interface SelectedChangesArgs {
  repoRoot: string;
  /** full hash of the commit */
  hash: string;
  /** repo-relative paths of the selected changes (both sides of a rename) */
  paths: string[];
}

/**
 * The Log webview reaches commitOps through its generic `commitOp` request, which only forwards hashes:
 * gitPrism.commit.dropSelectedChanges / extractSelectedChanges take `hashes = [commit, ...paths]`.
 */
export function fromCommitsArgs(a: CommitsArgs | undefined): SelectedChangesArgs | undefined {
  const [hash, ...paths] = a?.hashes ?? [];
  return a && hash ? { repoRoot: a.repoRoot, hash, paths } : undefined;
}

async function prepare(ctx: FeatureContext, args: SelectedChangesArgs | undefined, op: string): Promise<{ repo: Repository; hash: string; paths: string[] } | undefined> {
  const repo = await repoOf(ctx, args ? { repoRoot: args.repoRoot, hashes: [] } : undefined);
  if (!repo) return undefined;
  const paths = [...new Set((args?.paths ?? []).filter(Boolean))];
  if (!args?.hash || !paths.length) {
    vscode.window.showWarningMessage('No changes selected.');
    return undefined;
  }
  checkState(repo, op);
  return { repo, hash: args.hash, paths };
}

/** IntelliJ GitSingleCommitEditingAction checks: in the current branch, not a merge, not pushed to a protected branch. */
async function checkCommit(repo: Repository, hash: string) {
  const head = await checkInHead(repo, [hash]);
  const [commit] = await loadCommits(repo, [hash]);
  if (!commit) throw new OpError(`Commit ${short(hash)} not found`);
  if (commit.parents.length > 1) throw new OpError(parentsText(hash, commit.parents.length, true));
  await checkNotProtected(repo, hash);
  return { head, commit };
}

async function split(repo: Repository, hash: string, paths: string[], allSelected: string): Promise<CommitSplit> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitprism-split-'));
  try {
    const s = await splitCommit(objectGit(repo), hash, paths, path.join(dir, 'index'));
    if (s.remaining === s.parentTree) throw new OpError(allSelected);
    if (s.remaining === s.tree) throw new OpError('The selected changes are not part of the commit');
    return s;
  } catch (e) {
    throw e instanceof SplitError ? new OpError(e.message) : e;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ---------- Drop Selected Changes ----------

export async function dropSelectedChanges(ctx: FeatureContext, args: SelectedChangesArgs | undefined): Promise<void> {
  const title = 'Could Not Drop Selected Changes';
  try {
    const p = await prepare(ctx, args, 'drop selected changes');
    if (!p) return;
    const { repo, hash, paths } = p;
    const { head } = await checkCommit(repo, hash);
    // the later commits are replayed by a rebase: like IntelliJ's squash, this needs a linear history up to HEAD
    const range = await rangeToHead(repo, hash);
    if (range.merges.length) throw new OpError(parentsText(range.merges[0].hash, range.merges[0].parents.length, false));
    const later = range.commits.filter((c) => c.hash !== hash);
    const s = await split(repo, hash, paths, 'Unable to drop all changes from the commit');
    const rewritten = await dropChangesCommit(objectGit(repo), s);
    const msgs = later.length ? await messagesOf(repo, ['--no-walk=unsorted', ...later.map((c) => c.hash)]) : new Map<string, string>();
    await runRebase(repo, {
      root: false,
      oldest: hash,
      entries: later.map((c) => ({ hash: c.hash, action: 'pick', message: msgs.get(c.hash) ?? c.subject })),
      onto: { commit: rewritten, upstream: hash },
      expectedHead: head,
      progressTitle: 'Dropping changes…',
      successTitle: 'Changes dropped',
      failureTitle: 'Failed to drop selected changes',
      undo: { progress: 'Undoing drop changes…', notAllowed: 'Cannot undo drop changes', failed: 'Undo drop changes failed' },
    });
  } catch (e) {
    await reportError(e, title);
  }
}

// ---------- Extract Selected Changes to Separate Commit… ----------

export async function extractSelectedChanges(ctx: FeatureContext, args: SelectedChangesArgs | undefined): Promise<void> {
  const title = 'Could Not Extract Selected Changes';
  try {
    const p = await prepare(ctx, args, 'extract selected changes');
    if (!p) return;
    const { repo, hash, paths } = p;
    const { head, commit } = await checkCommit(repo, hash);
    const s = await split(repo, hash, paths, 'Unable to extract all changes from the commit');
    const edited = await editMessage(
      ctx,
      {
        title: 'New Commit Message',
        label: `Changes extracted from commit ${short(hash)} by ${commit.author}`,
        message: await fullMessage(repo, hash),
        okLabel: 'OK',
        warning: await pushedWarning(repo, hash),
      },
      validator(repo, head, hash, 1),
    );
    if (edited === undefined) return;
    const message = cleanMessage(edited);
    if (!message) throw new OpError('Commit message is empty');
    if ((await repo.headHash()) !== head) throw new OpError('Cannot edit selected commit: repository state was changed');
    try {
      await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Extracting changes…' }, async () => {
        const res = await extractChangesInMemory(objectGit(repo), hash, head, s, message);
        await moveHead(repo, res.head, head, `extract changes from ${short(hash)}`);
      });
    } catch (e) {
      await reportError(e, 'Failed to extract selected changes');
      return;
    }
    const newHead = await repo.headHash();
    if (newHead) {
      offerUndo(repo, 'Changes extracted', head, newHead, {
        progress: 'Undoing extract changes…',
        notAllowed: 'Cannot undo extract changes',
        failed: 'Undo extract changes failed',
        soft: true,
      });
    }
  } catch (e) {
    await reportError(e, title);
  }
}
