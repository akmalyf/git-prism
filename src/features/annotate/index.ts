// Annotate (git blame) feature: the annotation column with its hover and line operations, annotation view
// options (persisted in gitPrism.annotate.* settings) and the changed-lines actions (Rollback Lines, Show Diff for Lines).
import * as vscode from 'vscode';
import type { FeatureContext } from '../../core/context';
import { invoke } from '../../core/contracts';
import { isUncommitted } from './blame';
import { Annotator, RevisionContentProvider, type LineArg, type LineTarget } from './annotator';
import { LineActions } from './lineActions';
import { OWN_SCHEME, REV_SCHEMES } from './target';

/** Boolean view/option settings toggled from the annotation gutter menu. */
const TOGGLES: Record<string, string> = {
  'gitPrism.annotate.view.revision': 'showRevision',
  'gitPrism.annotate.view.date': 'showDate',
  'gitPrism.annotate.view.author': 'showAuthor',
  'gitPrism.annotate.view.subject': 'showSubject',
  'gitPrism.annotate.option.ignoreWhitespaces': 'ignoreWhitespaces',
  'gitPrism.annotate.option.commitTimestamp': 'preferCommitTimestamp',
};

const NAMES = ['initials', 'lastName', 'firstName', 'fullName', 'email'];
const COLORS = ['order', 'author', 'hide'];

function setting(key: string, value: unknown): Thenable<void> {
  return vscode.workspace.getConfiguration('gitPrism.annotate').update(key, value, vscode.ConfigurationTarget.Global);
}

export function activate(ctx: FeatureContext): void {
  const annotator = new Annotator(ctx);
  const lines = new LineActions(ctx);
  const sub = ctx.extension.subscriptions;
  const reg = (id: string, fn: (...args: any[]) => unknown) => sub.push(vscode.commands.registerCommand(id, fn));

  /** Runs `fn` on the annotated line of a command argument; tells the user when there is none. */
  const onLine = (fn: (t: LineTarget) => unknown) => (arg?: LineArg) => {
    const t = annotator.resolveLine(arg);
    if (!t) {
      vscode.window.setStatusBarMessage('No annotation for this line. Use "Annotate with Git Blame" first.', 3000);
      return;
    }
    return fn(t);
  };
  const committed = (fn: (t: LineTarget, hash: string) => unknown) =>
    onLine((t) => {
      if (!t.commit || isUncommitted(t.commit.hash)) {
        vscode.window.setStatusBarMessage('The line is not committed yet.', 3000);
        return;
      }
      return fn(t, t.commit.hash);
    });

  sub.push(
    annotator,
    vscode.workspace.registerTextDocumentContentProvider(OWN_SCHEME, new RevisionContentProvider(ctx)),
    vscode.languages.registerHoverProvider(
      [{ scheme: 'file' }, ...REV_SCHEMES.map((scheme) => ({ scheme }))],
      { provideHover: (doc, pos) => annotator.hover(doc, pos) },
    ),
  );

  const uriArg = (a: unknown): vscode.Uri | undefined =>
    a instanceof vscode.Uri ? a : a && typeof a === 'object' && (a as { uri?: unknown }).uri instanceof vscode.Uri ? ((a as { uri: vscode.Uri }).uri) : undefined;

  reg('gitPrism.annotate.toggle', (a?: unknown) => annotator.toggle(uriArg(a)));
  reg('gitPrism.annotate.close', (a?: unknown) => annotator.close(uriArg(a)));
  reg('gitPrism.annotate.revision', (a: { repoRoot: string; path: string; rev: string }) => annotator.annotateRevision(a));
  reg('gitPrism.annotate.showCommitInLog', committed((t, hash) => invoke('gitPrism.log.show', { repoRoot: t.a.repo.root, revision: hash })));
  reg('gitPrism.annotate.copyRevision', committed((_t, hash) => vscode.env.clipboard.writeText(hash)));
  reg('gitPrism.annotate.currentRevision', committed((t, hash) => annotator.currentRevision(t, hash)));
  reg('gitPrism.annotate.previousRevision', onLine((t) => annotator.previousRevision(t)));
  reg('gitPrism.annotate.previous', onLine((t) => annotator.previousRevision(t)));
  reg('gitPrism.annotate.showDiff', onLine((t) => annotator.showDiff(t)));
  reg('gitPrism.annotate.showAffectedFiles', committed((t) => annotator.showAffectedFiles(t)));

  for (const [id, key] of Object.entries(TOGGLES)) {
    reg(id, () => setting(key, !vscode.workspace.getConfiguration('gitPrism.annotate').get<boolean>(key)));
  }
  // IntelliJ's movement options are one setting: "within file" (-M) is implied by "across files" (-C)
  const movements = () => vscode.workspace.getConfiguration('gitPrism.annotate').get<string>('detectMovements', 'none');
  reg('gitPrism.annotate.option.detectWithinFile', () => setting('detectMovements', movements() === 'none' ? 'inner' : 'none'));
  reg('gitPrism.annotate.option.detectAcrossFiles', () => setting('detectMovements', movements() === 'outer' ? 'inner' : 'outer'));
  for (const n of NAMES) reg(`gitPrism.annotate.names.${n}`, () => setting('names', n));
  for (const c of COLORS) reg(`gitPrism.annotate.colors.${c}`, () => setting('colors', c));

  reg('gitPrism.rollbackLines', (a?: unknown) => lines.rollback(a as never));
  reg('gitPrism.showDiffForLines', (a?: unknown) => lines.showDiff(a as never));
  reg('gitPrism.copyHunkOriginal', (a?: unknown) => lines.copyOriginal(a as never));
}
