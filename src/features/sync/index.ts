// Remote sync & history-moving dialogs: Push…, Pull…, Fetch, Update Project…, Merge…, Rebase…, Reset HEAD….
// Implements the contract commands gitPrism.push / pull / fetch / updateProject / merge / rebase / resetHead, plus
// gitPrism.sync.pushBranch { repoRoot, branch } (Push… of a non-current local branch from the branch popup / log tree).
import * as vscode from 'vscode';
import type { FeatureContext } from '../../core/context';
import { implement } from '../../core/contracts';
import { fetch } from './fetch';
import { merge } from './merge';
import { pull } from './pull';
import { push } from './push';
import { rebase } from './rebase';
import { resetHead } from './reset';
import { updateProject } from './update';

export function activate(ctx: FeatureContext): void {
  ctx.extension.subscriptions.push(
    implement('gitPrism.push', (a) => push(ctx, a)),
    vscode.commands.registerCommand('gitPrism.sync.pushBranch', (a?: { repoRoot?: string; branch?: string }) => push(ctx, { repoRoot: a?.repoRoot, branch: a?.branch })),
    implement('gitPrism.pull', (a) => pull(ctx, a)),
    implement('gitPrism.fetch', (a) => fetch(ctx, a)),
    implement('gitPrism.updateProject', (a) => updateProject(ctx, a)),
    implement('gitPrism.merge', (a) => merge(ctx, a)),
    implement('gitPrism.rebase', (a) => rebase(ctx, a)),
    implement('gitPrism.resetHead', (a) => resetHead(ctx, a)),
  );
}
