// Diff & merge windows: implements gitPrism.diff.show (IntelliJ diff editor tab) and gitPrism.conflicts.mergeFile
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
    implement('gitPrism.diff.show', (req) => DiffPanel.show(ctx, req)),
    implement('gitPrism.conflicts.mergeFile', (args) => mergeFile(ctx, args)),
    trackers,
    vscode.commands.registerCommand('gitPrism.diff.nextChange', () => trackers.navigate('next')),
    vscode.commands.registerCommand('gitPrism.diff.previousChange', () => trackers.navigate('previous')),
    vscode.commands.registerCommand('gitPrism.diff.changeUnderCaret', () => trackers.navigate('current')),
    vscode.commands.registerCommand('gitPrism.diff.rollbackChange', (arg) => trackers.rollback(arg)),
    vscode.commands.registerCommand('gitPrism.diff.showChangeDiff', (arg) => trackers.showDiff(arg)),
    vscode.commands.registerCommand('gitPrism.diff.copyChange', (arg) => trackers.copy(arg)),
  );
}
