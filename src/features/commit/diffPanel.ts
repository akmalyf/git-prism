// Diff window of the Commit tool window (changelist mode): HEAD vs the working tree in an ide-diff viewer
// (webview bundle "commit-diff") with IntelliJ's "Include into commit" checkboxes — one per changed chunk in the
// gutter plus the file checkbox in the toolbar — and Include / Exclude Selected Lines into/from Commit. The right side
// is editable (written through the TextDocument and saved), F4 jumps to the source.
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { FeatureContext } from '../../core/context';
import { invoke } from '../../core/contracts';
import { showGitError } from '../../core/git';
import type { Repository } from '../../core/repository';
import { RpcBridge, webviewHtml, webviewOptions } from '../../core/webview';
import { diffFile } from './logic';
import * as ops from './ops';
import { hunkKeys, hunkViews, pruneExcluded } from './partial';
import type { CommitDiffFile, CommitDiffInit, CommitDiffPayload, Item } from './protocol';

/** What the panel needs from the Commit view. */
export interface DiffHost {
  /** the current item of a key (undefined when the file isn't changed anymore) */
  item(key: string): Item | undefined;
  repo(root: string): Repository | undefined;
  hasHead(root: string): boolean;
  /** stored excluded line keys of a file */
  excludedOf(item: Item): Set<string>;
  /** sets the excluded lines of a file; `all` = every line key of the file */
  applyLines(item: Item, excluded: string[], all: string[]): Promise<void>;
  setFileIncluded(item: Item, included: boolean): Promise<void>;
  /** partial commits are impossible (merge / cherry-pick / revert in progress) */
  linesDisabled(root: string): boolean;
  refresh(): Promise<void>;
}

export const MAX_SIZE = 20 * 1024 * 1024;
const SETTINGS_KEY = 'jbGit.commit.diffViewer';
export const LANGUAGE_IDS: Record<string, string> = {
  shellscript: 'shell',
  c: 'cpp',
  jsonc: 'json',
  typescriptreact: 'typescript',
  javascriptreact: 'javascript',
  properties: 'ini',
  blade: 'html',
  vue: 'html',
  'git-commit': 'plaintext',
};

export const isBinary = (b: Buffer) => b.subarray(0, 8000).includes(0);

export class CommitDiffPanel implements vscode.Disposable {
  private static current: CommitDiffPanel | undefined;
  private readonly panel: vscode.WebviewPanel;
  private readonly bridge: RpcBridge;
  private readonly disposables: vscode.Disposable[] = [];
  private files: Item[];
  private index: number;
  private timer: NodeJS.Timeout | undefined;
  private seq = 0;

  /** Opens (or re-targets the open) Commit diff window. */
  static show(ctx: FeatureContext, host: DiffHost, items: Item[], index: number): void {
    CommitDiffPanel.current?.panel.dispose();
    CommitDiffPanel.current = new CommitDiffPanel(ctx, host, items, index);
  }

  private constructor(
    private readonly ctx: FeatureContext,
    private readonly host: DiffHost,
    items: Item[],
    index: number,
  ) {
    this.files = items;
    this.index = Math.max(0, Math.min(index, items.length - 1));
    const ext = ctx.extension.extensionUri;
    this.panel = vscode.window.createWebviewPanel('jbGit.commitDiff', this.title(this.index), vscode.ViewColumn.Active, webviewOptions(ext));
    this.panel.iconPath = new vscode.ThemeIcon('diff');
    const init: CommitDiffInit & { settings: unknown } = {
      files: items.map((i): CommitDiffFile => ({ key: i.key, path: i.path, kind: i.kind })),
      index: this.index,
      isMac: process.platform === 'darwin',
      settings: ctx.extension.globalState.get(SETTINGS_KEY),
    };
    this.bridge = new RpcBridge(this.panel.webview, this.handlers());
    this.panel.webview.html = webviewHtml(this.panel.webview, ext, 'commit-diff', init, 'Diff');
    this.disposables.push(
      this.bridge,
      ctx.repos.onDidChangeRepository((r) => {
        if (this.files.some((f) => f.repo === r.root)) this.scheduleReload();
      }),
    );
    this.panel.onDidDispose(() => this.dispose());
  }

  private title(i: number): string {
    const f = this.files[i];
    return f ? path.posix.basename(f.path) : 'Diff';
  }

  private scheduleReload(): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.reload(), 250);
  }

  private async reload(): Promise<void> {
    await this.host.refresh();
    const i = this.index;
    const p = await this.load(i).catch(() => undefined);
    if (p && i === this.index) this.bridge.emit('reload', p);
  }

  private handlers() {
    return {
      load: (i: number) => this.load(i),
      setLines: async (p: { index: number; excluded: string[]; all: string[] }) => {
        const it = this.host.item(this.files[p.index]?.key ?? '');
        if (it) await this.host.applyLines(it, p.excluded, p.all);
        return this.load(p.index);
      },
      setIncluded: async (p: { index: number; included: boolean }) => {
        const it = this.host.item(this.files[p.index]?.key ?? '');
        if (it) await this.host.setFileIncluded(it, p.included);
        return this.load(p.index);
      },
      edit: (p: { index: number; text: string }) => this.edit(p.index, p.text),
      jump: (p: { index: number; line: number }) => this.jump(p.index, p.line),
      showInDiffViewer: (p: { index: number }) => {
        const f = this.files[p.index];
        if (f) return invoke('jbGit.diff.show', { files: [diffFile(this.host.item(f.key) ?? f, this.host.hasHead(f.repo))] });
        return undefined;
      },
      settings: (s: unknown) => this.ctx.extension.globalState.update(SETTINGS_KEY, s),
      close: () => this.panel.dispose(),
    };
  }

  private async load(i: number): Promise<CommitDiffPayload> {
    const f = this.files[i];
    if (!f) throw new Error(`no file #${i}`);
    const seq = ++this.seq;
    this.index = i;
    this.panel.title = this.title(i);
    const cur = this.host.item(f.key);
    const it = cur ?? f;
    const base: CommitDiffPayload = {
      index: i,
      key: f.key,
      path: it.path,
      language: 'plaintext',
      type: 'text',
      left: { title: 'Base version' },
      right: { title: 'Current version', editable: false },
      checkable: !!cur && (cur.area === 'changes' || cur.area === 'untracked'),
      included: !!cur?.included,
      lines: false,
      hunks: [],
      canJump: false,
    };
    const repo = this.host.repo(it.repo);
    if (!repo) return { ...base, type: 'message', message: 'Cannot show diff: file not found' };
    const hasHead = this.host.hasHead(it.repo);
    try {
      const leftPath = it.oldPath ?? it.path;
      const added = it.kind === 'A' || it.kind === '?' || it.kind === 'C' || it.area === 'untracked';
      const head = await repo.headHash();
      const left = hasHead && !added ? await repo.show('HEAD', leftPath) : undefined;
      const abs = repo.abs(it.path);
      let right: Buffer | undefined;
      try {
        right = await fsp.readFile(abs);
      } catch {
        right = undefined;
      }
      base.left = { title: head ? head.slice(0, 8) : 'Base version', path: left ? leftPath : undefined };
      base.right = { title: right ? 'Current version' : 'Your version', path: right ? it.path : undefined, editable: !!right };
      base.canJump = !!right;
      if (!left && !right) return { ...base, type: 'message', message: 'Cannot show diff: file not found' };
      if ((left?.length ?? 0) > MAX_SIZE || (right?.length ?? 0) > MAX_SIZE) {
        return { ...base, type: 'message', message: 'Unable to calculate diff. File is too big and there are too many changes.', right: { ...base.right, editable: false } };
      }
      if ((left && isBinary(left)) || (right && isBinary(right))) {
        const same = !!left && !!right && left.equals(right);
        return { ...base, type: 'message', message: same ? 'Files contents are identical' : 'Files contents are different', right: { ...base.right, editable: false } };
      }
      base.left.text = left?.toString('utf8').replace(/^﻿/, '');
      base.right.text = right?.toString('utf8').replace(/^﻿/, '');
      if (right) {
        const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(abs));
        base.language = LANGUAGE_IDS[doc.languageId] ?? doc.languageId;
      }
      if (cur && cur.area === 'changes' && cur.kind === 'M' && hasHead && !this.host.linesDisabled(cur.repo)) {
        const diff = await ops.fileDiff(repo, cur.path);
        if (!diff.binary && diff.hunks.length) {
          const excluded = cur.included ? new Set(pruneExcluded(diff.hunks, this.host.excludedOf(cur))) : new Set(diff.hunks.flatMap(hunkKeys));
          base.hunks = hunkViews(diff.hunks, excluded);
          base.lines = true;
        }
      }
    } catch (e) {
      if (seq === this.seq) showGitError(e, `Cannot show diff for ${it.path}`);
      return { ...base, type: 'message', message: `Unable to calculate diff: ${e instanceof Error ? e.message : String(e)}` };
    }
    return base;
  }

  /** Writes the edited right side through the TextDocument (keeps line separators) and saves it. */
  private async edit(i: number, text: string): Promise<void> {
    const f = this.files[i];
    const repo = f && this.host.repo(f.repo);
    if (!f || !repo) return;
    try {
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(repo.abs(f.path)));
      const next = doc.eol === vscode.EndOfLine.CRLF ? text.replace(/\r?\n/g, '\r\n') : text;
      if (doc.getText() === next) return;
      const we = new vscode.WorkspaceEdit();
      we.replace(doc.uri, new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length)), next);
      if (!(await vscode.workspace.applyEdit(we))) throw new Error(`Cannot edit ${f.path}`);
      await doc.save();
    } catch (e) {
      showGitError(e, 'Cannot save the file');
    }
  }

  private async jump(i: number, line: number): Promise<void> {
    const f = this.files[i];
    const repo = f && this.host.repo(f.repo);
    if (!f || !repo) return;
    const pos = new vscode.Position(Math.max(0, line), 0);
    await vscode.window.showTextDocument(vscode.Uri.file(repo.abs(f.path)), { selection: new vscode.Range(pos, pos), preview: true });
  }

  dispose(): void {
    clearTimeout(this.timer);
    if (CommitDiffPanel.current === this) CommitDiffPanel.current = undefined;
    for (const d of this.disposables) d.dispose();
    this.disposables.length = 0;
  }
}
