// Non-rewriting commit operations of the Git Log context menu: Checkout Revision (with Smart Checkout),
// Cherry-Pick and Revert Commit (git sequencer; conflicts handed to the conflicts feature), Create Patch, Copy Revision Number.
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { FeatureContext } from '../../core/context';
import { invoke, type CommitsArgs } from '../../core/contracts';
import type { Repository } from '../../core/repository';
import type { Commit } from '../../core/types';
import {
  checkState,
  hashesOf,
  loadCommits,
  OpError,
  protectedBranchContaining,
  repoOf,
  reportError,
  short,
  stashMessage,
  unmergedFiles,
} from './common';
import { smartOperationDialog } from './dialogs';
import { commits as nCommits, parseOverwrittenFiles } from './todo';

// ---------- Checkout Revision ----------

export async function checkoutRevision(ctx: FeatureContext, args: CommitsArgs): Promise<void> {
  const repo = await repoOf(ctx, args);
  const hashes = hashesOf(args);
  if (!repo || !hashes) return;
  const hash = hashes[0];
  const title = `Could not checkout ${short(hash)}`;
  try {
    const r = await withCheckoutProgress(() => repo.exec(['checkout', '--detach', hash], { allowFail: true }));
    if (r.code === 0) return checkedOut(hash);
    const over = parseOverwrittenFiles(r.stderr);
    if (!over) throw new Error(r.stderr.trim() || r.stdout.trim());
    if (over.kind === 'untracked') {
      await vscode.window.showErrorMessage('Untracked Files Preventing Checkout', {
        modal: true,
        detail: `These untracked files will be overwritten by checkout:\n${listFiles(over.files)}\n\nMove or commit them before checkout.`,
      });
      return;
    }
    const choice = await smartOperationDialog(ctx, repo.root, {
      title: 'Git Checkout Problem',
      text: [
        'Your local changes to the following files would be overwritten by checkout.',
        `${vscode.env.appName} can stash the changes, checkout and unstash them after that.`,
      ],
      files: over.files,
      smartLabel: 'Smart Checkout',
      smartTooltip: 'Stash local changes, checkout, unstash',
      forceLabel: 'Force Checkout',
      dontLabel: "Don't Checkout",
    });
    if (choice === 'force') {
      await withCheckoutProgress(() => repo.exec(['checkout', '--force', '--detach', hash]));
      return checkedOut(hash);
    }
    if (choice === 'smart') await smartCheckout(repo, hash);
  } catch (e) {
    await reportError(e, title);
  }
}

function withCheckoutProgress<T>(fn: () => Thenable<T>): Thenable<T> {
  return vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Checking out…' }, fn);
}

function checkedOut(hash: string): void {
  vscode.window.showInformationMessage(`Checked out ${short(hash)}`);
}

function listFiles(files: string[]): string {
  return files.slice(0, 15).join('\n') + (files.length > 15 ? `\n… and ${files.length - 15} more` : '');
}

async function smartCheckout(repo: Repository, hash: string): Promise<void> {
  await withCheckoutProgress(async () => {
    const before = (await repo.run(['rev-parse', '-q', '--verify', 'refs/stash'], { allowFail: true, quiet: true })).stdout.trim();
    await repo.exec(['stash', 'push', '-m', stashMessage('Checkout')]);
    const after = (await repo.run(['rev-parse', '-q', '--verify', 'refs/stash'], { allowFail: true, quiet: true })).stdout.trim();
    const stashed = !!after && after !== before;
    const co = await repo.exec(['checkout', '--detach', hash], { allowFail: true });
    if (stashed) await unstash(repo, 'checkout');
    if (co.code !== 0) throw new Error(co.stderr.trim() || co.stdout.trim());
  });
  checkedOut(hash);
}

/** `git stash pop` after a smart operation; conflicts → notification with "Resolve Conflicts…". */
async function unstash(repo: Repository, op: string): Promise<void> {
  const pop = await repo.exec(['stash', 'pop', '--index'], { allowFail: true });
  if (pop.code === 0) return;
  let retry = pop;
  // --index fails when the index can't be restored; retry without it (only when nothing was merged yet)
  if (!(await unmergedFiles(repo)).length && /could not restore|conflicts in index|Index was not unstashed/i.test(pop.stderr)) {
    retry = await repo.exec(['stash', 'pop'], { allowFail: true });
    if (retry.code === 0) return;
  }
  if ((await unmergedFiles(repo)).length) {
    void invoke('jbGit.conflicts.resolve', { repoRoot: repo.root });
    const resolve = 'Resolve…';
    const pick = await vscode.window.showWarningMessage(
      `Your uncommitted changes were saved to stash. Unstash after ${op} is not complete, you have unresolved merges in your working tree. Resolve conflicts and drop the stash.`,
      resolve,
    );
    if (pick === resolve) invoke('jbGit.conflicts.resolve', { repoRoot: repo.root });
    return;
  }
  const view = 'View Stash…';
  const pick = await vscode.window.showErrorMessage(`Before ${op} your uncommitted changes were saved to stash. ${retry.stderr.trim()}`, view);
  if (pick === view) invoke('jbGit.stash.unstash', { repoRoot: repo.root });
}

// ---------- Cherry-Pick / Revert ----------

type ApplyKind = 'cherry-pick' | 'revert';
const NAMES: Record<ApplyKind, { title: string; op: string; past: string; abort: string; progress: string; head: string }> = {
  'cherry-pick': { title: 'Cherry-pick', op: 'cherry-pick', past: 'applied', abort: 'Abort Cherry-Pick', progress: 'Cherry-Picking', head: 'CHERRY_PICK_HEAD' },
  revert: { title: 'Revert', op: 'revert', past: 'reverted', abort: 'Abort Revert', progress: 'Reverting', head: 'REVERT_HEAD' },
};

export async function cherryPick(ctx: FeatureContext, args: CommitsArgs): Promise<void> {
  await applyCommits(ctx, args, 'cherry-pick');
}

export async function revert(ctx: FeatureContext, args: CommitsArgs): Promise<void> {
  await applyCommits(ctx, args, 'revert');
}

/** "a1b2c3d4 subject" lines (GitApplyChangesProcess.commitDetails) */
const details = (cs: Commit[]) => cs.map((c) => `${short(c.hash)} ${c.subject}`).join('\n');

async function applyCommits(ctx: FeatureContext, args: CommitsArgs, kind: ApplyKind, retry?: { only: string[] }): Promise<boolean> {
  const repo = await repoOf(ctx, args);
  const hashes = hashesOf(args);
  if (!repo || !hashes) return false;
  const n = NAMES[kind];
  try {
    checkState(repo, n.op);
    if (fs.existsSync(path.join(repo.gitDir, 'sequencer'))) throw new OpError(`There is an unfinished ${n.op} process in ${repo.name}.`);
    if ((await unmergedFiles(repo)).length) throw new OpError('There are unresolved conflicts in the working tree.');
    const selected = await loadCommits(repo, hashes);
    // cherry-pick applies oldest first, revert newest first (selection is newest first, like the log)
    let ordered = kind === 'cherry-pick' ? [...selected].reverse() : selected;
    if (retry) ordered = ordered.filter((c) => retry.only.includes(c.hash));
    if (!ordered.length) return true;
    const flags: string[] = [];
    // -m 1 is accepted for non-merge commits too, so a mixed selection works
    if (ordered.some((c) => c.parents.length > 1)) flags.push('-m', '1');
    if (kind === 'cherry-pick' && (await needsSuffix(repo, ordered.map((c) => c.hash)))) flags.push('-x');
    if (kind === 'revert') flags.push('--no-edit');
    const title = ordered.length === 1 ? `${n.progress} '${ordered[0].subject}'` : n.progress;
    const start = await repo.headHash();

    const skipped: Commit[] = [];
    const r = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title }, async () => {
      let res = await repo.exec([kind, ...flags, ...ordered.map((c) => c.hash)], { allowFail: true });
      // empty commits (changes already applied) are skipped like IntelliJ does ("Skip commit" setting)
      while (res.code !== 0 && isEmptyStop(repo, `${res.stdout}\n${res.stderr}`, kind)) {
        const stopped = (await repo.run(['rev-parse', '-q', '--verify', n.head], { allowFail: true, quiet: true })).stdout.trim();
        const c = ordered.find((x) => x.hash === stopped);
        if (c) skipped.push(c);
        res = await repo.exec([kind, '--skip'], { allowFail: true });
      }
      return res;
    });
    // commits created so far + skipped ones = the processed prefix of `ordered`
    const created = start
      ? +(await repo.run(['rev-list', '--count', `${start}..HEAD`], { quiet: true, allowFail: true })).stdout.trim() || 0
      : +(await repo.run(['rev-list', '--count', 'HEAD'], { quiet: true, allowFail: true })).stdout.trim() || 0;
    const processed = ordered.slice(0, Math.min(ordered.length, created + skipped.length));
    const successful = processed.filter((c) => !skipped.includes(c));
    const successPart = successful.length ? `\nHowever, ${n.op} succeeded for the following ${successful.length === 1 ? 'commit' : 'commits'}:\n${details(successful)}` : '';

    const out = `${r.stdout}\n${r.stderr}`;
    if (r.code === 0) {
      notifyApplied(n, successful, skipped);
      return true;
    }
    const over = parseOverwrittenFiles(r.stderr);
    if (over || /local changes would be overwritten|commit your changes or stash them/i.test(out)) {
      // git keeps a sequencer for the remaining commits without stopping on one: forget it, the applied commits stay
      const remaining = ordered.slice(processed.length);
      await quitSequencer(repo, kind);
      if (over?.kind === 'untracked') {
        const view = 'View Them';
        const pick = await vscode.window.showErrorMessage(
          `Untracked Files Prevent ${n.title}: Move or commit them before ${n.op}: ${over.files.slice(0, 10).join(', ')}${over.files.length > 10 ? ', …' : ''}${successPart}`,
          view,
        );
        if (pick === view) showFileList(`Untracked Files Preventing ${n.title}`, `These untracked files will be overwritten by ${n.op}`, over.files);
        return false;
      }
      if (retry) throw new Error(r.stderr.trim() || r.stdout.trim());
      const save = 'Stash Changes and Retry';
      const view = 'View Them';
      const pick = await vscode.window.showErrorMessage(
        `${n.title} failed: Your local changes will be overwritten by ${n.op}. Commit, stash, or revert them to proceed.${successPart}`,
        save,
        ...(over ? [view] : []),
      );
      if (pick === save) await stashAndRetry(ctx, repo, args, kind, remaining.map((c) => c.hash));
      else if (pick === view && over) showFileList(`Local Changes Prevent from ${n.title}`, `Your local changes would be overwritten by ${n.op}`, over.files);
      return false;
    }
    const state = repo.operationState();
    if (state === kind || (await unmergedFiles(repo)).length) {
      const stopped = ordered[processed.length] ?? ordered[ordered.length - 1];
      // IntelliJ opens the conflict resolver right away
      void invoke('jbGit.conflicts.resolve', { repoRoot: repo.root });
      const resolve = 'Resolve…';
      const msg = `${n.title} was performed with conflicts: ${short(stopped.hash)} ${stopped.subject}. There are unresolved conflicts in the working tree.${successPart}`;
      const pick = await vscode.window.showWarningMessage(msg, resolve, n.abort);
      if (pick === resolve) invoke('jbGit.conflicts.resolve', { repoRoot: repo.root });
      else if (pick === n.abort) invoke('jbGit.operation.abort', { repoRoot: repo.root });
      return false;
    }
    await quitSequencer(repo, kind);
    throw new Error(`${details(ordered.slice(processed.length, processed.length + 1))}\n${r.stderr.trim() || r.stdout.trim()}${successPart}`);
  } catch (e) {
    await reportError(e, `${n.title} failed`);
    return false;
  }
}

function notifyApplied(n: (typeof NAMES)[ApplyKind], successful: Commit[], skipped: Commit[]): void {
  const skippedHashes = skipped.map((c) => short(c.hash)).join(', ');
  if (!skipped.length) {
    vscode.window.showInformationMessage(`${n.title} successful: ${details(successful)}`);
  } else if (successful.length) {
    const applied = n.past[0].toUpperCase() + n.past.slice(1);
    vscode.window.showInformationMessage(
      `${applied} ${successful.length} ${successful.length === 1 ? 'commit' : 'commits'} from ${successful.length + skipped.length}: ${details(successful)}. ` +
        `${skippedHashes} ${skipped.length === 1 ? 'was' : 'were'} skipped, because all changes have already been ${n.past}.`,
    );
  } else {
    vscode.window.showInformationMessage(`Nothing to ${n.op}: All changes from ${skippedHashes} have already been ${n.past}`);
  }
}

async function quitSequencer(repo: Repository, kind: ApplyKind): Promise<void> {
  if (repo.operationState() === kind) return;
  if (fs.existsSync(path.join(repo.gitDir, 'sequencer'))) await repo.exec([kind, '--quit'], { allowFail: true });
}

function showFileList(title: string, text: string, files: string[]): void {
  void vscode.window.showWarningMessage(title, { modal: true, detail: `${text}:\n${listFiles(files)}` });
}

function isEmptyStop(repo: Repository, out: string, kind: ApplyKind): boolean {
  if (repo.operationState() !== kind) return false;
  return /is now empty|nothing to commit|nothing added to commit/i.test(out);
}

async function stashAndRetry(ctx: FeatureContext, repo: Repository, args: CommitsArgs, kind: ApplyKind, remaining: string[]): Promise<void> {
  const before = (await repo.run(['rev-parse', '-q', '--verify', 'refs/stash'], { allowFail: true, quiet: true })).stdout.trim();
  try {
    await repo.exec(['stash', 'push', '-m', stashMessage(NAMES[kind].title)]);
  } catch (e) {
    return reportError(e, 'Could not stash local uncommitted changes');
  }
  const after = (await repo.run(['rev-parse', '-q', '--verify', 'refs/stash'], { allowFail: true, quiet: true })).stdout.trim();
  const ok = await applyCommits(ctx, args, kind, { only: remaining });
  if (!after || after === before) return;
  if (ok && repo.operationState() === 'none' && !(await unmergedFiles(repo)).length) {
    await unstash(repo, NAMES[kind].op);
  } else {
    const view = 'View Stash…';
    const pick = await vscode.window.showInformationMessage(`Restore local changes: Local changes were saved before ${NAMES[kind].op}`, view);
    if (pick === view) invoke('jbGit.stash.unstash', { repoRoot: repo.root });
  }
}

/** jbGit.cherryPick.addSuffix: -x for commits pushed to a protected branch (IntelliJ setting text). */
async function needsSuffix(repo: Repository, hashes: string[]): Promise<boolean> {
  if (!vscode.workspace.getConfiguration('jbGit').get<boolean>('cherryPick.addSuffix', false)) return false;
  for (const h of hashes) if (await protectedBranchContaining(repo, h)) return true;
  return false;
}

// ---------- Create Patch / Copy Revision Number ----------

export async function createPatch(ctx: FeatureContext, args: CommitsArgs): Promise<void> {
  const repo = await repoOf(ctx, args);
  const hashes = hashesOf(args);
  if (!repo || !hashes) return;
  try {
    const save = 'Save Patch to File…';
    const copy = 'Copy Patch to Clipboard';
    const pick = await vscode.window.showInformationMessage(
      'Create Patch',
      { modal: true, detail: `Create a patch from ${hashes.length === 1 ? `commit ${short(hashes[0])}` : nCommits(hashes.length)} in ${repo.name}.` },
      save,
      copy,
    );
    if (!pick) return;
    const patch = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Creating Patch…' }, () => buildPatch(repo, hashes));
    if (pick === copy) {
      await vscode.env.clipboard.writeText(patch.toString('utf8'));
      vscode.window.showInformationMessage('Patch copied to clipboard');
      return;
    }
    const [first] = await loadCommits(repo, [hashes[hashes.length - 1]]);
    const name = (first?.subject ?? '').replace(/[^\p{L}\p{N}._-]+/gu, '_').replace(/^[_.]+|_+$/g, '').slice(0, 60) || short(hashes[0]);
    const uri = await vscode.window.showSaveDialog({
      title: 'Save Patch File',
      defaultUri: vscode.Uri.file(repo.abs(`${name}.patch`)),
      filters: { 'Patch Files': ['patch', 'diff'], 'All Files': ['*'] },
    });
    if (!uri) return;
    await vscode.workspace.fs.writeFile(uri, patch);
    const open = 'Open';
    if ((await vscode.window.showInformationMessage(`Patch saved to ${uri.fsPath}`, open)) === open) vscode.window.showTextDocument(uri);
  } catch (e) {
    await reportError(e, 'Patch Creation Failed');
  }
}

/** format-patch of every commit, oldest first (the selection comes newest first in log order); merges as their diff to the first parent. */
async function buildPatch(repo: Repository, hashes: string[]): Promise<Buffer> {
  const byHash = new Map((await loadCommits(repo, hashes)).map((c) => [c.hash, c]));
  const parts: Buffer[] = [];
  for (const h of [...hashes].reverse()) {
    const c = byHash.get(h);
    if (!c) continue;
    if (c.parents.length > 1) {
      // format-patch skips merges: email header + the diff against the first parent
      const head = (await repo.buffer(['log', '-1', '--format=email', c.hash], { quiet: true })).toString('utf8').replace(/\n*$/, '\n');
      const diff = await repo.buffer(['diff', '--binary', '--no-color', '--no-ext-diff', '--stat', '-p', `${c.hash}^1`, c.hash], { quiet: true });
      parts.push(Buffer.from(`${head}---\n`, 'utf8'), diff);
    } else {
      parts.push(await repo.buffer(['format-patch', '-1', '--stdout', '--binary', '--no-color', '--no-signature', c.hash], { quiet: true }));
    }
  }
  const patch = Buffer.concat(parts);
  if (!patch.toString('utf8').trim()) throw new OpError('The selected commits contain no changes');
  return patch;
}

/** IntelliJ's Copy Revision Number: hashes from old to new, separated by spaces (handy for a terminal). */
export async function copyHash(args: CommitsArgs): Promise<void> {
  const hashes = hashesOf(args);
  if (!hashes) return;
  await vscode.env.clipboard.writeText([...hashes].reverse().join(' '));
}
