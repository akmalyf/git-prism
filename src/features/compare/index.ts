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
    implement('jbGit.changes.show', (a) => showChanges(ctx, a)),
    implement('jbGit.compare.withCurrent', (a) => compareWithCurrent(ctx, a)),
    implement('jbGit.repoAtRevision', (a) => showRepoAtRevision(ctx, a)),
    implement('jbGit.compare.fileWithRevision', (a) => compareFileWithRevision(ctx, a)),
    implement('jbGit.openFileAtRevision', (a) =>
      openFileAtRevision(ctx.repos, a).catch((e) => showGitError(e, 'Cannot open file at revision')),
    ),
    reg('jbGit.compare.withWorkingTree', (a?: { repoRoot?: string; ref?: string }) => compareWithWorkingTree(ctx, a ?? {})),
    reg('jbGit.showDiffWithHead', (uri?: unknown, uris?: unknown) => showDiffWithHead(ctx, uri, uris)),
    reg('jbGit.compareWithRevision', (uri?: unknown) => compareWithRevision(ctx, uri)),
    reg('jbGit.compareWithBranch', (uri?: unknown) => compareWithBranch(ctx, uri)),
    reg('jbGit.compareWithLatest', (uri?: unknown) => compareWithLatest(ctx, uri)),
    reg('jbGit.showHistory', (uri?: unknown, uris?: unknown) => showFileHistory(ctx, uri, uris)),
    reg('jbGit.compare.showCurrentRevision', (uri?: unknown) => showCurrentRevision(ctx, uri)),
    reg('jbGit.showHistoryForSelection', (uri?: unknown, uris?: unknown) => showHistoryForSelection(ctx, uri, uris)),
  );
}
