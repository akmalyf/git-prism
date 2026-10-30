// Compare & History feature: Git submenu diff/history commands, the Changes browser, branch compare,
// Show History for Selection, Show Repository at Revision and read-only file-at-revision documents.
import * as vscode from 'vscode';
import { implement } from '../../core/contracts';
import type { FeatureContext } from '../../core/context';
import { showGitError } from '../../core/git';
import { showChanges } from './changesPanel';
import { compareWithCurrent, compareWithWorkingTree } from './comparePanel';
import { compareFileWithRevision, compareWithBranch, compareWithLatest, compareWithRevision, showCurrentRevision, showDiffWithHead, showFileHistory } from './fileCommands';
import { showHistoryForSelection } from './historySelection';
import { showRepoAtRevision } from './repoAtRevision';
import { openFileAtRevision, RevisionContentProvider } from './revision';
import { REV_SCHEME } from './util';

export function activate(ctx: FeatureContext): void {
  const reg = (id: string, fn: (...a: any[]) => unknown) => vscode.commands.registerCommand(id, fn);
  ctx.extension.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(REV_SCHEME, new RevisionContentProvider(ctx.repos)),
    implement('gitPrism.changes.show', (a) => showChanges(ctx, a)),
    implement('gitPrism.compare.withCurrent', (a) => compareWithCurrent(ctx, a)),
    implement('gitPrism.repoAtRevision', (a) => showRepoAtRevision(ctx, a)),
    implement('gitPrism.compare.fileWithRevision', (a) => compareFileWithRevision(ctx, a)),
    implement('gitPrism.openFileAtRevision', (a) =>
      openFileAtRevision(ctx.repos, a).catch((e) => showGitError(e, 'Cannot open file at revision')),
    ),
    reg('gitPrism.compare.withWorkingTree', (a?: { repoRoot?: string; ref?: string }) => compareWithWorkingTree(ctx, a ?? {})),
    reg('gitPrism.showDiffWithHead', (uri?: unknown, uris?: unknown) => showDiffWithHead(ctx, uri, uris)),
    reg('gitPrism.compareWithRevision', (uri?: unknown) => compareWithRevision(ctx, uri)),
    reg('gitPrism.compareWithBranch', (uri?: unknown) => compareWithBranch(ctx, uri)),
    reg('gitPrism.compareWithLatest', (uri?: unknown) => compareWithLatest(ctx, uri)),
    reg('gitPrism.showHistory', (uri?: unknown, uris?: unknown) => showFileHistory(ctx, uri, uris)),
    reg('gitPrism.compare.showCurrentRevision', (uri?: unknown) => showCurrentRevision(ctx, uri)),
    reg('gitPrism.showHistoryForSelection', (uri?: unknown, uris?: unknown) => showHistoryForSelection(ctx, uri, uris)),
  );
}
