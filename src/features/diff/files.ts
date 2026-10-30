// Reading and writing working tree files for the diff/merge windows, keeping open VS Code editors in sync.
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { encode, type TextMeta } from './content';

/** Bytes of a working tree file (link target for symlinks); undefined when it doesn't exist. */
export async function readWorktree(abs: string): Promise<{ bytes: Buffer; symlink: boolean } | undefined> {
  try {
    const st = await fsp.lstat(abs);
    if (st.isSymbolicLink()) return { bytes: Buffer.from(await fsp.readlink(abs), 'utf8'), symlink: true };
    if (!st.isFile()) return undefined;
    return { bytes: await fsp.readFile(abs), symlink: false };
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT' || (e as NodeJS.ErrnoException).code === 'ENOTDIR') return undefined;
    throw e;
  }
}

export async function worktreeSize(abs: string): Promise<number | undefined> {
  try {
    const st = await fsp.lstat(abs);
    return st.isFile() ? st.size : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Writes `text` ('\n' line endings) to a working tree file in its encoding/line separator. When the file is open
 * in VS Code the document is edited and saved instead, so the editor doesn't end up with a stale or conflicting buffer.
 */
export async function writeWorktree(abs: string, text: string, meta: TextMeta): Promise<void> {
  const doc = vscode.workspace.textDocuments.find((d) => d.uri.scheme === 'file' && d.uri.fsPath === abs);
  if (doc) {
    const edit = new vscode.WorkspaceEdit();
    edit.replace(doc.uri, new vscode.Range(0, 0, doc.lineCount, 0), text);
    if (await vscode.workspace.applyEdit(edit)) {
      if (await doc.save()) return;
    }
  }
  await fsp.mkdir(path.dirname(abs), { recursive: true });
  await fsp.writeFile(abs, encode(text, meta));
}

/** Opens a text file in an editor with the caret at `line` (0-based, clamped). */
export async function openDocument(uri: vscode.Uri, line: number, viewColumn?: vscode.ViewColumn): Promise<void> {
  const doc = await vscode.workspace.openTextDocument(uri);
  const pos = new vscode.Position(Math.max(0, Math.min(line, doc.lineCount - 1)), 0);
  await vscode.window.showTextDocument(doc, { selection: new vscode.Range(pos, pos), viewColumn, preview: false });
}
