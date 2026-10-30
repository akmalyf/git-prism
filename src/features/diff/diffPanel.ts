// The diff window (IntelliJ "Diff" editor tab): a webview panel with ide-diff for one or several files.
// Resolves ContentRefs, saves edits of the working tree side, reloads on external changes, reuses open tabs.
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { ContentRef, DiffFile, DiffRequest } from '../../core/contracts';
import type { FeatureContext } from '../../core/context';
import { showGitError } from '../../core/git';
import type { Repository } from '../../core/repository';
import { RpcBridge, webviewHtml, webviewOptions } from '../../core/webview';
import {
  bytesEqual,
  decode,
  DEFAULT_META,
  imageMime,
  isBinary,
  languageOf,
  MAX_IMAGE_SIZE,
  MAX_TEXT_SIZE,
  normalizeEol,
  onlySeparatorNotice,
  requestKey,
  shortRev,
  sideTitles,
  type TextMeta,
} from './content';
import { openDocument, readWorktree, worktreeSize, writeWorktree } from './files';
import type { DiffInit, DiffPayload, DiffViewSettings } from './protocol';

const SETTINGS_KEY = 'jbGit.diff.settings';
/** a pending edit of the working tree side is written after this much idle time (and on Cmd/Ctrl+S, switch, close) */
const WRITE_DELAY = 500;

interface Loaded {
  bytes?: Buffer;
  exists: boolean;
  /** symlink in the working tree: shown as its target, not editable */
  symlink?: boolean;
  tooLarge?: boolean;
  size?: number;
  /** unsaved text of the file's open VS Code editor (shown instead of the disk contents, like IntelliJ's Document) */
  docText?: string;
}

class ContentError extends Error {}

/** Optional hint next to the contract fields: the right-side line (0-based) to reveal, sent by Show Diff for Lines. */
function lineHint(req: DiffRequest): number | undefined {
  const line = (req as DiffRequest & { line?: unknown }).line;
  return typeof line === 'number' && Number.isInteger(line) && line >= 0 ? line : undefined;
}

export class DiffPanel implements vscode.Disposable {
  private static readonly open = new Map<string, DiffPanel>();

  /** Shows a diff request, reusing the tab that already shows the same files. */
  static show(ctx: FeatureContext, req: DiffRequest): void {
    const files = (req?.files ?? []).filter((f) => f && f.repoRoot && f.path && f.left && f.right);
    if (!files.length) {
      vscode.window.showInformationMessage('No changes to show.');
      return;
    }
    const index = Math.max(0, Math.min(files.length - 1, req.index ?? 0));
    const key = requestKey(files);
    const line = lineHint(req);
    const existing = DiffPanel.open.get(key);
    if (existing) {
      existing.title = req.title;
      existing.panel.title = existing.tabTitle(existing.requested);
      if (line !== undefined) existing.bridge.emit('reveal', { index, line });
      else existing.bridge.emit('select', index);
      existing.panel.reveal(req.beside ? vscode.ViewColumn.Beside : undefined);
      return;
    }
    DiffPanel.open.set(key, new DiffPanel(ctx, key, files, index, req));
  }

  private readonly panel: vscode.WebviewPanel;
  private readonly bridge: RpcBridge;
  private readonly disposables: vscode.Disposable[] = [];
  private title: string | undefined;
  /** file the webview asked for last */
  private requested: number;
  private seq = 0;
  /** encoding/EOL of each file's editable working tree side */
  private readonly metas = new Map<number, TextMeta>();
  /** last texts sent to / received from the webview for the current file, to detect external changes */
  private shown: { index: number; left?: string; right?: string; type?: string } = { index: -1 };
  private watcher: vscode.Disposable | undefined;
  private watched: string | undefined;
  private reloadTimer: NodeJS.Timeout | undefined;
  private pending: { index: number; text: string } | undefined;
  private writeTimer: NodeJS.Timeout | undefined;
  private saving: Promise<unknown> = Promise.resolve();
  private disposed = false;

  private constructor(
    private readonly ctx: FeatureContext,
    private readonly key: string,
    private readonly files: DiffFile[],
    index: number,
    req: DiffRequest,
  ) {
    this.requested = index;
    this.title = req.title;
    const ext = ctx.extension.extensionUri;
    this.panel = vscode.window.createWebviewPanel('jbGit.diff', this.tabTitle(index), req.beside ? vscode.ViewColumn.Beside : vscode.ViewColumn.Active, webviewOptions(ext));
    this.panel.iconPath = new vscode.ThemeIcon('diff');
    const init: DiffInit = {
      files: files.map((f) => ({ path: f.path, oldPath: f.oldPath, kind: f.kind })),
      index,
      line: lineHint(req),
      settings: ctx.extension.globalState.get<DiffViewSettings>(SETTINGS_KEY),
    };
    this.panel.webview.html = webviewHtml(this.panel.webview, ext, 'diff', init, this.tabTitle(index));
    this.bridge = new RpcBridge(this.panel.webview, {
      load: (i: number) => this.load(i, false),
      edit: (p: { index: number; text: string }) => this.edit(p.index, p.text),
      flush: () => this.flush(),
      jump: (p: { index: number; line: number }) => this.jump(p.index, p.line),
      settings: (s: DiffViewSettings) => ctx.extension.globalState.update(SETTINGS_KEY, s),
      close: async () => {
        await this.flush();
        this.panel.dispose();
      },
    });
    this.disposables.push(
      this.bridge,
      ctx.repos.onDidChangeRepository((repo) => {
        const f = this.files[this.shown.index];
        if (f && path.normalize(f.repoRoot) === repo.root && this.dependsOnRepo(f)) this.scheduleReload();
      }),
      vscode.workspace.onDidChangeTextDocument((e) => {
        if (this.watched && e.document.uri.scheme === 'file' && e.document.uri.fsPath === this.watched && e.contentChanges.length) this.scheduleReload();
      }),
    );
    this.panel.onDidDispose(() => this.dispose());
  }

  private tabTitle(index: number): string {
    if (this.title) return this.title;
    const f = this.files[index];
    return f ? path.posix.basename(f.path) : 'Diff';
  }

  private dependsOnRepo(f: DiffFile): boolean {
    const dyn = (r: ContentRef) => 'index' in r || 'worktree' in r || ('rev' in r && !/^[0-9a-f]{40}([0-9a-f]{24})?$/i.test(r.rev));
    return dyn(f.left) || dyn(f.right);
  }

  private async repo(f: DiffFile): Promise<Repository> {
    const repo = this.ctx.repos.get(f.repoRoot) ?? (await this.ctx.repos.open(f.repoRoot));
    if (!repo) throw new ContentError(`${f.repoRoot} is not a Git repository`);
    return repo;
  }

  /** Object of `rev:path` / `:stage:path` (cat-file --batch-check, so a huge blob isn't read just to be rejected). */
  private async gitObject(repo: Repository, spec: string): Promise<{ type: string; size: number; hash: string } | undefined> {
    if (spec.includes('\n')) {
      const r = await repo.run(['cat-file', '-t', spec], { allowFail: true, quiet: true });
      if (r.code !== 0) return undefined;
      const size = +(await repo.run(['cat-file', '-s', spec], { quiet: true })).stdout.trim();
      const hash = (await repo.run(['rev-parse', '--verify', spec], { quiet: true })).stdout.trim();
      return { type: r.stdout.trim(), size, hash };
    }
    const out = (await repo.run(['cat-file', '--batch-check=%(objecttype) %(objectsize) %(objectname)'], { input: `${spec}\n`, quiet: true })).stdout.trim();
    const m = /^(\w+) (\d+) ([0-9a-f]+)$/.exec(out);
    return m ? { type: m[1], size: +m[2], hash: m[3] } : undefined;
  }

  private async resolve(repo: Repository, ref: ContentRef): Promise<Loaded> {
    if ('empty' in ref) return { exists: false };
    if ('text' in ref) return { exists: true, bytes: Buffer.from(ref.text, 'utf8') };
    if ('worktree' in ref) {
      const abs = repo.abs(ref.path);
      const doc = vscode.workspace.textDocuments.find((d) => d.uri.scheme === 'file' && d.uri.fsPath === abs);
      const size = await worktreeSize(abs);
      if (size !== undefined && size > MAX_IMAGE_SIZE) return { exists: true, tooLarge: true, size };
      const w = await readWorktree(abs);
      if (!w) return { exists: false };
      return { exists: true, bytes: w.bytes, symlink: w.symlink, size: w.bytes.length, docText: !w.symlink && doc?.isDirty ? doc.getText() : undefined };
    }
    const spec = 'rev' in ref ? `${ref.rev}:${ref.path}` : `:${ref.stage ?? 0}:${ref.path}`;
    const obj = await this.gitObject(repo, spec);
    if (!obj) {
      if ('rev' in ref) {
        const valid = await repo.run(['rev-parse', '--verify', '--quiet', `${ref.rev}^{object}`], { allowFail: true, quiet: true });
        // unborn branch: HEAD doesn't exist yet, every path is "added"
        const unborn = valid.code !== 0 && /^HEAD\b/.test(ref.rev) && !(await repo.headHash());
        if (valid.code !== 0 && !unborn) throw new ContentError(`Cannot get content from this revision (${ref.rev})`);
      }
      return { exists: false };
    }
    if (obj.type === 'tree') throw new ContentError('Cannot show diff for directory');
    if (obj.type === 'commit') return { exists: true, bytes: Buffer.from(`Subproject commit ${obj.hash}\n`, 'utf8') };
    if (obj.size > MAX_IMAGE_SIZE) return { exists: true, tooLarge: true, size: obj.size };
    const bytes = await repo.buffer(['cat-file', 'blob', obj.hash], { quiet: true });
    return { exists: true, bytes, size: bytes.length };
  }

  /** Short hash for a symbolic revision (HEAD, branch, stash@{0}) when the caller didn't title that side. */
  private async revTitle(repo: Repository, ref: ContentRef, given: string | undefined, fallback: string): Promise<string> {
    if (given !== undefined || !('rev' in ref) || /^[0-9a-f]{40}([0-9a-f]{24})?$/i.test(ref.rev)) return fallback;
    const r = await repo.run(['rev-parse', '--verify', '--quiet', `${ref.rev}^{commit}`], { allowFail: true, quiet: true });
    return r.code === 0 ? shortRev(r.stdout.trim()) : fallback;
  }

  /** Contents of file `i` for the webview. `silent`: a background reload (no error notification). */
  private async load(i: number, silent: boolean): Promise<DiffPayload> {
    const f = this.files[i];
    if (!f) throw new Error(`no file #${i}`);
    const seq = ++this.seq;
    this.requested = i;
    this.panel.title = this.tabTitle(i);
    this.watch(f);
    const titles = sideTitles(f);
    const base: DiffPayload = {
      index: i,
      path: f.path,
      language: languageOf(f.path),
      type: 'text',
      left: { exists: false, title: titles.left.title, path: titles.left.path },
      right: { exists: false, title: titles.right.title, path: titles.right.path },
      canJump: false,
    };
    let payload: DiffPayload;
    try {
      const repo = await this.repo(f);
      const [l, r, lt, rt, jumpSize] = await Promise.all([
        this.resolve(repo, f.left),
        this.resolve(repo, f.right),
        this.revTitle(repo, f.left, f.leftTitle, titles.left.title),
        this.revTitle(repo, f.right, f.rightTitle, titles.right.title),
        worktreeSize(repo.abs(this.jumpPath(f))),
      ]);
      base.canJump = jumpSize !== undefined;
      base.left = { ...base.left, title: lt, exists: l.exists, size: l.size, path: l.exists ? base.left.path : undefined };
      base.right = { ...base.right, title: rt, exists: r.exists, size: r.size, path: r.exists || 'worktree' in f.right ? base.right.path : undefined };
      payload = this.build(i, f, base, l, r);
    } catch (e) {
      if (!silent && !(e instanceof ContentError)) showGitError(e, `Cannot show diff for ${f.path}`);
      const detail = e instanceof Error ? e.message : String(e);
      payload = { ...base, type: 'error', message: e instanceof ContentError ? detail : `Unable to calculate diff: ${detail}` };
    }
    if (seq === this.seq) this.shown = { index: i, left: payload.left.text, right: payload.right.text, type: payload.type };
    return payload;
  }

  private jumpPath(f: DiffFile): string {
    return 'worktree' in f.right ? f.right.path : f.path;
  }

  private build(i: number, f: DiffFile, p: DiffPayload, l: Loaded, r: Loaded): DiffPayload {
    const lb = l.bytes ?? Buffer.alloc(0);
    const rb = r.bytes ?? Buffer.alloc(0);
    const mime = imageMime(f.path);
    if (mime && !l.symlink && !r.symlink && (isBinary(lb) || isBinary(rb) || !lb.length || !rb.length)) {
      if (l.tooLarge || r.tooLarge) return { ...p, type: 'tooLarge', message: 'Files are too large to compare' };
      const uri = (b: Buffer, exists: boolean) => (exists && b.length ? `data:${mime};base64,${b.toString('base64')}` : undefined);
      return { ...p, type: 'image', identical: l.exists === r.exists && bytesEqual(lb, rb), left: { ...p.left, image: uri(lb, l.exists) }, right: { ...p.right, image: uri(rb, r.exists) } };
    }
    if (l.tooLarge || r.tooLarge || lb.length > MAX_TEXT_SIZE || rb.length > MAX_TEXT_SIZE) return { ...p, type: 'tooLarge', message: 'Files are too large to compare' };
    const ld = decode(lb);
    const rd = decode(rb);
    if (ld.binary || rd.binary) {
      const identical = l.exists === r.exists && bytesEqual(lb, rb);
      return { ...p, type: 'binary', identical, message: identical ? 'Files contents are identical' : 'Files contents are different' };
    }
    if (r.docText !== undefined) rd.text = normalizeEol(r.docText);
    // a missing working tree file isn't editable (typing would recreate a deleted file)
    const editable = 'worktree' in f.right && r.exists && !r.symlink;
    if (editable) this.metas.set(i, rd.meta);
    return {
      ...p,
      left: { ...p.left, text: ld.text },
      right: { ...p.right, text: rd.text, editable },
      notice: l.exists && r.exists && r.docText === undefined ? onlySeparatorNotice(ld, rd, lb, rb) : undefined,
    };
  }

  /** The webview's editable side changed: remember it and write it to disk after a short idle time. */
  private edit(i: number, text: string): void {
    const f = this.files[i];
    if (!f || !('worktree' in f.right) || !this.metas.has(i)) return;
    if (this.pending && this.pending.index !== i) void this.flush();
    this.pending = { index: i, text };
    if (i === this.shown.index) this.shown.right = text;
    clearTimeout(this.writeTimer);
    this.writeTimer = setTimeout(() => void this.flush(), WRITE_DELAY);
  }

  /** Writes the pending edit (if any); resolves when every write so far is on disk. */
  private flush(): Promise<unknown> {
    clearTimeout(this.writeTimer);
    const p = this.pending;
    this.pending = undefined;
    if (p) {
      const f = this.files[p.index];
      const right = f.right as { worktree: true; path: string };
      const meta = this.metas.get(p.index) ?? DEFAULT_META;
      const run = async () => {
        try {
          const repo = await this.repo(f);
          await writeWorktree(repo.abs(right.path), p.text, meta);
          repo.fireChanged();
        } catch (e) {
          showGitError(e, `Cannot save ${f.path}`);
        }
      };
      this.saving = this.saving.then(run, run);
    }
    return this.saving;
  }

  private async jump(i: number, line: number): Promise<void> {
    const f = this.files[i];
    if (!f) return;
    await this.flush();
    try {
      const repo = await this.repo(f);
      const uri = vscode.Uri.file(repo.abs(this.jumpPath(f)));
      const column = this.panel.viewColumn;
      if (this.shown.index === i && this.shown.type !== 'text' && this.shown.type !== 'error') {
        await vscode.commands.executeCommand('vscode.open', uri, { viewColumn: column, preview: false });
        return;
      }
      await openDocument(uri, line, column);
    } catch (e) {
      showGitError(e, `Cannot open ${f.path}`);
    }
  }

  /** Watches the current working tree file (external edits → reload). */
  private watch(f: DiffFile): void {
    const wt = 'worktree' in f.right ? f.right : 'worktree' in f.left ? f.left : undefined;
    const abs = wt ? path.join(path.normalize(f.repoRoot), ...wt.path.split('/')) : undefined;
    if (abs === this.watched) return;
    this.watcher?.dispose();
    this.watcher = undefined;
    this.watched = abs;
    if (!abs) return;
    const w = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(path.dirname(abs)), path.basename(abs)));
    const on = () => this.scheduleReload();
    w.onDidChange(on);
    w.onDidCreate(on);
    w.onDidDelete(on);
    this.watcher = w;
  }

  private scheduleReload(): void {
    if (this.disposed) return;
    clearTimeout(this.reloadTimer);
    this.reloadTimer = setTimeout(() => void this.reload(), 250);
  }

  /** Re-resolves the current file and pushes it to the webview when anything changed outside the diff. */
  private async reload(): Promise<void> {
    // our own pending write will trigger another reload once it lands
    if (this.pending) return;
    await this.saving;
    const i = this.requested;
    if (i !== this.shown.index || this.disposed) return;
    const before = this.shown;
    const seq = this.seq + 1;
    const p = await this.load(i, true);
    if (seq !== this.seq || this.disposed || this.pending) return;
    if (p.type === before.type && p.left.text === before.left && p.right.text === before.right) return;
    this.bridge.emit('reload', p);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    void this.flush();
    DiffPanel.open.delete(this.key);
    clearTimeout(this.reloadTimer);
    this.watcher?.dispose();
    for (const d of this.disposables) d.dispose();
  }
}
