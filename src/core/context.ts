// What every feature module receives in activate(). See src/extension.ts.
import type * as vscode from 'vscode';
import type { RepositoryManager } from './repository';

export interface FeatureContext {
  extension: vscode.ExtensionContext;
  repos: RepositoryManager;
}

/** Each src/features/<name>/index.ts exports `activate(ctx)`; push disposables to ctx.extension.subscriptions. */
export type Feature = { activate(ctx: FeatureContext): void | Promise<void> };
