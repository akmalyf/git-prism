// Diff & merge windows: implements jbGit.diff.show (IntelliJ diff editor tab) and jbGit.conflicts.mergeFile
// (3-way merge of one conflicted file); plus the editor line status markers with Next/Previous Change.
import * as vscode from 'vscode';
import type { FeatureContext } from '../../core/context';
import { implement } from '../../core/contracts';
import { DiffPanel } from './diffPanel';
import { mergeFile } from './mergePanel';
import { LineStatusTrackers } from './tracker';

export function activate(ctx: FeatureContext): void {
  const trackers = new LineStatusTrackers(ctx);
  ctx.extension.subscriptions.push(
    implement('jbGit.diff.show', (req) => DiffPanel.show(ctx, req)),
    implement('jbGit.conflicts.mergeFile', (args) => mergeFile(ctx, args)),
    trackers,
    vscode.commands.registerCommand('jbGit.diff.nextChange', () => trackers.navigate('next')),
    vscode.commands.registerCommand('jbGit.diff.previousChange', () => trackers.navigate('previous')),
    vscode.commands.registerCommand('jbGit.diff.changeUnderCaret', () => trackers.navigate('current')),
    vscode.commands.registerCommand('jbGit.diff.rollbackChange', (arg) => trackers.rollback(arg)),
    vscode.commands.registerCommand('jbGit.diff.showChangeDiff', (arg) => trackers.showDiff(arg)),
    vscode.commands.registerCommand('jbGit.diff.copyChange', (arg) => trackers.copy(arg)),
  );
}
