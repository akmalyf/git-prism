// "Compare HEAD, Staged and Local Versions" (Git.Stage.ThreeSideDiff) of the staging area: a three-pane window
// (webview bundle "commit-threeway") with HEAD on the left, the staged version in the middle and the local file on the
// right. Like IntelliJ the middle side is editable: edits and the >> / << chunk arrows are written to the index.
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { FeatureContext } from '../../core/context';
import { showGitError } from '../../core/git';
import type { Repository } from '../../core/repository';
import { RpcBridge, webviewHtml, webviewOptions } from '../../core/webview';
import { isBinary, LANGUAGE_IDS, MAX_SIZE } from './diffPanel';
import * as ops from './ops';
import type { CommitDiffFile, Item, ThreeWayInit, ThreeWayPayload } from './protocol';

export interface ThreeWayHost {
  repo(root: string): Repository | undefined;
  hasHead(root: string): boolean;
}

const decode = (b: Buffer | undefined): string => (b ? b.toString('utf8').replace(/^﻿/, '') : '');

export class ThreeWayPanel implements vscode.Disposable {
  private static current: ThreeWayPanel | undefined;
  private readonly panel: vscode.WebviewPanel;
  private readonly bridge: RpcBridge;
  private readonly disposables: vscode.Disposable[] = [];
  private index: number;
  private timer: NodeJS.Timeout | undefined;
  /** serializes index writes */
  private writing: Promise<void> = Promise.resolve();

  static show(ctx: FeatureContext, host: ThreeWayHost, items: Item[], index: number): void {
    ThreeWayPanel.current?.panel.dispose();
    ThreeWayPanel.current = new ThreeWayPanel(ctx, host, items, index);
  }

  private constructor(
    private readonly ctx: FeatureContext,
    private readonly host: ThreeWayHost,
    private readonly files: Item[],
    index: number,
  ) {
    this.index = Math.max(0, Math.min(index, files.length - 1));
    const ext = ctx.extension.extensionUri;
    this.panel = vscode.window.createWebviewPanel('jbGit.commitThreeWay', this.title(this.index), vscode.ViewColumn.Active, webviewOptions(ext));
    this.panel.iconPath = new vscode.ThemeIcon('diff');
    const init: ThreeWayInit = {
      files: files.map((i): CommitDiffFile => ({ key: i.key, path: i.path, kind: i.kind })),
      index: this.index,
      isMac: process.platform === 'darwin',
    };
    this.bridge = new RpcBridge(this.panel.webview, {
      load: (i: number) => this.load(i),
      writeStaged: (p: { index: number; text: string }) => this.writeStaged(p.index, p.text),
      jump: (p: { index: number; line: number }) => this.jump(p.index, p.line),
      close: () => this.panel.dispose(),
    });
    this.panel.webview.html = webviewHtml(this.panel.webview, ext, 'commit-threeway', init, 'Diff');
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
    this.timer = setTimeout(async () => {
      await this.writing;
      const i = this.index;
      const p = await this.load(i).catch(() => undefined);
      if (p && i === this.index) this.bridge.emit('reload', p);
    }, 300);
  }

  private async load(i: number): Promise<ThreeWayPayload> {
    const f = this.files[i];
    if (!f) throw new Error(`no file #${i}`);
    this.index = i;
    this.panel.title = this.title(i);
    const base: ThreeWayPayload = {
      index: i,
      key: f.key,
      path: f.path,
      language: 'plaintext',
      type: 'text',
      head: '',
      staged: '',
      local: '',
      headTitle: 'HEAD',
      stagedTitle: 'Staged',
      localTitle: 'Local',
      editable: false,
      canJump: false,
    };
    const repo = this.host.repo(f.repo);
    if (!repo) return { ...base, type: 'message', message: 'Cannot show diff: file not found' };
    try {
      const hasHead = this.host.hasHead(f.repo);
      const headPath = f.area === 'staged' && f.oldPath ? f.oldPath : f.path;
      const [head, entry] = await Promise.all([hasHead ? repo.show('HEAD', headPath) : Promise.resolve(undefined), ops.indexEntry(repo, f.path)]);
      const staged = entry ? await repo.show(':0', f.path) : undefined;
      let local: Buffer | undefined;
      try {
        local = await fsp.readFile(repo.abs(f.path));
      } catch {
        local = undefined;
      }
      const hash = await repo.headHash();
      base.headTitle = hash ? `HEAD (${hash.slice(0, 8)})` : 'HEAD';
      base.canJump = !!local;
      if ([head, staged, local].some((b) => (b?.length ?? 0) > MAX_SIZE)) {
        return { ...base, type: 'message', message: 'Unable to calculate diff. File is too big and there are too many changes.' };
      }
      if ([head, staged, local].some((b) => b && isBinary(b))) {
        return { ...base, type: 'message', message: 'Files contents are different' };
      }
      base.head = decode(head);
      base.staged = decode(staged);
      base.local = decode(local);
      base.editable = !!entry && !!staged;
      if (local) {
        const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(repo.abs(f.path)));
        base.language = LANGUAGE_IDS[doc.languageId] ?? doc.languageId;
      }
    } catch (e) {
      return { ...base, type: 'message', message: `Unable to calculate diff: ${e instanceof Error ? e.message : String(e)}` };
    }
    return base;
  }

  private writeStaged(i: number, text: string): Promise<void> {
    const f = this.files[i];
    const repo = f && this.host.repo(f.repo);
    if (!f || !repo) return Promise.resolve();
    this.writing = this.writing.then(async () => {
      try {
        // the editor uses LF; keep CRLF when the staged blob had it
        const cur = decode(await repo.show(':0', f.path));
        const next = cur.includes('\r\n') ? text.replace(/\r?\n/g, '\r\n') : text;
        if (next !== cur) await ops.writeIndexContent(repo, f.path, next);
      } catch (e) {
        showGitError(e, 'Cannot write staged content');
      }
    });
    return this.writing;
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
    if (ThreeWayPanel.current === this) ThreeWayPanel.current = undefined;
    for (const d of this.disposables) d.dispose();
    this.disposables.length = 0;
  }
}
