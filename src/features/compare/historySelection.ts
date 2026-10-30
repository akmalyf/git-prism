// "Show History for Selection" (Vcs.ShowHistoryForBlock): `git log -L<start>,<end>:<path>` for the selected lines,
// shown in the 'history-selection' webview (revisions table, block diff vs the parent, commit message) plus a
// "Local Changes" row when the working copy of the block differs from HEAD.
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { invoke } from '../../core/contracts';
import type { FeatureContext } from '../../core/context';
import { showGitError } from '../../core/git';
import type { Repository } from '../../core/repository';
import { RpcBridge, webviewHtml, webviewOptions } from '../../core/webview';
import { blockTexts, LINE_LOG_FORMAT, mapRangeToOld, parseHunkHeaders, parseLineLog, type BlockRevision } from './parse';
import type { BlockRevisionView, HistorySelectionInit } from './protocol';
import { baseName, targets } from './util';

function lines(text: string): string[] {
  const l = text.split(/\r?\n/);
  if (l.length > 1 && l[l.length - 1] === '') l.pop();
  return l;
}

/** Options for every `git log -L` run: fixed a/ b/ prefixes (diff.noprefix / mnemonicPrefix would break parsing). */
const LINE_LOG_ARGS = ['log', LINE_LOG_FORMAT, '--no-color', '--no-ext-diff', '--no-textconv', '--no-show-signature', '--src-prefix=a/', '--dst-prefix=b/'];

/** `git diff --no-index -U0` of two texts through temp files (no objects are written to the repository). */
async function diffTexts(repo: Repository, before: string, after: string): Promise<string> {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'jbgit-sel-'));
  try {
    const a = path.join(dir, 'a');
    const b = path.join(dir, 'b');
    await Promise.all([fs.promises.writeFile(a, before), fs.promises.writeFile(b, after)]);
    const r = await repo.run(['diff', '--no-index', '-U0', '--no-color', '--no-ext-diff', '--no-textconv', '--', a, b], { quiet: true, allowFail: true });
    if (r.code > 1) throw new Error(r.stderr.trim() || 'git diff failed');
    return r.stdout;
  } finally {
    fs.promises.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function loadBlockHistory(repo: Repository, rel: string, doc: vscode.TextDocument, start: number, end: number, rev?: string): Promise<BlockRevisionView[]> {
  if (rev) {
    // a read-only revision document: its lines are the lines of `rev`
    const out = await repo.run([...LINE_LOG_ARGS, `-L${start},${end}:${rel}`, rev, '--'], { quiet: true });
    return parseLineLog(out.stdout).map((r) => toView(r, rel));
  }
  const headBuf = await repo.show('HEAD', rel);
  const docLines = lines(doc.getText());
  const localBlock = docLines.slice(start - 1, end).join('\n');
  const res: BlockRevisionView[] = [];
  if (!headBuf) {
    // not committed yet: the whole block is a local change
    return [{ hash: '', author: '', authorEmail: '', date: Date.now() / 1000, subject: 'Local Changes', body: '', path: rel, before: '', after: localBlock, local: true }];
  }
  const headLines = lines(headBuf.toString('utf8'));
  // map the selection (document lines, possibly unsaved) to HEAD's lines
  const diff = await diffTexts(repo, headLines.join('\n') + '\n', docLines.join('\n') + '\n');
  const mapped = mapRangeToOld(parseHunkHeaders(diff), start, end);
  const headBlock = mapped ? headLines.slice(mapped.start - 1, mapped.end).join('\n') : '';
  if (headBlock !== localBlock) {
    res.push({ hash: '', parent: (await repo.headHash()) ?? 'HEAD', author: '', authorEmail: '', date: Date.now() / 1000, subject: 'Local Changes', body: '', path: rel, oldPath: rel, before: headBlock, after: localBlock, local: true });
  }
  if (!mapped || !headLines.length) return res;
  const s = Math.min(mapped.start, headLines.length);
  const e = Math.min(Math.max(mapped.end, s), headLines.length);
  const out = await repo.run([...LINE_LOG_ARGS, `-L${s},${e}:${rel}`, 'HEAD', '--'], { quiet: true });
  for (const r of parseLineLog(out.stdout)) res.push(toView(r, rel));
  return res;
}

function toView(r: BlockRevision, rel: string): BlockRevisionView {
  const t = blockTexts(r.hunks);
  return {
    hash: r.hash,
    parent: r.parents[0],
    author: r.author,
    authorEmail: r.authorEmail,
    date: r.date,
    subject: r.subject,
    body: r.body,
    path: r.path || rel,
    oldPath: r.oldPath,
    before: t.before,
    after: t.after,
  };
}

export async function showHistoryForSelection(ctx: FeatureContext, arg?: unknown, all?: unknown): Promise<void> {
  try {
    const [t] = await targets(ctx.repos, arg, Array.isArray(all) ? all.slice(0, 1) : undefined);
    if (!t) return;
    if (t.isDir) {
      vscode.window.showWarningMessage('Show History for Selection works for files only.');
      return;
    }
    const editor =
      [vscode.window.activeTextEditor, ...vscode.window.visibleTextEditors].find((ed) => ed && ed.document.uri.toString() === t.source.toString()) ??
      (await vscode.window.showTextDocument(t.source, { preview: true }));
    const sel = editor.selection;
    const start = sel.start.line + 1;
    let end = sel.end.line + 1;
    if (end > start && sel.end.character === 0) end--;
    const repo = t.repo;
    if (!t.rev && !(await repo.headHash())) throw new Error(`The repository ${repo.name} has no commits yet.`);
    const name = baseName(t.rel, repo);
    const title = start === end ? `History for Selection: ${name}:${start}` : `History for Selection: ${name}:${start}-${end}`;
    const panel = vscode.window.createWebviewPanel('jbGit.historySelection', title, vscode.ViewColumn.Active, webviewOptions(ctx.extension.extensionUri));
    panel.iconPath = new vscode.ThemeIcon('history');
    const init: HistorySelectionInit = { repoRoot: repo.root, path: t.rel, start, end, language: editor.document.languageId, rev: t.rev };
    panel.webview.html = webviewHtml(panel.webview, ctx.extension.extensionUri, 'history-selection', init, title);
    const doc = editor.document;
    const bridge = new RpcBridge(panel.webview, {
      load: () => loadBlockHistory(repo, t.rel, doc, start, end, t.rev),
      showDiff: (p: { hash: string; parent?: string; path: string; oldPath?: string }) => {
        if (!p.hash) {
          return invoke('jbGit.diff.show', {
            files: [{ repoRoot: repo.root, path: p.path, left: p.parent ? { rev: p.parent, path: p.oldPath ?? p.path } : { empty: true }, right: { worktree: true, path: p.path }, rightTitle: 'Local Changes' }],
          });
        }
        return invoke('jbGit.diff.show', {
          files: [{
            repoRoot: repo.root,
            path: p.path,
            oldPath: p.oldPath !== p.path ? p.oldPath : undefined,
            left: p.parent && p.oldPath ? { rev: p.parent, path: p.oldPath } : { empty: true },
            right: { rev: p.hash, path: p.path },
          }],
        });
      },
      compareWithLocal: (p: { hash: string }) => invoke('jbGit.compare.fileWithRevision', { repoRoot: repo.root, path: t.rel, rev: p.hash || 'HEAD' }),
      openAtRevision: (p: { hash: string; path: string }) =>
        p.hash ? invoke('jbGit.openFileAtRevision', { repoRoot: repo.root, path: p.path, rev: p.hash }) : vscode.window.showTextDocument(doc, { selection: new vscode.Range(start - 1, 0, end - 1, 0) }),
      showInLog: (p: { hash: string }) => invoke('jbGit.log.show', { repoRoot: repo.root, revision: p.hash }),
      copyHash: (p: { hash: string }) => vscode.env.clipboard.writeText(p.hash),
      copySubject: (p: { text: string }) => vscode.env.clipboard.writeText(p.text),
    });
    const sub = vscode.workspace.onDidChangeTextDocument((e) => {
      if (e.document === doc) bridge.emit('stale');
    });
    panel.onDidDispose(() => {
      bridge.dispose();
      sub.dispose();
    });
  } catch (e) {
    showGitError(e, 'Cannot show history for selection');
  }
}
