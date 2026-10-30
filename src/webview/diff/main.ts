// Diff window webview (IntelliJ diff editor tab): ide-diff side-by-side/unified viewer plus Jump to Source,
// Compare Previous/Next File, the "2/5 files" chooser, editable working tree side and binary/image placeholders.
import { EditorView } from '@codemirror/view';
import { createDiffViewer, getIcon, injectStyles, type DiffViewerHost, type DiffViewerOptions, type IconName } from '@ide-diff/viewer';
import { languageFor } from '../shared/languages';
import { init, rpc } from '../shared/rpc';
import { formatSize } from '../../features/diff/content';
import { mapLine } from '../../features/diff/lineMap';
import type { DiffFileInfo, DiffInit, DiffPayload, DiffSide } from '../../features/diff/protocol';
import { BASE_CSS, injectCss, onThemeChange, theme } from './theme';

const IS_MAC = /Mac|iPhone|iPad/.test(navigator.platform);
const data = init<DiffInit>();
const files: DiffFileInfo[] = data.files ?? [];
let index = data.index ?? 0;
let payload: DiffPayload | undefined;
let viewer: DiffViewerHost | undefined;
/** right text as last loaded or sent to the host; differs from the editor while an edit isn't sent yet */
let sent = '';
let editTimer: number | undefined;
let loadSeq = 0;
let lastFocus: 'left' | 'right' = 'right';

type Impl = ReturnType<DiffViewerHost['getImplementation']>;
type Settings = ReturnType<Impl['exportOptions']>;
type Appearance = Pick<Settings, 'showWhitespaces' | 'showLineNumbers' | 'softWraps'>;
let settings = (data.settings?.viewer ?? {}) as Partial<DiffViewerOptions>;
let appearance = data.settings?.appearance as Appearance | undefined;
/** separates the revision label from the path in a title string (decorated into two spans) */
const TITLE_SEP = ' ';

// ide-diff's chrome CSS is needed before the first viewer exists (binary/image placeholders use its toolbar)
injectStyles();
injectCss(
  BASE_CSS +
    `
.k-A { color: var(--jb-added); } .k-M, .k-R, .k-C, .k-T { color: var(--jb-modified); } .k-D { color: var(--jb-deleted); }
.k-\\? { color: var(--jb-untracked); } .k-U { color: var(--jb-conflict); } .k-\\! { color: var(--vscode-disabledForeground); }
#stage { flex: 1; min-height: 0; display: flex; flex-direction: column; position: relative; }
#stage > .viewer { flex: 1; min-height: 0; }
.idd-title-text .rev { color: var(--idd-title-fg); margin-right: 8px; }
.idd-title-text .path { color: var(--idd-title-secondary-fg, var(--vscode-descriptionForeground)); }
.fb { flex: 1; min-height: 0; display: flex; flex-direction: column; }
.fb-titles { flex: none; display: grid; grid-template-columns: 1fr 1fr; border-bottom: 1px solid var(--jb-border); }
.fb-title { padding: 6px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.fb-title .rev { margin-right: 8px; }
.fb-title .path { color: var(--vscode-descriptionForeground); }
.fb-title + .fb-title { border-left: 1px solid var(--jb-border); }
.fb-notice { flex: none; padding: 8px 12px; border-bottom: 1px solid var(--jb-border); }
.fb-body { flex: 1; display: flex; align-items: center; justify-content: center; color: var(--vscode-descriptionForeground); padding: 16px; text-align: center; white-space: pre-wrap; }
.fb-images { flex: 1; min-height: 0; display: grid; grid-template-columns: 1fr 1fr; }
.fb-image { min-width: 0; min-height: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px; padding: 16px; overflow: auto; }
.fb-image + .fb-image { border-left: 1px solid var(--jb-border); }
.fb-image img { max-width: 100%; max-height: calc(100% - 28px); object-fit: contain; image-rendering: auto;
  background: repeating-conic-gradient(rgba(128,128,128,.25) 0% 25%, transparent 0% 50%) 50% / 16px 16px; }
.fb-image .info { font-size: 12px; color: var(--vscode-descriptionForeground); }
.files-btn { padding: 0 6px !important; }
.files-btn .label { white-space: nowrap; }
.jb-hint { position: absolute; top: 48px; left: 50%; transform: translateX(-50%); z-index: 500; padding: 6px 10px; border-radius: 6px;
  background: var(--vscode-editorHoverWidget-background, var(--vscode-editorWidget-background)); color: var(--vscode-editorHoverWidget-foreground, var(--vscode-foreground));
  border: 1px solid var(--vscode-editorHoverWidget-border, var(--jb-border)); box-shadow: 0 2px 8px var(--vscode-widget-shadow, rgba(0,0,0,.25));
  white-space: nowrap; pointer-events: none; }
.jb-popup { position: fixed; z-index: 100; min-width: 280px; max-width: min(640px, 90vw); max-height: 60vh; display: flex; flex-direction: column;
  background: var(--vscode-quickInput-background, var(--vscode-editorWidget-background)); color: var(--vscode-quickInput-foreground, var(--vscode-foreground));
  border: 1px solid var(--vscode-widget-border, var(--jb-border)); border-radius: 8px; box-shadow: 0 4px 16px var(--vscode-widget-shadow, rgba(0,0,0,.35)); overflow: hidden; }
.jb-popup .head { padding: 6px 10px 0; font-size: 12px; color: var(--vscode-descriptionForeground); }
.jb-popup input { margin: 6px; height: 26px; padding: 0 8px; border-radius: 4px; font: inherit; outline: none;
  color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, var(--jb-border)); }
.jb-popup input:focus { border-color: var(--vscode-focusBorder); }
.jb-popup .list { overflow-y: auto; padding: 0 4px 4px; }
.jb-popup .item { height: 24px; display: flex; align-items: center; gap: 6px; padding: 0 8px; border-radius: 4px; cursor: pointer; white-space: nowrap; }
.jb-popup .item .dir { color: var(--vscode-descriptionForeground); overflow: hidden; text-overflow: ellipsis; }
.jb-popup .item.current { font-weight: 600; }
.jb-popup .item.active { background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); }
.jb-popup .item.active .dir { color: inherit; opacity: .8; }
.jb-popup .empty { padding: 6px 10px; color: var(--vscode-descriptionForeground); }
`,
);

const app = document.getElementById('app')!;
app.className = `idd-theme-${theme()}`;
const stage = el('div');
stage.id = 'stage';
app.append(stage);

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

const splitPath = (p: string): [string, string] => {
  const i = p.lastIndexOf('/');
  return i < 0 ? ['', p] : [p.slice(0, i), p.slice(i + 1)];
};

// ------------------------------------------------------------------ titles

/** Title string handed to ide-diff: "<revision> <path>", split again by decorateTitles(). */
function titleText(side: DiffSide): string {
  return side.path ? `${side.title}${TITLE_SEP}${side.path}` : side.title;
}

/** Renders a title like IntelliJ's FilePathDiffTitleCustomizer: revision label, then the path in a secondary color. */
function fillTitle(target: HTMLElement, text: string): void {
  const i = text.indexOf(TITLE_SEP);
  target.replaceChildren();
  target.title = text.replace(TITLE_SEP, '  ');
  if (i < 0) {
    target.textContent = text;
    return;
  }
  const rev = text.slice(0, i);
  if (rev) target.append(el('span', 'rev', rev));
  target.append(el('span', 'path', text.slice(i + TITLE_SEP.length)));
}

function decorateTitles(): void {
  for (const t of stage.querySelectorAll<HTMLElement>('.idd-title-text')) {
    if (t.textContent?.includes(TITLE_SEP)) fillTitle(t, t.textContent);
  }
}
// ide-diff re-renders its titles on mode/lock changes
new MutationObserver(decorateTitles).observe(stage, { childList: true, subtree: true });

// ------------------------------------------------------------------ toolbar extras

function iconButton(icon: IconName, tooltip: string, onClick: () => void, id: string): HTMLButtonElement {
  const b = el('button', 'idd-btn');
  b.type = 'button';
  b.id = id;
  b.title = tooltip;
  b.setAttribute('aria-label', tooltip);
  const i = el('span', 'idd-icon jb-ic');
  i.dataset.icon = icon;
  i.innerHTML = getIcon(icon, theme());
  b.append(i);
  b.addEventListener('mousedown', (e) => e.preventDefault());
  b.addEventListener('click', () => !b.disabled && onClick());
  return b;
}

const sep = (): HTMLElement => el('span', 'idd-sep');
const key = (mac: string, other: string): string => (IS_MAC ? mac : other);

function filesLabel(): string {
  return `${index + 1}/${files.length} files`;
}

/** Jump to Source, Compare Previous/Next File and the file chooser, inserted after ide-diff's next difference button. */
function extraButtons(): HTMLElement[] {
  const out: HTMLElement[] = [sep(), iconButton('generalEdit', `Jump to Source (${key('F4 or ⌘↓', 'F4')})`, jump, 'jumpSource')];
  if (files.length > 1) {
    const chooser = el('button', 'idd-btn files-btn');
    chooser.type = 'button';
    chooser.id = 'filesBtn';
    chooser.title = 'Select File to Compare';
    const label = el('span', 'label', filesLabel());
    const chev = el('span', 'idd-icon idd-icon-14 jb-ic');
    chev.dataset.icon = 'generalChevronDown';
    chev.innerHTML = getIcon('generalChevronDown', theme());
    chooser.append(label, chev);
    chooser.addEventListener('mousedown', (e) => e.preventDefault());
    chooser.addEventListener('click', () => (popup ? closePopup() : openPopup(chooser)));
    out.push(
      sep(),
      iconButton('generalLeft', `Compare Previous File (${key('⌃⇧←', 'Alt+Shift+Left')})`, () => moveFile(-1), 'prevFile'),
      iconButton('generalRight', `Compare Next File (${key('⌃⇧→', 'Alt+Shift+Right')})`, () => moveFile(1), 'nextFile'),
      chooser,
    );
  }
  return out;
}

function updateNav(): void {
  const prev = document.getElementById('prevFile') as HTMLButtonElement | null;
  const next = document.getElementById('nextFile') as HTMLButtonElement | null;
  const jumpBtn = document.getElementById('jumpSource') as HTMLButtonElement | null;
  if (prev) prev.disabled = index <= 0;
  if (next) next.disabled = index >= files.length - 1;
  if (jumpBtn) jumpBtn.disabled = !payload?.canJump;
  const label = document.querySelector('#filesBtn .label');
  if (label) label.textContent = filesLabel();
}

function addToolbarButtons(): void {
  const left = stage.querySelector('.idd-toolbar-left');
  if (!left || left.querySelector('#jumpSource')) return;
  const anchor = left.children[1] ?? left.lastElementChild;
  if (anchor) anchor.after(...extraButtons());
  else left.append(...extraButtons());
  updateNav();
}

function retheme(): void {
  const t = theme();
  app.className = `idd-theme-${t}`;
  for (const i of document.querySelectorAll<HTMLElement>('.jb-ic')) i.innerHTML = getIcon(i.dataset.icon as IconName, t);
  viewer?.setOptions({ theme: t });
}
onThemeChange(retheme);

// ------------------------------------------------------------------ "Press again to go to the next file" hint

let hint: { el: HTMLElement; dir: 1 | -1; timer: number } | undefined;

function hideHint(): void {
  if (!hint) return;
  window.clearTimeout(hint.timer);
  hint.el.remove();
  hint = undefined;
}

function showHint(dir: 1 | -1): void {
  hideHint();
  const e = el('div', 'jb-hint', dir > 0 ? 'Press again to go to the next file' : 'Press again to go to the previous file');
  stage.append(e);
  hint = { el: e, dir, timer: window.setTimeout(hideHint, 3000) };
}

/** Whether ide-diff has a difference after/before the caret (its findChange; absent → assume yes). */
function hasChange(dir: 1 | -1): boolean {
  const impl = viewer?.getImplementation() as unknown as { findChange?: (d: number) => number } | undefined;
  if (!impl) return false;
  return typeof impl.findChange === 'function' ? impl.findChange(dir) >= 0 : true;
}

/** F7 / Shift+F7: next/previous difference, then (after "Press again…") the first/last difference of the next/previous file. */
function navigateDifference(dir: 1 | -1): void {
  if (hasChange(dir)) {
    hideHint();
    if (dir > 0) viewer!.goToNextChange();
    else viewer!.goToPreviousChange();
    return;
  }
  const target = index + dir;
  if (target < 0 || target >= files.length) return;
  if (hint?.dir === dir) {
    hideHint();
    switchTo(target, dir > 0 ? 'first' : 'last');
  } else showHint(dir);
}

// ------------------------------------------------------------------ file chooser popup

let popup: HTMLElement | undefined;

function closePopup(): void {
  popup?.remove();
  popup = undefined;
}

function openPopup(anchor: HTMLElement): void {
  closePopup();
  const box = el('div', 'jb-popup');
  const input = el('input');
  input.placeholder = 'Search';
  input.setAttribute('aria-label', 'Search files');
  const list = el('div', 'list');
  list.setAttribute('role', 'listbox');
  box.append(el('div', 'head', 'Select File to Compare'), input, list);
  let shown: number[] = [];
  let active = 0;
  const render = (): void => {
    const q = input.value.trim().toLowerCase();
    shown = files.map((_, i) => i).filter((i) => !q || files[i].path.toLowerCase().includes(q));
    active = Math.max(0, Math.min(active, shown.length - 1));
    list.replaceChildren();
    if (!shown.length) list.append(el('div', 'empty', 'Nothing found'));
    shown.forEach((fi, n) => {
      const f = files[fi];
      const [dir, name] = splitPath(f.path);
      const item = el('div', `item${fi === index ? ' current' : ''}${n === active ? ' active' : ''}`);
      item.setAttribute('role', 'option');
      item.setAttribute('aria-selected', String(n === active));
      item.append(el('i', 'codicon codicon-file'), el('span', `k-${f.kind ?? 'M'}`, name));
      if (dir) item.append(el('span', 'dir', dir));
      item.title = f.oldPath && f.oldPath !== f.path ? `${f.oldPath} → ${f.path}` : f.path;
      item.addEventListener('mousedown', (e) => e.preventDefault());
      item.addEventListener('click', () => {
        closePopup();
        switchTo(fi);
      });
      item.addEventListener('mousemove', () => {
        if (active === n) return;
        active = n;
        render();
      });
      list.append(item);
    });
    list.querySelector('.item.active')?.scrollIntoView({ block: 'nearest' });
  };
  active = Math.max(0, index);
  input.addEventListener('input', () => {
    active = 0;
    render();
  });
  input.addEventListener('keydown', (e) => {
    const page = 10;
    if (e.key === 'ArrowDown') active = Math.min(shown.length - 1, active + 1);
    else if (e.key === 'ArrowUp') active = Math.max(0, active - 1);
    else if (e.key === 'PageDown') active = Math.min(shown.length - 1, active + page);
    else if (e.key === 'PageUp') active = Math.max(0, active - page);
    else if (e.key === 'Home' && !input.value) active = 0;
    else if (e.key === 'End' && !input.value) active = shown.length - 1;
    else if (e.key === 'Enter') {
      const fi = shown[active];
      closePopup();
      if (fi !== undefined) switchTo(fi);
      e.preventDefault();
      return;
    } else if (e.key === 'Escape') {
      closePopup();
      e.preventDefault();
      e.stopPropagation();
      return;
    } else return;
    e.preventDefault();
    render();
  });
  document.body.append(box);
  popup = box;
  const r = anchor.getBoundingClientRect();
  box.style.top = `${r.bottom + 4}px`;
  box.style.left = `${Math.max(4, Math.min(r.left, window.innerWidth - box.offsetWidth - 4))}px`;
  render();
  input.focus();
}

document.addEventListener('mousedown', (e) => {
  if (popup && !popup.contains(e.target as Node)) closePopup();
});

// ------------------------------------------------------------------ viewer

/** Remembers the viewer settings for every diff window (host globalState). */
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

function disposeViewer(): void {
  if (!viewer) return;
  sendEdit();
  saveSettings();
  viewer.dispose();
  viewer = undefined;
}

/** Sends the editable right side to the host if it changed; the host writes it to disk (debounced). */
function sendEdit(): void {
  window.clearTimeout(editTimer);
  editTimer = undefined;
  if (!viewer || !payload?.right.editable) return;
  const text = viewer.getModified();
  if (text === sent) return;
  sent = text;
  rpc.call('edit', { index: payload.index, text }).catch(() => undefined);
}

function scheduleEdit(): void {
  if (editTimer === undefined) editTimer = window.setTimeout(sendEdit, 150);
}

/** Cmd/Ctrl+S, switching files, closing: everything typed so far goes to disk now. */
function flush(): void {
  sendEdit();
  rpc.call('flush').catch(() => undefined);
}

function editors(): [EditorView, EditorView] | undefined {
  const impl = viewer?.getImplementation();
  return impl && 'getEditors' in impl ? impl.getEditors() : undefined;
}

/** Which change to put the caret on after loading: the first, the last, or the one at/after a right-side line (0-based). */
type Reveal = 'first' | 'last' | number;

function revealChange(which: Reveal): void {
  const changes = viewer?.getChanges() ?? [];
  const eds = editors();
  if (typeof which === 'number') {
    if (!eds) {
      // unified viewer: navigate from the top to the change at/after the line
      const target = changes.findIndex((c) => c.endLine2 > which || (c.startLine2 === c.endLine2 && c.startLine2 >= which));
      for (let n = 0; n <= Math.max(0, target); n++) viewer?.goToNextChange();
      return;
    }
    const ed = eds[1];
    const pos = ed.state.doc.line(Math.max(1, Math.min(which + 1, ed.state.doc.lines))).from;
    ed.dispatch({ selection: { anchor: pos }, effects: EditorView.scrollIntoView(pos, { y: 'center' }) });
    return;
  }
  const c = which === 'first' ? changes[0] : changes[changes.length - 1];
  if (!c) return;
  if (!eds) {
    // unified viewer: let it navigate from the top/bottom
    if (which === 'first') viewer?.goToNextChange();
    else viewer?.goToPreviousChange();
    return;
  }
  const ed = eds[1];
  const pos = ed.state.doc.line(Math.min(c.startLine2 + 1, ed.state.doc.lines)).from;
  ed.dispatch({ selection: { anchor: pos }, effects: EditorView.scrollIntoView(pos, { y: 'center' }) });
}

function applyNotice(): void {
  const notice = payload?.notice;
  if (!notice) return;
  requestAnimationFrame(() => {
    const n = stage.querySelector('.idd-notice.idd-visible');
    if (n && n.textContent !== notice) n.textContent = notice;
  });
}

function renderText(p: DiffPayload, reveal: Reveal): void {
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
  });
  if (appearance) (viewer.getImplementation() as unknown as { setAppearance(a: Appearance): void }).setAppearance(appearance);
  viewer.onDidChange(() => {
    if (payload?.right.editable) scheduleEdit();
  });
  viewer.onDidUpdateDiff(applyNotice);
  viewer.onDidChangeMode(() => {
    addToolbarButtons();
    applyNotice();
    saveSettings();
  });
  addToolbarButtons();
  decorateTitles();
  applyNotice();
  revealChange(reveal);
}

/** Placeholder pane (binary, too large, error, images) with the same extra toolbar actions. */
function renderFallback(p: DiffPayload): void {
  const root = el('div', 'fb idd-root');
  const toolbar = el('div', 'idd-toolbar');
  const left = el('div', 'idd-toolbar-left');
  left.append(...extraButtons().slice(1));
  toolbar.append(left, el('div', 'idd-toolbar-spacer'));
  const titles = el('div', 'fb-titles');
  for (const side of [p.left, p.right]) {
    const t = el('div', 'fb-title');
    fillTitle(t, titleText(side));
    titles.append(t);
  }
  root.append(toolbar, titles);
  if (p.type === 'image') {
    if (p.identical) root.append(el('div', 'fb-notice', 'Files contents are identical'));
    const grid = el('div', 'fb-images');
    grid.append(imagePane(p.left), imagePane(p.right));
    root.append(grid);
  } else {
    root.append(el('div', 'fb-body', p.message ?? ''));
  }
  stage.replaceChildren(root);
  updateNav();
}

function imagePane(side: DiffSide): HTMLElement {
  const pane = el('div', 'fb-image');
  if (!side.image) return pane;
  const img = el('img');
  img.alt = side.title;
  const info = el('div', 'info');
  img.addEventListener('load', () => {
    const fmt = /^data:image\/([\w.+-]+)/.exec(side.image!)?.[1]?.replace('x-icon', 'ico').toUpperCase() ?? '';
    info.textContent = `${img.naturalWidth}×${img.naturalHeight} ${fmt}${side.size !== undefined ? `, ${formatSize(side.size)}` : ''}`;
  });
  img.addEventListener('error', () => {
    info.textContent = side.size !== undefined ? formatSize(side.size) : '';
  });
  img.src = side.image;
  pane.append(img, info);
  return pane;
}

function render(p: DiffPayload, reveal: Reveal = 'first'): void {
  disposeViewer();
  hideHint();
  payload = p;
  if (p.type === 'text') renderText(p, reveal);
  else renderFallback(p);
  updateNav();
}

async function load(i: number, reveal: Reveal = 'first'): Promise<void> {
  const seq = ++loadSeq;
  index = i;
  updateNav();
  try {
    const p = await rpc.call<DiffPayload>('load', i);
    if (seq === loadSeq) render(p, reveal);
  } catch (e) {
    if (seq !== loadSeq) return;
    const f = files[i];
    const message = e instanceof Error ? e.message : String(e);
    render({ index: i, path: f?.path ?? '', language: 'plaintext', type: 'error', message, left: { exists: false, title: '' }, right: { exists: false, title: '' }, canJump: false });
  }
}

function switchTo(i: number, reveal: Reveal = 'first'): void {
  if (i < 0 || i >= files.length) return;
  flush();
  closePopup();
  void load(i, reveal);
}

function moveFile(delta: number): void {
  switchTo(index + delta);
}

function jump(): void {
  if (!payload?.canJump) return;
  let line = 0;
  const eds = editors();
  const changes = viewer?.getChanges() ?? [];
  if (eds) {
    const side = lastFocus === 'left' ? 0 : 1;
    const st = eds[side].state;
    const ln = st.doc.lineAt(st.selection.main.head).number - 1;
    line = side === 0 ? mapLine(changes, ln, 1) : ln;
  } else if (changes.length) line = changes[0].startLine2;
  sendEdit();
  rpc.call('jump', { index: payload.index, line }).catch(() => undefined);
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
    const mod = IS_MAC ? e.metaKey : e.ctrlKey;
    const arrow = e.key === 'ArrowLeft' ? -1 : e.key === 'ArrowRight' ? 1 : 0;
    // Diff.PrevChange / Diff.NextChange: Alt+Shift+Left/Right, macOS Ctrl+Shift+Left/Right
    const fileNav = arrow && e.shiftKey && !e.metaKey && (IS_MAC ? e.ctrlKey && !e.altKey : e.altKey && !e.ctrlKey);
    if (e.key !== 'F7' && e.key !== 'Shift') hideHint();
    if (fileNav && files.length > 1 && !popup) {
      moveFile(arrow);
    } else if ((e.key === 'F4' && !e.altKey && !mod && !e.shiftKey) || (IS_MAC && e.metaKey && !e.altKey && !e.ctrlKey && !e.shiftKey && e.key === 'ArrowDown')) {
      jump();
    } else if (mod && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 's') {
      flush();
    } else if (e.key === 'F7' && !mod && !e.altKey && !popup) {
      navigateDifference(e.shiftKey ? -1 : 1);
    } else return;
    e.preventDefault();
    e.stopPropagation();
  },
  true,
);

// Esc closes the diff window like IntelliJ, unless something inside (search panel, popup) consumed it.
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || e.defaultPrevented || popup || document.querySelector('.idd-popup')) return;
  if (hint) {
    hideHint();
    return;
  }
  sendEdit();
  rpc.call('close').catch(() => undefined);
});

rpc.on<DiffPayload>('reload', (p) => {
  if (p.index !== index) return;
  if (viewer && payload?.type === 'text' && p.type === 'text' && p.right.editable === payload.right.editable) {
    const dirty = viewer.getModified() !== sent;
    if ((p.left.text ?? '') !== viewer.getOriginal()) viewer.setOriginal(p.left.text ?? '');
    if (!dirty && (p.right.text ?? '') !== viewer.getModified()) {
      sent = p.right.text ?? '';
      viewer.setModified(sent);
    }
    if (titleText(p.left) !== titleText(payload.left) || titleText(p.right) !== titleText(payload.right)) {
      viewer.setOptions({ originalTitle: titleText(p.left), modifiedTitle: titleText(p.right) });
    }
    payload = { ...p, right: { ...p.right, text: dirty ? payload.right.text : p.right.text } };
    applyNotice();
    updateNav();
  } else render(p);
});
rpc.on<number>('select', (i) => {
  if (i !== index) switchTo(i);
});
rpc.on<{ index: number; line: number }>('reveal', (r) => {
  if (r.index !== index) switchTo(r.index, r.line);
  else if (payload?.type === 'text') revealChange(r.line);
});
window.addEventListener('blur', () => {
  sendEdit();
  saveSettings();
});
window.addEventListener('beforeunload', () => {
  sendEdit();
  saveSettings();
});
// settings changed through the toolbar's gear/ignore/highlight popups
document.addEventListener('click', () => window.setTimeout(saveSettings, 0), true);

void load(index, data.line ?? 'first');
