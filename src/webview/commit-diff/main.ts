// Diff window of the Commit tool window (changelist mode, host: src/features/commit/diffPanel.ts): HEAD vs the working
// tree in ide-diff with IntelliJ's partial commit UI — an "Include into commit" checkbox per changed chunk in the
// gutter of the current version, excluded lines drawn without fill, the file checkbox in the toolbar, and the editor
// context menu actions Split Chunks and Include/Exclude Selected Lines into/from Commit and Include Lines into Commit.
// The right side is editable (sent to the host, which saves the file); F4 jumps to the source.
import { RangeSet, StateEffect, StateField, type EditorState, type Extension, type Range } from '@codemirror/state';
import { Decoration, EditorView, GutterMarker, gutter, type DecorationSet } from '@codemirror/view';
import { createDiffViewer, injectStyles, type DiffViewerHost, type DiffViewerOptions } from '@ide-diff/viewer';
import { languageFor } from '../shared/languages';
import { init, rpc } from '../shared/rpc';
import { keysForSelection, viewKeys, viewState, type HunkView, type LineState } from '../../features/commit/partial';
import type { CommitDiffInit, CommitDiffPayload, CommitDiffSide } from '../../features/commit/protocol';
import { BASE_CSS, el, FileNav, iconButton, injectCss, IS_MAC, key, onThemeChange, rethemeIcons, sep, theme } from './chrome';

type Impl = ReturnType<DiffViewerHost['getImplementation']>;
type Settings = ReturnType<Impl['exportOptions']>;
type Appearance = Pick<Settings, 'showWhitespaces' | 'showLineNumbers' | 'softWraps'>;

const data = init<CommitDiffInit & { settings?: { viewer?: Partial<DiffViewerOptions>; appearance?: Appearance } }>();
const files = data.files ?? [];
let index = data.index ?? 0;
let payload: CommitDiffPayload | undefined;
let viewer: DiffViewerHost | undefined;
/** right text as last loaded or sent to the host */
let sent = '';
let editTimer: number | undefined;
let loadSeq = 0;
let lastFocus: 'left' | 'right' = 'right';
let busy = false;
let settings = data.settings?.viewer ?? {};
let appearance = data.settings?.appearance;

injectStyles();
injectCss(
  BASE_CSS +
    `
.idd-title-text .rev { color: var(--idd-title-fg); margin-right: 8px; }
.idd-title-text .path { color: var(--idd-title-secondary-fg, var(--vscode-descriptionForeground)); }
.incl { display: inline-flex; align-items: center; gap: 6px; height: 24px; padding: 0 6px; margin: 0 2px; border-radius: 4px; cursor: pointer; white-space: nowrap; user-select: none; }
.incl:hover { background: var(--vscode-toolbar-hoverBackground); }
.jb-cb { flex: none; width: 14px; height: 14px; border-radius: 3px; box-sizing: border-box; display: inline-flex; align-items: center; justify-content: center;
  border: 1px solid var(--vscode-checkbox-border, var(--vscode-input-border, rgba(128,128,128,.6))); background: var(--vscode-checkbox-background, var(--vscode-input-background));
  color: var(--vscode-button-foreground, #fff); cursor: pointer; }
.jb-cb.on, .jb-cb.mixed { background: var(--vscode-button-background, #3574f0); border-color: var(--vscode-button-background, #3574f0); }
.jb-cb.on::after { content: ''; width: 7px; height: 4px; margin-top: -2px; border: solid currentColor; border-width: 0 0 1.5px 1.5px; transform: rotate(-45deg); }
.jb-cb.mixed::after { content: ''; width: 7px; height: 1.5px; background: currentColor; }
.jb-cb:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 1px; }
.jb-incl-gutter { cursor: default; }
.jb-incl-gutter .cm-gutterElement { display: flex; align-items: center; gap: 2px; padding: 0 3px 0 4px; }
.jb-incl-gutter .jb-chunk-checks { display: inline-flex; gap: 2px; }
.jb-incl-gutter .jb-cb { width: 13px; height: 13px; }
/* excluded changed lines: IntelliJ draws them as "ignored" ranges (no fill, only the change marker) */
.cm-line.jb-excluded { background: transparent !important; box-shadow: inset 3px 0 0 var(--jb-modified); opacity: .75; }
.cm-line.jb-excluded * { background-color: transparent !important; }
.cm-line.jb-excluded.jb-ex-left { box-shadow: inset 3px 0 0 var(--jb-deleted); }
.jb-menu { position: fixed; z-index: 200; min-width: 220px; padding: 4px; border-radius: 8px; outline: none;
  background: var(--vscode-menu-background, var(--vscode-editorWidget-background)); color: var(--vscode-menu-foreground, var(--vscode-foreground));
  border: 1px solid var(--vscode-menu-border, var(--vscode-widget-border, var(--jb-border))); box-shadow: 0 4px 16px var(--vscode-widget-shadow, rgba(0,0,0,.35)); }
.jb-menu .mi { height: 24px; display: flex; align-items: center; gap: 24px; padding: 0 10px; border-radius: 4px; cursor: pointer; white-space: nowrap; }
.jb-menu .mi .sc { margin-left: auto; color: var(--vscode-descriptionForeground); }
.jb-menu .mi.active { background: var(--vscode-menu-selectionBackground, var(--vscode-list-activeSelectionBackground)); color: var(--vscode-menu-selectionForeground, var(--vscode-list-activeSelectionForeground)); }
.jb-menu .mi.active .sc { color: inherit; }
.jb-menu .mi.disabled { color: var(--vscode-disabledForeground); cursor: default; }
.jb-menu .ms { height: 1px; margin: 4px 6px; background: var(--vscode-menu-separatorBackground, var(--jb-border)); }
`,
);

const app = document.getElementById('app')!;
app.className = `idd-theme-${theme()}`;
const stage = el('div');
stage.id = 'stage';
app.append(stage);

const nav = new FileNav(files, () => index, (i, reveal) => switchTo(i, reveal), stage);

// ------------------------------------------------------------------ inclusion gutter + excluded lines

interface Mark {
  /** 1-based line in this editor */
  line: number;
  hunk: string;
  state: LineState;
}
interface InclSpec {
  marks: Mark[];
  /** 1-based lines drawn as excluded */
  excluded: number[];
  left: boolean;
}

const setIncl = StateEffect.define<InclSpec>();

function checkbox(state: LineState): HTMLElement {
  const b = el('span', `jb-cb ${state}`);
  b.setAttribute('role', 'checkbox');
  b.setAttribute('aria-checked', state === 'mixed' ? 'mixed' : String(state === 'on'));
  return b;
}

class ChunkMarker extends GutterMarker {
  constructor(readonly hunks: readonly { id: string; state: LineState }[]) {
    super();
  }
  eq(o: ChunkMarker): boolean {
    return o.hunks.length === this.hunks.length && o.hunks.every((h, i) => h.id === this.hunks[i].id && h.state === this.hunks[i].state);
  }
  toDOM(): Node {
    const f = el('span', 'jb-chunk-checks');
    for (const h of this.hunks) {
      const b = checkbox(h.state);
      b.dataset.hunk = h.id;
      b.title = 'Include into commit';
      f.append(b);
    }
    return f;
  }
}

interface InclValue {
  markers: RangeSet<GutterMarker>;
  lines: DecorationSet;
}

function buildIncl(state: EditorState, spec: InclSpec): InclValue {
  const doc = state.doc;
  const clamp = (l: number) => Math.max(1, Math.min(l, doc.lines));
  const byLine = new Map<number, { id: string; state: LineState }[]>();
  for (const m of spec.marks) {
    const l = clamp(m.line);
    const list = byLine.get(l) ?? [];
    list.push({ id: m.hunk, state: m.state });
    byLine.set(l, list);
  }
  const markers = [...byLine.entries()].sort((a, b) => a[0] - b[0]).map(([l, hs]) => new ChunkMarker(hs).range(doc.line(l).from));
  const deco = Decoration.line({ class: spec.left ? 'jb-excluded jb-ex-left' : 'jb-excluded' });
  const lines: Range<Decoration>[] = [...new Set(spec.excluded.filter((l) => l >= 1 && l <= doc.lines))].sort((a, b) => a - b).map((l) => deco.range(doc.line(l).from));
  return { markers: RangeSet.of(markers), lines: Decoration.set(lines) };
}

const inclField = StateField.define<InclValue>({
  create: () => ({ markers: RangeSet.empty, lines: Decoration.none }),
  update(v, tr) {
    for (const e of tr.effects) if (e.is(setIncl)) return buildIncl(tr.state, e.value);
    return tr.docChanged ? { markers: v.markers.map(tr.changes), lines: v.lines.map(tr.changes) } : v;
  },
  provide: (f) => EditorView.decorations.from(f, (v) => v.lines),
});

const inclusion: Extension = [
  inclField,
  gutter({
    class: 'jb-incl-gutter',
    markers: (v) => v.state.field(inclField).markers,
    domEventHandlers: {
      mousedown: (_view, _line, ev) => {
        const t = (ev.target as HTMLElement).closest<HTMLElement>('[data-hunk]');
        if (!t) return false;
        ev.preventDefault();
        toggleHunk(t.dataset.hunk!);
        return true;
      },
    },
  }),
];

function editors(): [EditorView, EditorView] | undefined {
  const impl = viewer?.getImplementation();
  return impl && 'getEditors' in impl ? impl.getEditors() : undefined;
}

/** Puts the checkboxes / excluded line marks of the payload into the editors. */
function paintInclusion(): void {
  const eds = editors();
  if (!eds || !payload) return;
  const hunks = payload.lines ? payload.hunks : [];
  const right: InclSpec = { marks: [], excluded: [], left: false };
  const left: InclSpec = { marks: [], excluded: [], left: true };
  for (const h of hunks) {
    right.marks.push({ line: h.newLine, hunk: h.id, state: viewState(h) });
    for (const i of h.excludedAdded) right.excluded.push(h.newLine + i);
    for (const i of h.excludedRemoved) left.excluded.push(h.oldLine + i);
  }
  eds[0].dispatch({ effects: setIncl.of(left) });
  eds[1].dispatch({ effects: setIncl.of(right) });
}

function excludedKeys(hunks: readonly HunkView[]): Set<string> {
  const out = new Set<string>();
  for (const h of hunks) {
    for (const i of h.excludedRemoved) out.add(`${h.id}:-${i}`);
    for (const i of h.excludedAdded) out.add(`${h.id}:+${i}`);
  }
  return out;
}

/** Sends the new excluded line set of the file; the host answers with the updated payload. */
async function setExcluded(excluded: Set<string>): Promise<void> {
  if (!payload || busy) return;
  const p = payload;
  const all = p.hunks.flatMap(viewKeys);
  busy = true;
  try {
    const next = await rpc.call<CommitDiffPayload>('setLines', { index: p.index, excluded: [...excluded], all });
    if (next.index === index) applyInclusion(next);
  } finally {
    busy = false;
  }
}

function toggleHunk(id: string): void {
  const h = payload?.hunks.find((x) => x.id === id);
  if (!h || !payload) return;
  const ex = excludedKeys(payload.hunks);
  const keys = viewKeys(h);
  // like IntelliJ: a partially included chunk becomes fully included
  if (viewState(h) === 'on') keys.forEach((k) => ex.add(k));
  else keys.forEach((k) => ex.delete(k));
  void setExcluded(ex);
}

async function toggleFile(): Promise<void> {
  if (!payload?.checkable || busy) return;
  const state = fileState(payload);
  busy = true;
  try {
    const next = await rpc.call<CommitDiffPayload>('setIncluded', { index: payload.index, included: state !== 'on' });
    if (next.index === index) applyInclusion(next);
  } finally {
    busy = false;
  }
}

function fileState(p: CommitDiffPayload): LineState {
  if (!p.included) return 'off';
  if (p.lines && p.hunks.some((h) => viewState(h) !== 'on')) return p.hunks.some((h) => viewState(h) !== 'off') ? 'mixed' : 'off';
  return 'on';
}

/** New inclusion state of the current file (texts unchanged). */
function applyInclusion(p: CommitDiffPayload): void {
  if (!payload) return;
  payload = { ...payload, included: p.included, checkable: p.checkable, lines: p.lines, hunks: p.hunks };
  paintInclusion();
  updateToolbar();
}

// ------------------------------------------------------------------ line actions (Vcs.Diff.*ChangedLines*)

interface LineAction {
  label: string;
  enabled: boolean;
  run(): void;
}

/** The actions for the selection of the focused editor (side-by-side mode only). */
function lineActions(): LineAction[] {
  const eds = editors();
  if (!eds || !payload?.lines || !payload.hunks.length) return [];
  const side = lastFocus === 'left' ? 0 : 1;
  const st = eds[side].state;
  const sel = st.selection.main;
  const from = st.doc.lineAt(sel.from).number;
  let to = st.doc.lineAt(sel.to).number;
  if (to > from && sel.to === st.doc.line(to).from) to--;
  const keys = keysForSelection(payload.hunks, side === 0 ? 'old' : 'new', from, to);
  const touched = payload.hunks.filter((h) => keys.some((k) => k.startsWith(`${h.id}:`)));
  const keySet = new Set(keys);
  const split = touched.filter((h) => !viewKeys(h).every((k) => keySet.has(k))).length;
  const ex = excludedKeys(payload.hunks);
  const prefix = split === 0 ? '' : split === 1 ? 'Split Chunk and ' : 'Split Chunks and ';
  const what = sel.empty || from === to ? 'Current Line' : 'Selected Lines';
  const whole = touched.flatMap(viewKeys);
  return [
    {
      label: `${prefix}Include ${what} into Commit`,
      enabled: keys.some((k) => ex.has(k)),
      run: () => void setExcluded(new Set([...ex].filter((k) => !keySet.has(k)))),
    },
    {
      label: `${prefix}Exclude ${what} from Commit`,
      enabled: keys.some((k) => !ex.has(k)),
      run: () => void setExcluded(new Set([...ex, ...keys])),
    },
    {
      label: 'Include Lines into Commit',
      enabled: whole.some((k) => ex.has(k)),
      run: () => {
        const w = new Set(whole);
        void setExcluded(new Set([...ex].filter((k) => !w.has(k))));
      },
    },
  ];
}

let menu: HTMLElement | undefined;

function closeMenu(): void {
  menu?.remove();
  menu = undefined;
}

type MenuEntry = { label: string; shortcut?: string; enabled?: boolean; run(): void } | '-';

function showMenu(entries: MenuEntry[], x: number, y: number): void {
  closeMenu();
  const box = el('div', 'jb-menu');
  box.tabIndex = -1;
  box.setAttribute('role', 'menu');
  const items: { el: HTMLElement; e: Exclude<MenuEntry, '-'> }[] = [];
  let active = -1;
  const setActive = (i: number) => {
    items.forEach((it, n) => it.el.classList.toggle('active', n === i));
    active = i;
  };
  for (const e of entries) {
    if (e === '-') {
      box.append(el('div', 'ms'));
      continue;
    }
    const mi = el('div', `mi${e.enabled === false ? ' disabled' : ''}`);
    mi.setAttribute('role', 'menuitem');
    mi.append(el('span', '', e.label));
    if (e.shortcut) mi.append(el('span', 'sc', e.shortcut));
    const n = items.length;
    items.push({ el: mi, e });
    mi.addEventListener('mousemove', () => e.enabled !== false && setActive(n));
    mi.addEventListener('mousedown', (ev) => ev.preventDefault());
    mi.addEventListener('click', () => {
      if (e.enabled === false) return;
      closeMenu();
      e.run();
    });
    box.append(mi);
  }
  box.addEventListener('keydown', (ev) => {
    const enabled = items.map((it, i) => (it.e.enabled === false ? -1 : i)).filter((i) => i >= 0);
    if (!enabled.length && ev.key !== 'Escape') return;
    const pos = enabled.indexOf(active);
    if (ev.key === 'ArrowDown') setActive(enabled[(pos + 1) % enabled.length]);
    else if (ev.key === 'ArrowUp') setActive(enabled[(pos - 1 + enabled.length) % enabled.length] ?? enabled[enabled.length - 1]);
    else if (ev.key === 'Enter' && active >= 0) {
      const e = items[active].e;
      closeMenu();
      e.run();
    } else if (ev.key === 'Escape') closeMenu();
    else return;
    ev.preventDefault();
    ev.stopPropagation();
  });
  document.body.append(box);
  menu = box;
  box.style.left = `${Math.max(4, Math.min(x, window.innerWidth - box.offsetWidth - 4))}px`;
  box.style.top = `${Math.max(4, Math.min(y, window.innerHeight - box.offsetHeight - 4))}px`;
  box.focus();
}

document.addEventListener('mousedown', (e) => {
  if (menu && !menu.contains(e.target as Node)) closeMenu();
});

stage.addEventListener('contextmenu', (e) => {
  const eds = editors();
  const t = e.target as Node;
  const inLeft = !!eds?.[0].dom.contains(t);
  const inRight = !!eds?.[1].dom.contains(t);
  const unified = !eds && !!viewer && !!stage.querySelector('.cm-editor')?.contains(t);
  if (!inLeft && !inRight && !unified) return;
  e.preventDefault();
  if (inLeft) lastFocus = 'left';
  if (inRight) lastFocus = 'right';
  const hasSel = !!window.getSelection()?.toString();
  const entries: MenuEntry[] = [{ label: 'Copy', shortcut: key('⌘C', 'Ctrl+C'), enabled: hasSel, run: () => document.execCommand('copy') }];
  const actions = lineActions();
  if (actions.length) entries.push('-', ...actions);
  entries.push('-', { label: 'Jump to Source', shortcut: key('⌘↓', 'F4'), enabled: !!payload?.canJump, run: jump });
  showMenu(entries, e.clientX, e.clientY);
});

// ------------------------------------------------------------------ toolbar

/** Fills a title "<revision> <path>" like IntelliJ: revision label, then the path in a secondary color. */
function titleText(side: CommitDiffSide): string {
  return side.path ? `${side.title} ${side.path}` : side.title;
}

function decorateTitles(): void {
  if (!payload) return;
  for (const t of stage.querySelectorAll<HTMLElement>('.idd-title-text')) {
    const text = t.textContent ?? '';
    const side = text === titleText(payload.left) ? payload.left : text === titleText(payload.right) ? payload.right : undefined;
    if (!side?.path || t.querySelector('.rev')) continue;
    t.replaceChildren(el('span', 'rev', side.title), el('span', 'path', side.path));
    t.title = `${side.title}  ${side.path}`;
  }
}
new MutationObserver(decorateTitles).observe(stage, { childList: true, subtree: true });

function inclToggle(): HTMLElement {
  const wrap = el('span', 'incl');
  wrap.id = 'inclFile';
  wrap.title = 'Include into commit';
  wrap.append(checkbox('off'), el('span', '', 'Include into commit'));
  wrap.addEventListener('mousedown', (e) => e.preventDefault());
  wrap.addEventListener('click', () => void toggleFile());
  return wrap;
}

function extraButtons(): HTMLElement[] {
  return [sep(), iconButton('generalEdit', `Jump to Source (${key('F4 or ⌘↓', 'F4')})`, jump, 'jumpSource'), ...nav.buttons(), sep(), inclToggle()];
}

function updateToolbar(): void {
  nav.update();
  const jumpBtn = document.getElementById('jumpSource') as HTMLButtonElement | null;
  if (jumpBtn) jumpBtn.disabled = !payload?.canJump;
  const incl = document.getElementById('inclFile');
  if (incl) {
    incl.style.display = payload?.checkable ? '' : 'none';
    const state = payload ? fileState(payload) : 'off';
    incl.firstElementChild?.replaceWith(checkbox(state));
  }
}

function addToolbarButtons(): void {
  const left = stage.querySelector('.idd-toolbar-left');
  if (!left || left.querySelector('#jumpSource')) return;
  const anchor = left.children[1] ?? left.lastElementChild;
  if (anchor) anchor.after(...extraButtons());
  else left.append(...extraButtons());
  updateToolbar();
}

onThemeChange((t) => {
  app.className = `idd-theme-${t}`;
  rethemeIcons();
  viewer?.setOptions({ theme: t });
});

// ------------------------------------------------------------------ viewer

function saveSettings(): void {
  if (!viewer) return;
  const o = viewer.getImplementation().exportOptions();
  const next = { mode: o.mode, ignorePolicy: o.ignorePolicy, highlightPolicy: o.highlightPolicy, collapseUnchanged: o.collapseUnchanged, syncScroll: o.syncScroll };
  const look = { showWhitespaces: o.showWhitespaces, showLineNumbers: o.showLineNumbers, softWraps: o.softWraps };
  if (JSON.stringify([next, look]) === JSON.stringify([settings, appearance])) return;
  settings = next;
  appearance = look;
  rpc.call('settings', { viewer: settings, appearance }).catch(() => undefined);
}

function sendEdit(): void {
  window.clearTimeout(editTimer);
  editTimer = undefined;
  if (!viewer || !payload?.right.editable) return;
  const text = viewer.getModified();
  if (text === sent) return;
  sent = text;
  rpc.call('edit', { index: payload.index, text }).catch(() => undefined);
}

function disposeViewer(): void {
  if (!viewer) return;
  sendEdit();
  saveSettings();
  viewer.dispose();
  viewer = undefined;
}

type Reveal = 'first' | 'last';

function revealChange(which: Reveal): void {
  const changes = viewer?.getChanges() ?? [];
  const c = which === 'first' ? changes[0] : changes[changes.length - 1];
  if (!c) return;
  const eds = editors();
  if (!eds) {
    if (which === 'first') viewer?.goToNextChange();
    else viewer?.goToPreviousChange();
    return;
  }
  const ed = eds[1];
  const pos = ed.state.doc.line(Math.min(c.startLine2 + 1, ed.state.doc.lines)).from;
  ed.dispatch({ selection: { anchor: pos }, effects: EditorView.scrollIntoView(pos, { y: 'center' }) });
}

function renderText(p: CommitDiffPayload, reveal: Reveal): void {
  const container = el('div', 'viewer');
  stage.replaceChildren(container);
  sent = p.right.text ?? '';
  viewer = createDiffViewer(container, {
    ...settings,
    original: p.left.text ?? '',
    modified: sent,
    originalTitle: titleText(p.left),
    modifiedTitle: titleText(p.right),
    language: languageFor(p.language),
    theme: theme(),
    readOnly: { original: true, modified: !p.right.editable },
    extensions: [inclusion],
  });
  if (appearance) (viewer.getImplementation() as unknown as { setAppearance(a: Appearance): void }).setAppearance(appearance);
  viewer.onDidChange(() => {
    if (payload?.right.editable && editTimer === undefined) editTimer = window.setTimeout(sendEdit, 300);
  });
  viewer.onDidChangeMode(() => {
    addToolbarButtons();
    paintInclusion();
    saveSettings();
  });
  addToolbarButtons();
  decorateTitles();
  paintInclusion();
  revealChange(reveal);
}

function renderMessage(p: CommitDiffPayload): void {
  const root = el('div', 'fb idd-root');
  const toolbar = el('div', 'idd-toolbar');
  const left = el('div', 'idd-toolbar-left');
  left.append(...extraButtons().slice(1));
  toolbar.append(left, el('div', 'idd-toolbar-spacer'));
  const body = el('div', 'fb-body');
  body.append(el('div', '', p.message ?? ''));
  const link = el('a', '', 'Show Diff');
  link.addEventListener('click', () => void rpc.call('showInDiffViewer', { index: p.index }));
  body.append(link);
  root.append(toolbar, body);
  stage.replaceChildren(root);
}

function render(p: CommitDiffPayload, reveal: Reveal = 'first'): void {
  disposeViewer();
  nav.hideHint();
  closeMenu();
  payload = p;
  if (p.type === 'text') renderText(p, reveal);
  else renderMessage(p);
  updateToolbar();
}

async function load(i: number, reveal: Reveal = 'first'): Promise<void> {
  const seq = ++loadSeq;
  index = i;
  nav.update();
  try {
    const p = await rpc.call<CommitDiffPayload>('load', i);
    if (seq === loadSeq) render(p, reveal);
  } catch (e) {
    if (seq !== loadSeq) return;
    const f = files[i];
    render({
      index: i,
      key: f?.key ?? '',
      path: f?.path ?? '',
      language: 'plaintext',
      type: 'message',
      message: e instanceof Error ? e.message : String(e),
      left: { title: '' },
      right: { title: '', editable: false },
      checkable: false,
      included: false,
      lines: false,
      hunks: [],
      canJump: false,
    });
  }
}

function switchTo(i: number, reveal: Reveal = 'first'): void {
  if (i < 0 || i >= files.length) return;
  sendEdit();
  nav.closePopup();
  void load(i, reveal);
}

/** Line of the caret in the current version (left side lines are mapped through the changes). */
function caretLine(): number {
  const eds = editors();
  const changes = viewer?.getChanges() ?? [];
  if (!eds) return changes[0]?.startLine2 ?? 0;
  const side = lastFocus === 'left' ? 0 : 1;
  const st = eds[side].state;
  const ln = st.doc.lineAt(st.selection.main.head).number - 1;
  if (side === 1) return ln;
  let delta = 0;
  for (const c of changes) {
    if (ln < c.startLine1) break;
    if (ln < c.endLine1) return Math.min(c.startLine2 + (ln - c.startLine1), Math.max(c.startLine2, c.endLine2 - 1));
    delta = c.endLine2 - c.endLine1;
  }
  return ln + delta;
}

function jump(): void {
  if (!payload?.canJump) return;
  const line = caretLine();
  sendEdit();
  rpc.call('jump', { index: payload.index, line }).catch(() => undefined);
}

function hasChange(dir: 1 | -1): boolean {
  const impl = viewer?.getImplementation() as unknown as { findChange?: (d: number) => number } | undefined;
  if (!impl) return false;
  return typeof impl.findChange === 'function' ? impl.findChange(dir) >= 0 : true;
}

function navigateDifference(dir: 1 | -1): void {
  if (viewer && hasChange(dir)) {
    nav.hideHint();
    if (dir > 0) viewer.goToNextChange();
    else viewer.goToPreviousChange();
    return;
  }
  nav.pastEnd(dir);
}

document.addEventListener('focusin', (e) => {
  const eds = editors();
  const t = e.target as Node;
  if (eds?.[0].dom.contains(t)) lastFocus = 'left';
  else if (eds?.[1].dom.contains(t)) lastFocus = 'right';
});

// ------------------------------------------------------------------ keyboard (IntelliJ default / macOS keymaps)

document.addEventListener(
  'keydown',
  (e) => {
    if (menu) return;
    const mod = IS_MAC ? e.metaKey : e.ctrlKey;
    const arrow = e.key === 'ArrowLeft' ? -1 : e.key === 'ArrowRight' ? 1 : 0;
    const fileNav = arrow && e.shiftKey && !e.metaKey && (IS_MAC ? e.ctrlKey && !e.altKey : e.altKey && !e.ctrlKey);
    if (e.key !== 'F7' && e.key !== 'Shift') nav.hideHint();
    if (fileNav && files.length > 1 && !nav.popupOpen) nav.move(arrow);
    else if ((e.key === 'F4' && !e.altKey && !mod && !e.shiftKey) || (IS_MAC && e.metaKey && !e.altKey && !e.ctrlKey && !e.shiftKey && e.key === 'ArrowDown')) jump();
    else if (mod && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 's') sendEdit();
    else if (e.key === 'F7' && !mod && !e.altKey && !nav.popupOpen) navigateDifference(e.shiftKey ? -1 : 1);
    else if ((e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey)) && editors()) {
      const ed = editors()![lastFocus === 'left' ? 0 : 1];
      const r = ed.coordsAtPos(ed.state.selection.main.head);
      if (!r) return;
      openMenuAt(r.left, r.bottom);
    } else return;
    e.preventDefault();
    e.stopPropagation();
  },
  true,
);

function openMenuAt(x: number, y: number): void {
  if (menu) return;
  const actions = lineActions();
  const entries: MenuEntry[] = [];
  if (actions.length) entries.push(...actions, '-');
  entries.push({ label: 'Jump to Source', shortcut: key('⌘↓', 'F4'), enabled: !!payload?.canJump, run: jump });
  showMenu(entries, x, y);
}

// Esc closes the diff window like IntelliJ, unless something inside (search, popup, menu) consumed it.
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || e.defaultPrevented || nav.popupOpen || menu || document.querySelector('.idd-popup')) return;
  if (nav.hideHint()) return;
  sendEdit();
  rpc.call('close').catch(() => undefined);
});

rpc.on<CommitDiffPayload>('reload', (p) => {
  if (p.index !== index) return;
  if (viewer && payload?.type === 'text' && p.type === 'text' && p.right.editable === payload.right.editable) {
    const dirty = editTimer !== undefined || viewer.getModified() !== sent;
    if ((p.left.text ?? '') !== viewer.getOriginal()) viewer.setOriginal(p.left.text ?? '');
    if (!dirty && (p.right.text ?? '') !== viewer.getModified()) {
      sent = p.right.text ?? '';
      viewer.setModified(sent);
    }
    if (titleText(p.left) !== titleText(payload.left) || titleText(p.right) !== titleText(payload.right)) {
      viewer.setOptions({ originalTitle: titleText(p.left), modifiedTitle: titleText(p.right) });
    }
    payload = { ...p, right: { ...p.right, text: dirty ? payload.right.text : p.right.text } };
    // hunks describe the saved file: only paint them when the editor shows exactly that text
    if (!dirty) paintInclusion();
    updateToolbar();
  } else render(p);
});

window.addEventListener('blur', () => {
  sendEdit();
  saveSettings();
});
window.addEventListener('beforeunload', () => {
  sendEdit();
  saveSettings();
});
document.addEventListener('click', () => window.setTimeout(saveSettings, 0), true);

void load(index);
