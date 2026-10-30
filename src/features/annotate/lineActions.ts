// Actions on the changed lines under the cursor/selection (IntelliJ's gutter change popup): Rollback Lines,
// Show Diff for Lines and copying the original lines. Changes are computed against the HEAD version.
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { FeatureContext } from '../../core/context';
import { invoke, type ContentRef } from '../../core/contracts';
import { showGitError } from '../../core/git';
import type { Repository } from '../../core/repository';
import { diffLines, hunksTouching, rollbackEdits, type Hunk } from './hunks';

interface Changes {
  editor: vscode.TextEditor;
  repo: Repository;
  path: string;
  /** base lines ('\n'-split), empty for a file that isn't in HEAD yet */
  base: string[];
  cur: string[];
  baseRef: ContentRef;
  hunks: Hunk[];
  /** hunks touching the selections */
  touched: Hunk[];
}

/** Arg from the line number gutter context menu ({lineNumber: 1-based, uri}) or none (active editor). */
type GutterArg = { lineNumber?: number; uri?: vscode.Uri } | vscode.Uri | undefined;

export class LineActions {
  constructor(private readonly ctx: FeatureContext) {}

  private async changes(arg: GutterArg): Promise<Changes | undefined> {
    const uri = arg instanceof vscode.Uri ? arg : arg?.uri;
    const active = vscode.window.activeTextEditor;
    const editor = !uri || active?.document.uri.toString() === uri.toString()
      ? active
      : vscode.window.visibleTextEditors.find((e) => e.document.uri.toString() === uri.toString());
    if (!editor) return undefined;
    const doc = editor.document;
    if (doc.uri.scheme !== 'file') {
      vscode.window.showInformationMessage('Only files under Git version control have line changes.');
      return undefined;
    }
    await this.ctx.repos.ready();
    const repo = this.ctx.repos.forUri(doc.uri) ?? (await this.ctx.repos.open(path.dirname(doc.uri.fsPath)));
    if (!repo) {
      vscode.window.showInformationMessage('The file is not under Git version control.');
      return undefined;
    }
    const rel = repo.rel(doc.uri.fsPath);
    let baseText: string | undefined;
    let baseRef: ContentRef;
    try {
      const head = await repo.headHash();
      const bytes = head ? await repo.show(head, rel) : undefined;
      if (bytes) {
        baseText = bytes.toString('utf8').replace(/^﻿/, '');
        baseRef = { rev: 'HEAD', path: rel };
      } else {
        // not in HEAD (new file or empty repository): tracked files are entirely added, untracked ones have no changes
        const tracked = await repo.run(['--literal-pathspecs', 'ls-files', '--error-unmatch', '--', rel], { quiet: true, allowFail: true });
        if (tracked.code !== 0) {
          vscode.window.showInformationMessage(`'${rel}' is not under Git version control.`);
          return undefined;
        }
        baseText = undefined;
        baseRef = { empty: true };
      }
    } catch (e) {
      showGitError(e, 'Cannot load previous revision');
      return undefined;
    }
    const base = baseText === undefined ? [] : baseText.split(/\r\n|\r|\n/);
    const cur: string[] = [];
    for (let i = 0; i < doc.lineCount; i++) cur.push(doc.lineAt(i).text);
    // an empty base text is one empty line; a missing file has none
    const hunks = baseText === undefined ? (doc.getText() ? [{ baseStart: 0, baseEnd: 0, start: 0, end: cur.length }] : []) : diffLines(base, cur);
    const sels = arg && !(arg instanceof vscode.Uri) && arg.lineNumber !== undefined
      ? [{ from: arg.lineNumber - 1, to: arg.lineNumber - 1 }]
      : editor.selections.map((s) => ({ from: s.start.line, to: s.end.line > s.start.line && s.end.character === 0 ? s.end.line - 1 : s.end.line }));
    const touched = new Set<Hunk>();
    for (const s of sels) for (const h of hunksTouching(hunks, s.from, s.to)) touched.add(h);
    return { editor, repo, path: rel, base, cur, baseRef, hunks, touched: hunks.filter((h) => touched.has(h)) };
  }

  /** Rollback Lines: reverts the changes touching the selection in the editor buffer (one undo step). */
  async rollback(arg?: GutterArg): Promise<void> {
    const c = await this.changes(arg);
    if (!c) return;
    if (!c.touched.length) {
      vscode.window.setStatusBarMessage('No changes in the selected lines', 3000);
      return;
    }
    const doc = c.editor.document;
    const eol = doc.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n';
    // a file that is not in HEAD has one hunk covering everything, so it rolls back to empty
    const edits = rollbackEdits(c.cur, c.base, c.touched, eol);
    const ok = await c.editor.edit((b) => {
      for (const e of edits) b.replace(new vscode.Range(e.startLine, e.startChar, e.endLine, e.endChar), e.text);
    });
    if (!ok) vscode.window.showErrorMessage('Rollback Lines failed: the document could not be edited.');
  }

  /** Show Diff for Lines: the file's diff against HEAD, positioned at the first touched change. */
  async showDiff(arg?: GutterArg): Promise<void> {
    const c = await this.changes(arg);
    if (!c) return;
    const doc = c.editor.document;
    const right: ContentRef = doc.isDirty ? { text: doc.getText(), label: 'Your version' } : { worktree: true, path: c.path };
    const first = c.touched[0] ?? c.hunks[0];
    const req = {
      files: [{ repoRoot: c.repo.root, path: c.path, kind: 'empty' in c.baseRef ? ('A' as const) : ('M' as const), left: c.baseRef, right }],
      // extra hint (not part of the contract yet): the line of the current version to scroll to
      line: first ? first.start : c.editor.selection.active.line,
    };
    try {
      await invoke('gitPrism.diff.show', req);
    } catch (e) {
      showGitError(e, 'Cannot show diff');
    }
  }

  /** Copies the original (HEAD) text of the changes touching the selection. */
  async copyOriginal(arg?: GutterArg): Promise<void> {
    const c = await this.changes(arg);
    if (!c) return;
    if (!c.touched.length) {
      vscode.window.setStatusBarMessage('No changes in the selected lines', 3000);
      return;
    }
    const eol = c.editor.document.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n';
    const text = c.touched.map((h) => c.base.slice(h.baseStart, h.baseEnd).join(eol)).filter(Boolean).join(eol);
    await vscode.env.clipboard.writeText(text);
  }
}
