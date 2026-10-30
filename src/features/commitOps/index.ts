// Commit operations of the Git Log context menu (gitPrism.commit.* contract commands except gitPrism.commit.focus):
// checkout, reset, revert, cherry-pick, undo, reword, fixup/squash into, squash, drop, interactive rebase,
// push up to, new branch/tag, create patch, copy revision number; plus Drop Selected Changes / Extract Selected
// Changes to Separate Commit… of the Log's changed-files menu (extra commands gitPrism.commitOps.*).
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
    implement('gitPrism.commit.checkoutRevision', (a) => checkoutRevision(ctx, a)),
    implement('gitPrism.commit.resetToHere', (a) => hashesOf(a) && invoke('gitPrism.resetHead', { repoRoot: a.repoRoot, target: a.hashes[0] })),
    implement('gitPrism.commit.revert', (a) => revert(ctx, a)),
    implement('gitPrism.commit.cherryPick', (a) => cherryPick(ctx, a)),
    implement('gitPrism.commit.undo', (a) => undoCommit(ctx, a)),
    implement('gitPrism.commit.reword', (a) => reword(ctx, a)),
    implement('gitPrism.commit.fixup', (a) => prepareFixup(ctx, a, 'fixup')),
    implement('gitPrism.commit.squashInto', (a) => prepareFixup(ctx, a, 'squash')),
    implement('gitPrism.commit.squash', (a) => squash(ctx, a)),
    implement('gitPrism.commit.drop', (a) => drop(ctx, a)),
    implement('gitPrism.commit.interactiveRebase', (a) => interactiveRebase(ctx, a)),
    implement('gitPrism.commit.pushUpTo', (a) => hashesOf(a) && invoke('gitPrism.push', { repoRoot: a.repoRoot, upTo: a.hashes[0] })),
    implement('gitPrism.commit.newBranch', (a) => hashesOf(a) && invoke('gitPrism.branch.new', { repoRoot: a.repoRoot, ref: a.hashes[0] })),
    implement('gitPrism.commit.newTag', (a) => hashesOf(a) && invoke('gitPrism.tag.new', { repoRoot: a.repoRoot, ref: a.hashes[0] })),
    implement('gitPrism.commit.createPatch', (a) => createPatch(ctx, a)),
    implement('gitPrism.commit.copyHash', (a) => copyHash(a)),
    vscode.commands.registerCommand('gitPrism.commitOps.dropSelectedChanges', (a?: SelectedChangesArgs) => dropSelectedChanges(ctx, a)),
    vscode.commands.registerCommand('gitPrism.commitOps.extractSelectedChanges', (a?: SelectedChangesArgs) => extractSelectedChanges(ctx, a)),
    // the Log webview's `commitOp` request maps op → gitPrism.commit.<op> with { repoRoot, hashes: [hash, ...paths] }
    vscode.commands.registerCommand('gitPrism.commit.dropSelectedChanges', (a?: CommitsArgs) => dropSelectedChanges(ctx, fromCommitsArgs(a))),
    vscode.commands.registerCommand('gitPrism.commit.extractSelectedChanges', (a?: CommitsArgs) => extractSelectedChanges(ctx, fromCommitsArgs(a))),
  );
}
