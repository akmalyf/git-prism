// Line status tracker (IntelliJ's LineStatusTracker): gutter + overview ruler markers for lines added, modified or
// deleted against HEAD in visible file editors, Next/Previous Change, Change Under Caret and the change popup
// (shown as an editor hover with Rollback / Show Diff / Copy and the original lines).
import * as vscode from 'vscode';
import type { FeatureContext } from '../../core/context';
import { invoke, type ContentRef, type DiffRequest } from '../../core/contracts';
import { showGitError } from '../../core/git';
import type { Repository } from '../../core/repository';
import {
  caretLine,
  codeBlock,
  markerLines,
  markerType,
  nextRange,
  originalText,
  prevRange,
  rangeForLine,
  rollbackEdit,
  toRanges,
  wholeRange,
  type LstRange,
} from './lineStatus';

type CompareLines = typeof import('@ide-diff/core', { with: { 'resolution-mode': 'import' } }).compareLines;

/** Files above this size are not tracked (IntelliJ also skips huge/binary documents). */
const MAX_SIZE = 5 * 1024 * 1024;
const RECOMPUTE_DELAY = 150;

interface Tracked {
  uri: vscode.Uri;
  repo: Repository;
  rel: string;
  /** HEAD the base was read from; undefined in an empty repository */
  head?: string;
  /** 'head' = diffed against the HEAD text, 'new' = tracked but not in HEAD (all added), 'none' = no markers */
  kind: 'head' | 'new' | 'none';
  baseText: string;
  base: string[];
  ranges: LstRange[];
  /** bumps on every base reload so stale async results are dropped */
  gen: number;
  loading?: Promise<void>;
  timer?: NodeJS.Timeout;
}

/** Arg of the popup's command links. */
interface RangeArg {
  uri: string;
  line: number;
}

// IntelliJ Islands colors (Added / Modified / Deleted lines)
const COLORS = {
  dark: { added: '#549159', modified: '#375FAD', deleted: '#868A91' },
  light: { added: '#77B77B', modified: '#7FA2E6', deleted: '#A7ABB2' },
};

function svgUri(svg: string): vscode.Uri {
  return vscode.Uri.parse(`data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`);
}

const bar = (c: string) => svgUri(`<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" preserveAspectRatio="none"><rect x="5" y="0" width="3" height="16" fill="${c}"/></svg>`);
const triangle = (c: string, atEnd: boolean) =>
  svgUri(
    atEnd
      ? `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16"><path d="M5 16 L5 10 L10 16 Z" fill="${c}"/></svg>`
      : `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16"><path d="M5 0 L10 0 L5 6 Z" fill="${c}"/></svg>`,
  );

function decorationTypes() {
  const lane = vscode.OverviewRulerLane.Left;
  const lines = (k: 'added' | 'modified') =>
    vscode.window.createTextEditorDecorationType({
      isWholeLine: true,
      gutterIconSize: 'cover',
      overviewRulerLane: lane,
      overviewRulerColor: new vscode.ThemeColor(k === 'added' ? 'editorOverviewRuler.addedForeground' : 'editorOverviewRuler.modifiedForeground'),
      dark: { gutterIconPath: bar(COLORS.dark[k]) },
      light: { gutterIconPath: bar(COLORS.light[k]) },
    });
  const deleted = (atEnd: boolean) =>
    vscode.window.createTextEditorDecorationType({
      isWholeLine: true,
      gutterIconSize: 'cover',
      overviewRulerLane: lane,
      overviewRulerColor: new vscode.ThemeColor('editorOverviewRuler.deletedForeground'),
      dark: { gutterIconPath: triangle(COLORS.dark.deleted, atEnd) },
      light: { gutterIconPath: triangle(COLORS.light.deleted, atEnd) },
    });
  return { added: lines('added'), modified: lines('modified'), deleted: deleted(false), deletedAtEnd: deleted(true) };
}

export class LineStatusTrackers implements vscode.Disposable {
  private readonly tracked = new Map<string, Tracked>();
  private readonly types = decorationTypes();
  private readonly disposables: vscode.Disposable[] = [];
  private compare?: CompareLines;
  private enabled = true;
  /** the popup requested by a command, served by the hover provider */
  private popup?: { uri: string; line: number; until: number };

  constructor(private readonly ctx: FeatureContext) {
    this.enabled = this.config();
    this.disposables.push(
      ...Object.values(this.types),
      vscode.window.onDidChangeVisibleTextEditors(() => this.syncVisible()),
      vscode.workspace.onDidChangeTextDocument((e) => this.schedule(e.document)),
      vscode.workspace.onDidCloseTextDocument((d) => this.untrack(d.uri.toString())),
      ctx.repos.onDidChangeRepository((r) => this.repoChanged(r)),
      ctx.repos.onDidChangeRepositories(() => this.syncVisible()),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (!e.affectsConfiguration('jbGit.diff.gutterMarkers')) return;
        this.enabled = this.config();
        for (const k of [...this.tracked.keys()]) this.untrack(k);
        for (const e of vscode.window.visibleTextEditors) for (const d of Object.values(this.types)) e.setDecorations(d, []);
        this.syncVisible();
      }),
      vscode.languages.registerHoverProvider({ scheme: 'file' }, { provideHover: (d, p) => this.provideHover(d, p) }),
    );
    void ctx.repos.ready().then(() => this.syncVisible());
  }

  dispose(): void {
    for (const t of this.tracked.values()) clearTimeout(t.timer);
    this.tracked.clear();
    for (const d of this.disposables) d.dispose();
  }

  private config(): boolean {
    return vscode.workspace.getConfiguration('jbGit.diff').get<boolean>('gutterMarkers', true);
  }

  private async compareLines(): Promise<CompareLines> {
    return (this.compare ??= (await import('@ide-diff/core')).compareLines);
  }

  // ---- tracking ----

  private syncVisible(): void {
    const visible = new Set<string>();
    for (const e of vscode.window.visibleTextEditors) {
      const key = e.document.uri.toString();
      visible.add(key);
      const t = this.tracked.get(key);
      if (t) this.decorate(t);
      else if (this.enabled) void this.track(e.document);
    }
    for (const k of [...this.tracked.keys()]) if (!visible.has(k)) this.untrack(k);
  }

  private untrack(key: string): void {
    const t = this.tracked.get(key);
    if (!t) return;
    clearTimeout(t.timer);
    this.tracked.delete(key);
  }

  /** Starts tracking a document; resolves when its markers are computed. Undefined if it can't be tracked. */
  private async track(doc: vscode.TextDocument): Promise<Tracked | undefined> {
    if (doc.uri.scheme !== 'file' || doc.isClosed) return undefined;
    const key = doc.uri.toString();
    const existing = this.tracked.get(key);
    if (existing) {
      await existing.loading;
      return this.tracked.get(key);
    }
    const repo = this.ctx.repos.forUri(doc.uri);
    if (!repo) return undefined;
    const rel = repo.rel(doc.uri.fsPath);
    if (!rel || rel === '.git' || rel.startsWith('.git/')) return undefined;
    const t: Tracked = { uri: doc.uri, repo, rel, kind: 'none', baseText: '', base: [], ranges: [], gen: 0 };
    this.tracked.set(key, t);
    await (t.loading = this.loadBase(t));
    return this.tracked.get(key) === t ? t : undefined;
  }

  private async loadBase(t: Tracked): Promise<void> {
    const gen = ++t.gen;
    let kind: Tracked['kind'] = 'none';
    let baseText = '';
    let head: string | undefined;
    try {
      head = await t.repo.headHash();
      const bytes = head ? await t.repo.show(head, t.rel) : undefined;
      if (bytes) {
        if (bytes.length <= MAX_SIZE && !bytes.subarray(0, 8000).includes(0)) {
          kind = 'head';
          baseText = bytes.toString('utf8').replace(/^﻿/, '').replace(/\r\n?/g, '\n');
        }
      } else {
        // not in HEAD: a tracked (added) file is entirely new, an untracked/ignored one has no markers
        const r = await t.repo.run(['--literal-pathspecs', 'ls-files', '--error-unmatch', '--', t.rel], { quiet: true, allowFail: true });
        if (r.code === 0) kind = 'new';
      }
    } catch {
      kind = 'none';
    }
    if (gen !== t.gen || this.tracked.get(t.uri.toString()) !== t) return;
    t.kind = kind;
    t.head = head;
    t.baseText = baseText;
    t.base = baseText.split('\n');
    await this.recompute(t);
  }

  private repoChanged(repo: Repository): void {
    const mine = [...this.tracked.values()].filter((t) => t.repo === repo);
    if (!mine.length) return;
    void repo.headHash().then(
      (head) => {
        // the HEAD text only changes with HEAD; files not in HEAD may have been added/removed from the index
        for (const t of mine) if (t.head !== head || t.kind !== 'head') t.loading = this.loadBase(t);
      },
      () => undefined,
    );
  }

  private schedule(doc: vscode.TextDocument): void {
    const t = this.tracked.get(doc.uri.toString());
    if (!t) return;
    clearTimeout(t.timer);
    t.timer = setTimeout(() => void this.recompute(t), RECOMPUTE_DELAY);
  }

  private document(t: Tracked): vscode.TextDocument | undefined {
    const key = t.uri.toString();
    return vscode.workspace.textDocuments.find((d) => d.uri.toString() === key);
  }

  private async recompute(t: Tracked): Promise<void> {
    clearTimeout(t.timer);
    t.timer = undefined;
    const doc = this.document(t);
    if (!doc || this.tracked.get(t.uri.toString()) !== t) return;
    const text = doc.getText();
    if (t.kind === 'none' || text.length > MAX_SIZE) t.ranges = [];
    else if (t.kind === 'new') t.ranges = text ? wholeRange(0, doc.lineCount) : [];
    else {
      const compare = await this.compareLines();
      try {
        t.ranges = toRanges(compare(t.baseText, text.replace(/\r\n?/g, '\n')));
      } catch {
        // DiffTooBigError: the whole file is one change
        t.ranges = wholeRange(t.base.length, doc.lineCount);
      }
    }
    this.decorate(t);
  }

  private decorate(t: Tracked): void {
    const key = t.uri.toString();
    const editors = vscode.window.visibleTextEditors.filter((e) => e.document.uri.toString() === key);
    if (!editors.length || !this.enabled) return;
    const lineCount = editors[0].document.lineCount;
    const out = { added: [] as vscode.Range[], modified: [] as vscode.Range[], deleted: [] as vscode.Range[], deletedAtEnd: [] as vscode.Range[] };
    for (const r of t.ranges) {
      const m = markerLines(r, lineCount);
      const range = new vscode.Range(m.from, 0, m.to, 0);
      const type = markerType(r);
      if (type === 'deleted') (m.atEnd ? out.deletedAtEnd : out.deleted).push(range);
      else out[type].push(range);
    }
    for (const e of editors) for (const k of Object.keys(out) as Array<keyof typeof out>) e.setDecorations(this.types[k], out[k]);
  }

  /** Up-to-date ranges of an editor's document (flushes a pending recompute). */
  private async current(doc: vscode.TextDocument): Promise<Tracked | undefined> {
    const t = this.tracked.get(doc.uri.toString()) ?? (await this.track(doc));
    if (!t) return undefined;
    await t.loading;
    if (t.timer) await this.recompute(t);
    return t;
  }

  // ---- navigation (ShowChangeMarkerAction) ----

  async navigate(which: 'next' | 'previous' | 'current'): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return;
    if (editor.document.uri.scheme !== 'file') {
      vscode.window.setStatusBarMessage('Only files under Git version control have line changes.', 3000);
      return;
    }
    await this.ctx.repos.ready();
    const t = await this.current(editor.document);
    if (!t || t.kind === 'none') {
      vscode.window.setStatusBarMessage('The file is not under Git version control.', 3000);
      return;
    }
    const line = editor.selection.active.line;
    const r = which === 'next' ? nextRange(t.ranges, line) : which === 'previous' ? prevRange(t.ranges, line) : rangeForLine(t.ranges, line);
    if (!r) {
      vscode.window.setStatusBarMessage(t.ranges.length ? (which === 'current' ? 'No change under caret' : `No ${which} change`) : 'No changes', 3000);
      return;
    }
    await this.showPopup(editor, t, r, which !== 'current');
  }

  private async showPopup(editor: vscode.TextEditor, t: Tracked, r: LstRange, move: boolean): Promise<void> {
    const line = caretLine(r, editor.document.lineCount);
    if (move) {
      const pos = new vscode.Position(line, 0);
      editor.selection = new vscode.Selection(pos, pos);
    }
    const target = move ? line : editor.selection.active.line;
    editor.revealRange(new vscode.Range(target, 0, target, 0), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
    this.popup = { uri: t.uri.toString(), line: target, until: Date.now() + 2000 };
    await vscode.commands.executeCommand('editor.action.showHover');
  }

  private provideHover(doc: vscode.TextDocument, pos: vscode.Position): vscode.Hover | undefined {
    const p = this.popup;
    if (!p || p.uri !== doc.uri.toString() || p.line !== pos.line || Date.now() > p.until) return undefined;
    this.popup = undefined;
    const t = this.tracked.get(p.uri);
    const r = t && rangeForLine(t.ranges, pos.line);
    if (!t || !r) return undefined;
    const arg = encodeURIComponent(JSON.stringify([{ uri: p.uri, line: r.line1 } satisfies RangeArg]));
    const link = (icon: string, title: string, cmd: string, withArg = true) =>
      `[$(${icon})](command:${cmd}${withArg ? `?${arg}` : ''} "${title}")`;
    const md = new vscode.MarkdownString(undefined, true);
    md.isTrusted = {
      enabledCommands: ['jbGit.diff.previousChange', 'jbGit.diff.nextChange', 'jbGit.diff.rollbackChange', 'jbGit.diff.showChangeDiff', 'jbGit.diff.copyChange'],
    };
    const tools = [
      link('arrow-up', 'Previous Change', 'jbGit.diff.previousChange', false),
      link('arrow-down', 'Next Change', 'jbGit.diff.nextChange', false),
      link('discard', 'Rollback Lines', 'jbGit.diff.rollbackChange'),
      link('diff', 'Show Diff', 'jbGit.diff.showChangeDiff'),
      ...(r.vcsLine1 < r.vcsLine2 ? [link('copy', 'Copy', 'jbGit.diff.copyChange')] : []),
    ];
    md.appendMarkdown(tools.join('&nbsp;&nbsp;'));
    const original = originalText(t.base, r);
    if (r.vcsLine1 < r.vcsLine2) md.appendMarkdown('\n\n' + codeBlock(original, doc.languageId));
    const m = markerLines(r, doc.lineCount);
    return new vscode.Hover(md, new vscode.Range(m.from, 0, m.to, doc.lineAt(m.to).text.length));
  }

  // ---- popup actions ----

  private async resolve(arg: RangeArg | undefined): Promise<{ doc: vscode.TextDocument; t: Tracked; r: LstRange } | undefined> {
    if (!arg || typeof arg.uri !== 'string' || typeof arg.line !== 'number') return undefined;
    const doc = vscode.workspace.textDocuments.find((d) => d.uri.toString() === arg.uri);
    if (!doc) return undefined;
    const t = await this.current(doc);
    const r = t && rangeForLine(t.ranges, arg.line);
    if (!t || !r) {
      vscode.window.setStatusBarMessage('The change no longer exists', 3000);
      return undefined;
    }
    return { doc, t, r };
  }

  async rollback(arg?: RangeArg): Promise<void> {
    const c = await this.resolve(arg);
    if (!c) return;
    const { doc, t, r } = c;
    const eol = doc.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n';
    const cur: string[] = [];
    for (let i = 0; i < doc.lineCount; i++) cur.push(doc.lineAt(i).text);
    const e = rollbackEdit(cur, t.base, r, eol);
    const range = new vscode.Range(e.startLine, e.startChar, e.endLine, e.endChar);
    const editor = vscode.window.visibleTextEditors.find((x) => x.document === doc);
    let ok: boolean;
    if (editor) ok = await editor.edit((b) => b.replace(range, e.text));
    else {
      const we = new vscode.WorkspaceEdit();
      we.replace(doc.uri, range, e.text);
      ok = await vscode.workspace.applyEdit(we);
    }
    if (!ok) vscode.window.showErrorMessage('Rollback Lines failed: the document could not be edited.');
  }

  async showDiff(arg?: RangeArg): Promise<void> {
    const c = await this.resolve(arg);
    if (!c) return;
    const { doc, t, r } = c;
    const left: ContentRef = t.kind === 'head' && t.head ? { rev: t.head, path: t.rel } : { empty: true };
    const right: ContentRef = doc.isDirty ? { text: doc.getText(), label: 'Your version' } : { worktree: true, path: t.rel };
    const req: DiffRequest & { line: number } = {
      files: [{ repoRoot: t.repo.root, path: t.rel, kind: t.kind === 'head' ? 'M' : 'A', left, right }],
      line: Math.min(r.line1, Math.max(0, doc.lineCount - 1)),
    };
    try {
      await invoke('jbGit.diff.show', req);
    } catch (e) {
      showGitError(e, 'Cannot show diff');
    }
  }

  async copy(arg?: RangeArg): Promise<void> {
    const c = await this.resolve(arg);
    if (!c) return;
    const eol = c.doc.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n';
    await vscode.env.clipboard.writeText(originalText(c.t.base, c.r, eol));
  }
}
