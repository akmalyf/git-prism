// Commit operations of the Git Log context menu (jbGit.commit.* contract commands except jbGit.commit.focus):
// checkout, reset, revert, cherry-pick, undo, reword, fixup/squash into, squash, drop, interactive rebase,
// push up to, new branch/tag, create patch, copy revision number; plus Drop Selected Changes / Extract Selected
// Changes to Separate Commit… of the Log's changed-files menu (extra commands jbGit.commitOps.*).
import * as vscode from 'vscode';
import type { FeatureContext } from '../../core/context';
import { implement, invoke, type CommitsArgs } from '../../core/contracts';
import { checkoutRevision, cherryPick, copyHash, createPatch, revert } from './apply';
import { hashesOf } from './common';
import { drop, prepareFixup, reword, squash, undoCommit } from './edit';
import { interactiveRebase } from './rebasePanel';
import { dropSelectedChanges, extractSelectedChanges, fromCommitsArgs, type SelectedChangesArgs } from './selectedChanges';

export function activate(ctx: FeatureContext): void {
  ctx.extension.subscriptions.push(
    implement('jbGit.commit.checkoutRevision', (a) => checkoutRevision(ctx, a)),
    implement('jbGit.commit.resetToHere', (a) => hashesOf(a) && invoke('jbGit.resetHead', { repoRoot: a.repoRoot, target: a.hashes[0] })),
    implement('jbGit.commit.revert', (a) => revert(ctx, a)),
    implement('jbGit.commit.cherryPick', (a) => cherryPick(ctx, a)),
    implement('jbGit.commit.undo', (a) => undoCommit(ctx, a)),
    implement('jbGit.commit.reword', (a) => reword(ctx, a)),
    implement('jbGit.commit.fixup', (a) => prepareFixup(ctx, a, 'fixup')),
    implement('jbGit.commit.squashInto', (a) => prepareFixup(ctx, a, 'squash')),
    implement('jbGit.commit.squash', (a) => squash(ctx, a)),
    implement('jbGit.commit.drop', (a) => drop(ctx, a)),
    implement('jbGit.commit.interactiveRebase', (a) => interactiveRebase(ctx, a)),
    implement('jbGit.commit.pushUpTo', (a) => hashesOf(a) && invoke('jbGit.push', { repoRoot: a.repoRoot, upTo: a.hashes[0] })),
    implement('jbGit.commit.newBranch', (a) => hashesOf(a) && invoke('jbGit.branch.new', { repoRoot: a.repoRoot, ref: a.hashes[0] })),
    implement('jbGit.commit.newTag', (a) => hashesOf(a) && invoke('jbGit.tag.new', { repoRoot: a.repoRoot, ref: a.hashes[0] })),
    implement('jbGit.commit.createPatch', (a) => createPatch(ctx, a)),
    implement('jbGit.commit.copyHash', (a) => copyHash(a)),
    vscode.commands.registerCommand('jbGit.commitOps.dropSelectedChanges', (a?: SelectedChangesArgs) => dropSelectedChanges(ctx, a)),
    vscode.commands.registerCommand('jbGit.commitOps.extractSelectedChanges', (a?: SelectedChangesArgs) => extractSelectedChanges(ctx, a)),
    // the Log webview's `commitOp` request maps op → jbGit.commit.<op> with { repoRoot, hashes: [hash, ...paths] }
    vscode.commands.registerCommand('jbGit.commit.dropSelectedChanges', (a?: CommitsArgs) => dropSelectedChanges(ctx, fromCommitsArgs(a))),
    vscode.commands.registerCommand('jbGit.commit.extractSelectedChanges', (a?: CommitsArgs) => extractSelectedChanges(ctx, fromCommitsArgs(a))),
  );
}
