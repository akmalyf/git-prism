// IntelliJ-style "Annotate with Git Blame": an annotation column drawn with `before` editor decorations
// (date + author by default, colored by commit age or author), a commit hover with actions, and live updates
// while editing (shift + debounced re-blame with the unsaved buffer via `--contents -`).
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { FeatureContext } from '../../core/context';
import { invoke, type ContentRef } from '../../core/contracts';
import { showGitError } from '../../core/git';
import type { Repository } from '../../core/repository';
import { diffLines, mapLineToBase } from './hunks';
import { isUncommitted, parseBlamePorcelain, shiftLines, type BlameCommit, type BlameLine, type BlameResult } from './blame';
import {
  authorColor,
  buildColumns,
  commitTime,
  exactUser,
  formatDateTime,
  groupStarts,
  orderColor,
  orderSteps,
  type ColorMode,
  type ColumnOptions,
  type NameType,
} from './format';
import { OWN_SCHEME, revisionQueryOf } from './target';

const NBSP = ' ';
const REBLAME_DELAY = 500;
const MAX_CACHED_MESSAGES = 500;
/** settings that change the blame itself (re-run git) instead of only the presentation */
const BLAME_SETTINGS = ['ignoreWhitespaces', 'detectMovements'];

export interface Annotation {
  key: string;
  uri: vscode.Uri;
  repo: Repository;
  /** repo-relative path of the annotated file */
  path: string;
  /** annotated revision; undefined = working copy (the editor buffer) */
  rev?: string;
  blame: BlameResult;
  lines: BlameLine[];
  timer?: NodeJS.Timeout;
  gen: number;
}

/** A line of an annotated document (from a hover link, the gutter menu or the cursor). */
export interface LineTarget {
  a: Annotation;
  line: number;
  info: BlameLine;
  commit?: BlameCommit;
}

/** Command argument: hover links pass {uri, line} (0-based), the line number gutter menu {uri, lineNumber} (1-based). */
export type LineArg = { uri?: string | vscode.Uri; line?: number; lineNumber?: number } | vscode.Uri | undefined;

interface Settings {
  columns: ColumnOptions;
  colorMode: ColorMode;
  flags: string[];
}

export function settings(): Settings {
  const c = vscode.workspace.getConfiguration('gitPrism.annotate');
  // same flags as IntelliJ's GitAnnotationProvider (movement detection is one option: none / within file / across files)
  const flags = ['--encoding=UTF-8'];
  if (c.get<boolean>('ignoreWhitespaces', true)) flags.push('-w');
  const movements = c.get<string>('detectMovements', 'none');
  if (movements === 'inner') flags.push('-M');
  else if (movements === 'outer') flags.push('-C');
  return {
    columns: {
      showHash: c.get<boolean>('showRevision', false),
      showDate: c.get<boolean>('showDate', true),
      showAuthor: c.get<boolean>('showAuthor', true),
      showSubject: c.get<boolean>('showSubject', false),
      names: c.get<NameType>('names', 'lastName'),
      commitDate: c.get<boolean>('preferCommitTimestamp', false),
      locale: vscode.env.language,
    },
    colorMode: c.get<ColorMode>('colors', 'order'),
    flags,
  };
}

function isDark(): boolean {
  const k = vscode.window.activeColorTheme.kind;
  return k === vscode.ColorThemeKind.Dark || k === vscode.ColorThemeKind.HighContrast;
}

export class Annotator implements vscode.Disposable {
  private readonly items = new Map<string, Annotation>();
  private readonly messages = new Map<string, Promise<string | undefined>>();
  private readonly shallowWarned = new Set<string>();
  private readonly disposables: vscode.Disposable[] = [];
  private readonly deco = vscode.window.createTextEditorDecorationType({
    rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
    before: {
      color: new vscode.ThemeColor('editorLineNumber.foreground'),
      margin: '0 1.5ch 0 0',
      fontStyle: 'normal',
      fontWeight: 'normal',
      textDecoration: 'none',
    },
  });

  constructor(private readonly ctx: FeatureContext) {
    this.disposables.push(
      this.deco,
      vscode.workspace.onDidChangeTextDocument((e) => this.onEdit(e)),
      vscode.workspace.onDidCloseTextDocument((d) => this.drop(d.uri.toString())),
      vscode.window.onDidChangeVisibleTextEditors(() => this.renderAll()),
      vscode.window.onDidChangeActiveTextEditor(() => this.updateContext()),
      vscode.window.onDidChangeActiveColorTheme(() => this.renderAll()),
      ctx.repos.onDidChangeRepository((repo) => {
        for (const a of this.items.values()) if (a.repo === repo && !a.rev) this.schedule(a);
      }),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (!e.affectsConfiguration('gitPrism.annotate')) return;
        const reblame = BLAME_SETTINGS.some((k) => e.affectsConfiguration(`gitPrism.annotate.${k}`));
        if (reblame) for (const a of this.items.values()) this.schedule(a, 0);
        else this.renderAll();
      }),
    );
    this.updateContext();
  }

  get(uri: vscode.Uri | undefined): Annotation | undefined {
    return uri ? this.items.get(uri.toString()) : undefined;
  }

  /** Toggles annotations of the given (or active) editor's document. */
  async toggle(uri?: vscode.Uri): Promise<void> {
    const editor = await this.editorFor(uri);
    if (!editor) return;
    if (this.items.has(editor.document.uri.toString())) this.close(editor.document.uri);
    else await this.annotate(editor);
  }

  close(uri?: vscode.Uri): void {
    const u = uri ?? vscode.window.activeTextEditor?.document.uri;
    if (u) this.drop(u.toString());
  }

  /** Annotates an editor. `explicit` is used for revision documents whose uri doesn't carry the revision. */
  async annotate(editor: vscode.TextEditor, explicit?: { repo: Repository; path: string; rev?: string }): Promise<Annotation | undefined> {
    const doc = editor.document;
    const target = explicit ?? (await this.targetOf(doc.uri));
    if (!target) return undefined;
    if (!target.rev && !(await this.canAnnotateWorkingCopy(target.repo, target.path))) return undefined;
    const a: Annotation = { key: doc.uri.toString(), uri: doc.uri, repo: target.repo, path: target.path, rev: target.rev, blame: { lines: [], commits: new Map() }, lines: [], gen: 0 };
    try {
      const blame = await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: 'Loading Annotations' }, () => this.runBlame(a, doc, false));
      a.blame = blame;
      a.lines = blame.lines;
    } catch (e) {
      showGitError(e, 'Cannot load annotations');
      return undefined;
    }
    const old = this.items.get(a.key);
    if (old) clearTimeout(old.timer);
    this.items.set(a.key, a);
    this.render(a);
    this.updateContext();
    this.warnShallow(a.repo);
    return a;
  }

  private async targetOf(uri: vscode.Uri): Promise<{ repo: Repository; path: string; rev?: string } | undefined> {
    const q = revisionQueryOf(uri);
    if (q) {
      const repo = this.ctx.repos.get(q.repoRoot) ?? (await this.ctx.repos.open(q.repoRoot));
      if (!repo) {
        vscode.window.showWarningMessage(`Cannot load annotations: ${q.repoRoot} is not a Git repository.`);
        return undefined;
      }
      return { repo, path: q.path, rev: q.rev };
    }
    if (uri.scheme !== 'file') {
      vscode.window.showWarningMessage('Annotate is available for files under Git version control only.');
      return undefined;
    }
    await this.ctx.repos.ready();
    const repo = this.ctx.repos.forUri(uri) ?? (await this.ctx.repos.open(path.dirname(uri.fsPath)));
    if (!repo) {
      vscode.window.showWarningMessage(`'${path.basename(uri.fsPath)}' is not under Git version control.`);
      return undefined;
    }
    return { repo, path: repo.rel(uri.fsPath) };
  }

  /** IntelliJ disables Annotate for unversioned files; a repository without commits has nothing to annotate either. */
  private async canAnnotateWorkingCopy(repo: Repository, rel: string): Promise<boolean> {
    const name = rel.slice(rel.lastIndexOf('/') + 1);
    const tracked = await repo.run(['--literal-pathspecs', 'ls-files', '--error-unmatch', '--', rel], { quiet: true, allowFail: true });
    if (tracked.code !== 0) {
      vscode.window.showWarningMessage(`Cannot load annotations: '${name}' is not under Git version control.`);
      return false;
    }
    if (!(await repo.headHash())) {
      vscode.window.showWarningMessage(`Cannot load annotations: '${name}' has not been committed yet.`);
      return false;
    }
    return true;
  }

  private async runBlame(a: Annotation, doc: vscode.TextDocument, quiet: boolean): Promise<BlameResult> {
    const { flags } = settings();
    if (a.rev) {
      const r = await a.repo.run(['blame', '--porcelain', ...flags, a.rev, '--', a.path], { quiet });
      return parseBlamePorcelain(r.stdout);
    }
    const r = await a.repo.run(['blame', '--porcelain', ...flags, '--contents', '-', '--', a.path], { quiet, input: doc.getText() });
    return parseBlamePorcelain(r.stdout);
  }

  private async warnShallow(repo: Repository): Promise<void> {
    if (this.shallowWarned.has(repo.root)) return;
    this.shallowWarned.add(repo.root);
    const r = await repo.run(['rev-parse', '--is-shallow-repository'], { quiet: true, allowFail: true });
    if (r.stdout.trim() === 'true') vscode.window.showWarningMessage('Annotations might be inaccurate in the shallow repository');
  }

  private onEdit(e: vscode.TextDocumentChangeEvent): void {
    const a = this.items.get(e.document.uri.toString());
    if (!a || a.rev || !e.contentChanges.length) return;
    // changes are non-overlapping and relative to the old text: apply them bottom-up so earlier ones stay valid
    const changes = [...e.contentChanges].sort((x, y) => y.range.start.compareTo(x.range.start));
    for (const ch of changes) {
      const start = ch.range.start.line;
      const removed = ch.range.end.line - start + 1;
      const added = ch.text.split(/\r\n|\r|\n/).length;
      if (removed === 1 && added === 1 && ch.text === '' && ch.range.isEmpty) continue;
      a.lines = shiftLines(a.lines, start, removed, added);
    }
    this.render(a);
    this.schedule(a);
  }

  /** Debounced re-blame (repository changed, document edited, options changed). */
  private schedule(a: Annotation, delay = REBLAME_DELAY): void {
    clearTimeout(a.timer);
    a.timer = setTimeout(() => this.reblame(a), delay);
  }

  private async reblame(a: Annotation): Promise<void> {
    const doc = vscode.workspace.textDocuments.find((d) => d.uri.toString() === a.key);
    if (!doc || this.items.get(a.key) !== a) return;
    const gen = ++a.gen;
    const version = doc.version;
    try {
      const blame = await this.runBlame(a, doc, true);
      if (gen !== a.gen || this.items.get(a.key) !== a) return;
      if (doc.version !== version) return this.schedule(a);
      a.blame = blame;
      a.lines = blame.lines;
      this.render(a);
    } catch {
      // keep the shifted annotations (e.g. file deleted or repository busy); the next change retries
    }
  }

  private drop(key: string): void {
    const a = this.items.get(key);
    if (!a) return;
    clearTimeout(a.timer);
    this.items.delete(key);
    for (const ed of vscode.window.visibleTextEditors) if (ed.document.uri.toString() === key) ed.setDecorations(this.deco, []);
    this.updateContext();
  }

  private renderAll(): void {
    for (const ed of vscode.window.visibleTextEditors) {
      const a = this.items.get(ed.document.uri.toString());
      if (a) this.render(a);
    }
  }

  private render(a: Annotation): void {
    const editors = vscode.window.visibleTextEditors.filter((ed) => ed.document.uri.toString() === a.key);
    if (!editors.length) return;
    const { columns, colorMode } = settings();
    const commits = a.blame.commits;
    const { texts, width } = buildColumns(a.lines, commits, columns);
    const starts = groupStarts(a.lines);
    const steps = colorMode === 'order' ? orderSteps(commits, columns.commitDate) : undefined;
    const dark = isDark();
    const w = Math.max(width, 1);
    const blank = NBSP.repeat(w);
    const count = editors[0].document.lineCount;
    const opts: vscode.DecorationOptions[] = [];
    for (let i = 0; i < count; i++) {
      const l = a.lines[i];
      const c = l && !isUncommitted(l.hash) ? commits.get(l.hash) : undefined;
      let bg: string | undefined;
      if (c && steps) bg = orderColor(steps.get(c.hash) ?? 0, dark);
      else if (c && colorMode === 'author') bg = authorColor(c.authorMail || c.author, dark);
      let text = blank;
      if (c && starts[i]) {
        const t = texts[i].replace(/ /g, NBSP);
        text = t + NBSP.repeat(Math.max(0, w - [...t].length));
      }
      opts.push({ range: new vscode.Range(i, 0, i, 0), renderOptions: { before: { contentText: text, backgroundColor: bg } } });
    }
    for (const ed of editors) ed.setDecorations(this.deco, opts);
  }

  /**
   * `gitPrism.annotate.active`: the active editor is annotated (command palette, keybindings).
   * `gitPrism.annotate.paths`: paths of all annotated documents, so menus of other editors/tabs can use
   * `resourcePath in gitPrism.annotate.paths`.
   */
  private updateContext(): void {
    const active = !!this.get(vscode.window.activeTextEditor?.document.uri);
    const paths = new Set<string>();
    for (const a of this.items.values()) {
      paths.add(a.uri.fsPath);
      paths.add(a.uri.path);
    }
    vscode.commands.executeCommand('setContext', 'gitPrism.annotate.active', active);
    vscode.commands.executeCommand('setContext', 'gitPrism.annotate.paths', [...paths]);
  }

  /** The editor showing `uri` (opened if necessary), else the active one. */
  async editorFor(uri?: vscode.Uri): Promise<vscode.TextEditor | undefined> {
    const active = vscode.window.activeTextEditor;
    if (!uri || active?.document.uri.toString() === uri.toString()) {
      if (!active) vscode.window.showInformationMessage('Open a file in the editor to annotate it.');
      return active;
    }
    const visible = vscode.window.visibleTextEditors.find((e) => e.document.uri.toString() === uri.toString());
    if (visible) return visible;
    try {
      return await vscode.window.showTextDocument(uri, { preview: false });
    } catch (e) {
      showGitError(e, 'Cannot load annotations');
      return undefined;
    }
  }

  /** Resolves the annotated line a command acts on. */
  resolveLine(arg: LineArg): LineTarget | undefined {
    let uri: vscode.Uri | undefined;
    let line: number | undefined;
    if (arg instanceof vscode.Uri) uri = arg;
    else if (arg) {
      uri = typeof arg.uri === 'string' ? vscode.Uri.parse(arg.uri) : arg.uri;
      line = arg.line ?? (arg.lineNumber !== undefined ? arg.lineNumber - 1 : undefined);
    }
    const editor = vscode.window.activeTextEditor;
    uri ??= editor?.document.uri;
    if (line === undefined && editor && uri && editor.document.uri.toString() === uri.toString()) line = editor.selection.active.line;
    const a = this.get(uri);
    if (!a || line === undefined) return undefined;
    const info = a.lines[line];
    if (!info) return undefined;
    return { a, line, info, commit: a.blame.commits.get(info.hash) };
  }

  /** Full commit message (cached). */
  message(repo: Repository, hash: string): Promise<string | undefined> {
    const key = `${repo.root}\0${hash}`;
    let p = this.messages.get(key);
    if (!p) {
      if (this.messages.size >= MAX_CACHED_MESSAGES) this.messages.clear();
      p = repo
        .run(['show', '-s', '--format=%B', hash], { quiet: true })
        .then((r) => r.stdout.replace(/\s+$/, ''))
        .catch(() => undefined);
      this.messages.set(key, p);
    }
    return p;
  }

  /** Hover over the annotation column (column 0 of an annotated line). */
  async hover(doc: vscode.TextDocument, pos: vscode.Position): Promise<vscode.Hover | undefined> {
    if (pos.character !== 0) return undefined;
    const t = this.resolveLine({ uri: doc.uri, line: pos.line });
    if (!t) return undefined;
    const md = new vscode.MarkdownString(undefined, true);
    md.isTrusted = { enabledCommands: HOVER_COMMANDS };
    md.supportHtml = false;
    const arg = encodeURIComponent(JSON.stringify([{ uri: doc.uri.toString(), line: pos.line }]));
    const link = (title: string, cmd: string) => `[${title}](command:${cmd}?${arg} "${title}")`;
    const { columns } = settings();
    const c = t.commit;
    if (!c || isUncommitted(c.hash)) {
      md.appendMarkdown('**Not Committed Yet**\n\n');
      md.appendMarkdown([link('Show Diff', 'gitPrism.annotate.showDiff'), link('Annotate Previous Revision', 'gitPrism.annotate.previousRevision')].join(' &nbsp;|&nbsp; '));
      return new vscode.Hover(md, new vscode.Range(pos.line, 0, pos.line, 0));
    }
    md.appendMarkdown(`commit ${link(c.hash, 'gitPrism.annotate.showCommitInLog')}  \n`);
    md.appendText(`Author: ${exactUser(c.author, c.authorMail)}`);
    md.appendMarkdown('  \n');
    md.appendText(`Date: ${formatDateTime(commitTime(c, columns.commitDate), columns.locale)}`);
    md.appendMarkdown('  \n');
    const file = t.info.filename || c.filename;
    if (file && file !== t.a.path) {
      md.appendText(`Path: ${file}`);
      md.appendMarkdown('  \n');
    }
    const msg = (await this.message(t.a.repo, c.hash)) ?? `${c.summary}\n...`;
    md.appendMarkdown('\n');
    md.appendCodeblock(msg, 'text');
    md.appendMarkdown('\n---\n\n');
    const links = [
      link('Show in Git Log', 'gitPrism.annotate.showCommitInLog'),
      link('Show Diff', 'gitPrism.annotate.showDiff'),
      link('Show Affected Files', 'gitPrism.annotate.showAffectedFiles'),
      ...(c.previous ? [link('Annotate Previous Revision', 'gitPrism.annotate.previousRevision')] : []),
      link('Copy Revision Number', 'gitPrism.annotate.copyRevision'),
    ];
    md.appendMarkdown(links.join(' &nbsp;|&nbsp; '));
    return new vscode.Hover(md, new vscode.Range(pos.line, 0, pos.line, 0));
  }

  /** Diff of the annotated file in the line's commit (or the local changes for an uncommitted line). */
  async showDiff(t: LineTarget): Promise<void> {
    const { a, info, commit: c } = t;
    let left: ContentRef;
    let right: ContentRef;
    let rightPath = a.path;
    if (!c || isUncommitted(c.hash)) {
      const head = await a.repo.headHash();
      left = c?.previous ? { rev: c.previous.hash, path: c.previous.path } : head ? { rev: head, path: a.path } : { empty: true };
      const doc = vscode.workspace.textDocuments.find((d) => d.uri.toString() === a.key);
      if (a.rev) right = { rev: a.rev, path: a.path };
      else right = doc?.isDirty ? { text: doc.getText(), label: 'Your version' } : { worktree: true, path: a.path };
    } else {
      rightPath = info.filename || c.filename || a.path;
      left = c.previous ? { rev: c.previous.hash, path: c.previous.path } : { empty: true };
      right = { rev: c.hash, path: rightPath };
    }
    const kind = 'empty' in left ? 'A' : c?.previous && c.previous.path !== rightPath ? 'R' : 'M';
    const oldPath = 'path' in left && left.path !== rightPath ? left.path : undefined;
    try {
      await invoke('gitPrism.diff.show', { files: [{ repoRoot: a.repo.root, path: rightPath, oldPath, kind, left, right }] });
    } catch (e) {
      showGitError(e, 'Cannot load data to show diff');
    }
  }

  /** All files changed by the line's commit. */
  async showAffectedFiles(t: LineTarget): Promise<void> {
    const c = t.commit;
    if (!c || isUncommitted(c.hash)) {
      invoke('gitPrism.changes.show', { repoRoot: t.a.repo.root, from: 'HEAD' });
      return;
    }
    try {
      const from = (await t.a.repo.run(['rev-parse', '--verify', '--quiet', `${c.hash}^`], { quiet: true, allowFail: true })).stdout.trim() || (await emptyTree(t.a.repo));
      await invoke('gitPrism.changes.show', { repoRoot: t.a.repo.root, from, to: c.hash, title: c.summary });
    } catch (e) {
      showGitError(e, `Cannot load affected files for path '${t.a.path}' in revision '${c.hash.slice(0, 8)}'`);
    }
  }

  /** Annotate Revision: opens the file as of the line's commit and annotates it (caret on the same line). */
  async currentRevision(t: LineTarget, hash: string): Promise<void> {
    const file = t.info.filename || t.commit?.filename || t.a.path;
    await this.annotateRevision({ repoRoot: t.a.repo.root, path: file, rev: hash }, Math.max(0, t.info.origLine - 1));
  }

  /**
   * Annotate Previous Revision: opens the file at the revision before the line's commit (HEAD for a not committed
   * line) and annotates it, with the caret on the corresponding line of that version.
   */
  async previousRevision(t: LineTarget): Promise<void> {
    const c = t.commit;
    const uncommitted = !c || isUncommitted(c.hash);
    const prev = c?.previous ?? (uncommitted ? await this.headOf(t.a) : undefined);
    if (!prev) {
      vscode.window.showInformationMessage('There is no previous revision of this file.');
      return;
    }
    let line = Math.max(0, t.info.origLine - 1);
    try {
      // the line number in the commit's version → the line of the previous version
      const doc = vscode.workspace.textDocuments.find((d) => d.uri.toString() === t.a.key);
      const from = uncommitted ? (t.a.rev ? undefined : doc?.getText()) : (await t.a.repo.show(c.hash, t.info.filename || c.filename || t.a.path))?.toString('utf8');
      const base = (await t.a.repo.show(prev.hash, prev.path))?.toString('utf8');
      if (uncommitted) line = t.line;
      if (from !== undefined && base !== undefined) {
        const baseLines = base.split(/\r\n|\r|\n/);
        line = Math.min(mapLineToBase(diffLines(baseLines, from.split(/\r\n|\r|\n/)), line), baseLines.length - 1);
      }
    } catch {
      /* keep the unmapped line */
    }
    await this.annotateRevision({ repoRoot: t.a.repo.root, path: prev.path, rev: prev.hash }, line);
  }

  private async headOf(a: Annotation): Promise<{ hash: string; path: string } | undefined> {
    const h = await a.repo.headHash();
    return h ? { hash: h, path: a.path } : undefined;
  }

  /** gitPrism.annotate.revision: opens the file at `rev` (read-only) and annotates it. */
  async annotateRevision(args: { repoRoot: string; path: string; rev: string }, line?: number): Promise<void> {
    if (!args?.repoRoot || !args.path || !args.rev) return;
    const repo = this.ctx.repos.get(args.repoRoot) ?? (await this.ctx.repos.open(args.repoRoot));
    if (!repo) {
      vscode.window.showWarningMessage(`${args.repoRoot} is not a Git repository.`);
      return;
    }
    if (!(await repo.show(args.rev, args.path))) {
      const short = /^[0-9a-f]{40}/i.test(args.rev) ? args.rev.slice(0, 8) : args.rev;
      vscode.window.showWarningMessage(`Cannot load annotations: file ${args.path} doesn't exist in revision ${short}.`);
      return;
    }
    let editor: vscode.TextEditor | undefined;
    try {
      // the compare feature opens `gitprism-rev:` documents and resolves the revision to a hash
      await invoke('gitPrism.openFileAtRevision', args);
      const now = vscode.window.activeTextEditor;
      const q = now && revisionQueryOf(now.document.uri);
      if (now && q && q.path === args.path && path.resolve(q.repoRoot) === repo.root) editor = now;
    } catch {
      editor = undefined;
    }
    if (!editor) {
      // fallback: this feature's own read-only document
      const q = JSON.stringify({ repoRoot: repo.root, rev: args.rev, path: args.path });
      const short = /^[0-9a-f]{40}/i.test(args.rev) ? args.rev.slice(0, 8) : args.rev;
      const uri = vscode.Uri.from({ scheme: OWN_SCHEME, path: `/${args.path} (${short})`, query: q });
      try {
        editor = await vscode.window.showTextDocument(uri, { preview: false });
      } catch (e) {
        showGitError(e, 'Cannot load annotations');
        return;
      }
    }
    const a = await this.annotate(editor, { repo, path: args.path, rev: revisionQueryOf(editor.document.uri)?.rev ?? args.rev });
    if (a && line !== undefined && line < editor.document.lineCount) {
      const pos = new vscode.Position(line, 0);
      editor.selection = new vscode.Selection(pos, pos);
      editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
    }
  }

  dispose(): void {
    for (const a of this.items.values()) clearTimeout(a.timer);
    for (const d of this.disposables) d.dispose();
  }
}

export const HOVER_COMMANDS = [
  'gitPrism.annotate.currentRevision',
  'gitPrism.annotate.showCommitInLog',
  'gitPrism.annotate.showDiff',
  'gitPrism.annotate.showAffectedFiles',
  'gitPrism.annotate.previousRevision',
  'gitPrism.annotate.copyRevision',
];

async function emptyTree(repo: Repository): Promise<string> {
  return (await repo.run(['hash-object', '-t', 'tree', '--stdin'], { quiet: true, input: '' })).stdout.trim();
}

/** Read-only content of this feature's fallback revision documents. */
export class RevisionContentProvider implements vscode.TextDocumentContentProvider {
  constructor(private readonly ctx: FeatureContext) {}

  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const q = revisionQueryOf(uri);
    if (!q) return '';
    const repo = this.ctx.repos.get(q.repoRoot) ?? (await this.ctx.repos.open(q.repoRoot));
    const buf = repo ? await repo.show(q.rev, q.path) : undefined;
    return buf ? buf.toString('utf8').replace(/^﻿/, '') : '';
  }
}
