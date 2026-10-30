// "Rebasing Commits" dialog (IntelliJ interactive rebase): commits in todo order (oldest at the top) with an Action
// column, toolbar Move Up / Move Down, Pick, Stop to Edit | Reword, Squash, Fixup, Drop and the Reset link, inline
// reword editor, drag & drop, "View Git Commands" in the context menu; the selected commit's changes and details on the right.
import { init, rpc, viewState } from '../shared/rpc';
import {
  buildPathTree,
  confirmDialog,
  dialogLayout,
  ensureStyles,
  formatDateTime,
  formatPrettyDateTime,
  formatShortcut,
  gitStatusClass,
  h,
  icon,
  isCtrlCmd,
  isMac,
  link,
  Table,
  openModal,
  pathTreeToNodes,
  setFormatLocale,
  showContextMenu,
  Splitter,
  Toolbar,
  Tree,
  type MenuItem,
} from '../shared/ui';
import type { FileChange } from '../../core/types';
import type { RebaseDetails, RebaseInit, RebaseRow, RebaseStartEntry } from '../../features/commitOps/protocol';
import {
  cleanMessage,
  describeTodo,
  groupMessage,
  groups,
  moveRows,
  moveRowsTo,
  prettySquash,
  subjectOf,
  uniteRows,
  validatePlan,
  type RebaseAction,
  type RebaseEntry,
} from '../../features/commitOps/todo';

const data = init<RebaseInit>();
setFormatLocale(data.locale);
ensureStyles();

interface Item extends RebaseEntry {
  row: RebaseRow;
}

const original: Item[] = data.rows.map((row) => ({ hash: row.hash, action: 'pick', message: row.message, row }));
const byHash = new Map(original.map((i) => [i.hash, i]));
/** plan, oldest first = display order (like git's todo and IntelliJ's table) */
let plan: Item[] = restorePlan() ?? original.map((i) => ({ ...i }));
const display = () => plan;
let selected = new Set<string>(plan.length ? [plan[0].hash] : []);
let lead: string | undefined = plan[0]?.hash;
let anchor = lead;

/** the edited plan survives a webview reload */
function restorePlan(): Item[] | undefined {
  const saved = viewState.get<{ hash: string; action: RebaseAction; newMessage?: string }[] | undefined>('plan', undefined);
  if (!saved || saved.length !== original.length || !saved.every((e) => byHash.has(e.hash))) return undefined;
  return saved.map((e) => ({ ...byHash.get(e.hash)!, action: e.action, newMessage: e.newMessage }));
}
const savePlan = () => viewState.set('plan', plan.map((e) => ({ hash: e.hash, action: e.action, newMessage: e.newMessage })));
let editing: string | undefined;
let headChanged = false;

const LABEL: Record<RebaseAction, string> = { pick: 'Pick', edit: 'Edit', reword: 'Reword', squash: 'Squash', fixup: 'Fixup', drop: 'Drop' };
const ICON: Record<RebaseAction, string> = { pick: 'discard', edit: 'debug-pause', reword: 'edit', squash: 'fold-up', fixup: 'fold-up', drop: 'close' };
/** IntelliJ: Alt+<mnemonic> (plain letters work too, like git's todo verbs) */
const KEY: Record<string, RebaseAction> = { KeyP: 'pick', KeyE: 'edit', KeyR: 'reword', KeyS: 'squash', KeyF: 'fixup', KeyD: 'drop' };

const css = document.createElement('style');
css.textContent = `
html, body, #app { height: 100%; margin: 0; }
.rb-body { display: flex; flex-direction: column; gap: 6px; height: 100%; min-height: 0; box-sizing: border-box; }
.rb-notice { display: flex; gap: 6px; align-items: center; padding: 4px 10px; border-radius: var(--jb-radius-sm); color: var(--jb-fg);
  background: var(--vscode-inputValidation-warningBackground, transparent); border: 1px solid var(--vscode-inputValidation-warningBorder, var(--jb-warning)); }
.rb-notice .codicon { color: var(--jb-warning); }
.rb-split { flex: 1 1 auto; min-height: 0; }
.rb-pane { display: flex; flex-direction: column; min-height: 0; height: 100%; background: var(--jb-island-bg); border-radius: var(--jb-radius); overflow: hidden; }
.rb-list { flex: 1 1 auto; overflow: auto; outline: none; position: relative; }
.rb-row { display: flex; align-items: center; height: var(--jb-row); padding: 0 8px; gap: 8px; cursor: default; white-space: nowrap; user-select: none; border-top: 2px solid transparent; border-bottom: 2px solid transparent; box-sizing: border-box; }
.rb-row:hover { background: var(--jb-hover); }
.rb-row.sel { background: var(--jb-sel-inactive-bg); color: var(--jb-sel-inactive-fg); }
.rb-list:focus-within .rb-row.sel { background: var(--jb-sel-bg); color: var(--jb-sel-fg); }
.rb-row.drop-before { border-top-color: var(--jb-focus); }
.rb-row.drop-after { border-bottom-color: var(--jb-focus); }
.rb-row.dragging { opacity: .5; }
.rb-action { flex: none; width: 74px; display: flex; align-items: center; gap: 4px; }
.rb-action .codicon { font-size: 14px; }
.rb-a-edit .rb-action { color: var(--jb-link); }
.rb-a-reword .rb-action { color: var(--jb-git-modified); }
.rb-a-squash .rb-action, .rb-a-fixup .rb-action { color: var(--jb-git-renamed, var(--jb-link)); }
.rb-a-drop .rb-action, .rb-a-drop .rb-subject { color: var(--jb-fg-disabled); }
.rb-a-drop .rb-subject { text-decoration: line-through; }
.rb-a-pick .rb-action { color: var(--jb-fg-muted); }
.rb-row.sel .rb-action { color: inherit; }
.rb-subject { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; display: flex; align-items: center; gap: 4px; }
.rb-subject .rb-into { color: var(--jb-fg-muted); font-size: 12px; }
.rb-subject .rb-text { overflow: hidden; text-overflow: ellipsis; }
.rb-changed .rb-text { font-style: italic; }
.rb-author { flex: none; width: 120px; overflow: hidden; text-overflow: ellipsis; color: var(--jb-fg-muted); }
.rb-date { flex: none; width: 120px; overflow: hidden; text-overflow: ellipsis; color: var(--jb-fg-muted); text-align: right; }
.rb-row.sel .rb-author, .rb-row.sel .rb-date { color: inherit; opacity: .8; }
.rb-editor { padding: 4px 8px 8px 90px; background: var(--jb-sel-inactive-bg); }
.rb-editor textarea { width: 100%; box-sizing: border-box; resize: vertical; min-height: 96px; font-family: var(--jb-mono); font-size: var(--jb-mono-size); line-height: 1.45; }
.rb-editor .rb-hint { color: var(--jb-fg-muted); font-size: 12px; margin-top: 2px; }
.rb-details { display: flex; flex-direction: column; min-height: 0; height: 100%; }
.rb-files { flex: 1 1 50%; min-height: 60px; display: flex; }
.rb-files > * { flex: 1; }
.rb-meta { flex: 1 1 50%; min-height: 60px; overflow: auto; padding: 8px 10px; border-top: 1px solid var(--jb-border); user-select: text; -webkit-user-select: text; }
.rb-meta pre { margin: 0 0 10px; white-space: pre-wrap; word-break: break-word; font-family: var(--jb-mono); font-size: var(--jb-mono-size); }
.rb-meta .rb-kv { color: var(--jb-fg-muted); line-height: 1.6; }
.rb-meta .rb-kv b { color: var(--jb-fg); font-weight: normal; }
.rb-empty { color: var(--jb-fg-muted); padding: 10px; }
.rb-reset { margin: 0 8px; }
.rb-reset[hidden] { display: none; }
.rb-cmds { height: 50vh; min-height: 160px; display: flex; }
.rb-cmds > * { flex: 1; }
`;
document.head.appendChild(css);

// ---------- layout ----------

const list = h('div.rb-list', { tabIndex: 0, attrs: { role: 'listbox', 'aria-multiselectable': 'true', 'aria-label': 'Commits' } });
const toolbarHost = h('div');
const left = h('div.rb-pane', null, toolbarHost, list);
const filesHost = h('div.rb-files');
const meta = h('div.rb-meta');
const right = h('div.rb-pane', null, h('div.rb-details', null, filesHost, meta));
const splitHost = h('div.rb-split');
const body = h('div.rb-body', null, data.notice ? h('div.rb-notice', null, icon('warning'), h('span', null, data.notice)) : null, splitHost);

const dlg = dialogLayout(document.getElementById('app')!, {
  title: `Rebasing Commits${data.branch ? ` (${data.branch})` : ''}`,
  body,
  buttons: [
    { id: 'start', label: 'Start Rebasing', primary: true, run: () => start() },
    { id: 'cancel', label: 'Cancel', cancel: true, run: () => cancel() },
  ],
});
dlg.body.style.display = 'flex';
dlg.body.style.flexDirection = 'column';
const resetLink = link('Reset', () => reset());
resetLink.classList.add('rb-reset');
resetLink.hidden = true;

const split = new Splitter(splitHost, { orientation: 'horizontal', first: left, second: right, size: 0.62, proportional: true, min: 300, minOther: 220, stateKey: 'rebase.split' });
split.element.classList.add('jb-islands');

// IntelliJ's ToolbarDecorator: Move Up / Move Down, Pick, Stop to Edit | Reword, Squash (+ Fixup), Drop … Reset
const toolbar = new Toolbar(toolbarHost, {
  items: [
    { id: 'up', icon: 'arrow-up', tooltip: 'Move Up', shortcut: 'Alt+Up', run: () => move(-1) },
    { id: 'down', icon: 'arrow-down', tooltip: 'Move Down', shortcut: 'Alt+Down', run: () => move(1) },
    { id: 'pick', icon: ICON.pick, tooltip: 'Pick', shortcut: 'Alt+P', run: () => setAction('pick') },
    { id: 'edit', icon: ICON.edit, tooltip: 'Stop to Edit', shortcut: 'Alt+E', run: () => setAction('edit') },
    '-',
    { id: 'reword', label: 'Reword', tooltip: 'Reword', shortcut: 'Alt+R', run: () => startReword() },
    { id: 'squash', label: 'Squash', tooltip: 'Squash', shortcut: 'Alt+S', run: () => setAction('squash') },
    { id: 'fixup', label: 'Fixup', tooltip: 'Fixup', shortcut: 'Alt+F', run: () => setAction('fixup') },
    { id: 'drop', label: 'Drop', tooltip: 'Drop', shortcut: 'Alt+D', run: () => setAction('drop') },
    { type: 'spacer' },
    { type: 'custom', id: 'reset', element: resetLink },
  ],
  ariaLabel: 'Rebase actions',
});

const files = new Tree<FileChange>(filesHost, { multiSelect: true, defaultExpandDepth: Infinity, emptyText: ['No changes'], stateKey: 'rebase.files' });
let detailsHash: string | undefined;
let detailsFiles: FileChange[] = [];
const cache = new Map<string, Promise<RebaseDetails>>();
files.onDidActivate(({ node }) => {
  if (!node.data || !detailsHash) return;
  void rpc.call('showDiff', { hash: detailsHash, path: node.data.path, paths: detailsFiles });
});

// ---------- rendering ----------

/** The commit a squash/fixup row is squashed into (nearest older non-dropped pick/edit/reword). */
function headOfGroup(i: number): number {
  if (plan[i].action !== 'squash' && plan[i].action !== 'fixup') return i;
  for (let k = i - 1; k >= 0; k--) {
    const a = plan[k].action;
    if (a !== 'squash' && a !== 'fixup' && a !== 'drop') return k;
  }
  return i;
}

function rowSubject(item: Item): { text: string; changed: boolean } {
  const i = plan.indexOf(item);
  const g = groups(plan).find((x) => x.head === i);
  if (g) {
    const m = groupMessage(plan, g);
    if (m !== undefined) return { text: subjectOf(m), changed: cleanMessage(m) !== cleanMessage(item.message) };
  }
  return { text: item.row.subject, changed: false };
}

/** Selection-only change: toggles row classes instead of rebuilding the list. */
function renderSelection(): void {
  for (const el of list.querySelectorAll<HTMLElement>('.rb-row')) {
    const sel = selected.has(el.dataset.hash!);
    el.classList.toggle('sel', sel);
    el.setAttribute('aria-selected', String(sel));
  }
  updateState();
}

function render(): void {
  savePlan();
  const rows = display();
  const scroll = list.scrollTop;
  list.replaceChildren();
  for (const item of rows) {
    const sel = selected.has(item.hash);
    const { text, changed } = rowSubject(item);
    const into = item.action === 'squash' || item.action === 'fixup';
    const el = h('div.rb-row', {
      class: [`rb-a-${item.action}`, { sel, 'rb-changed': changed }],
      draggable: editing === undefined,
      dataset: { hash: item.hash },
      attrs: { role: 'option', 'aria-selected': String(sel) },
      title: `${item.row.hash.slice(0, 8)} ${item.row.subject}`,
    },
      h('span.rb-action', null, icon(ICON[item.action]), LABEL[item.action]),
      h('span.rb-subject', null, into ? h('span.rb-into', null, icon('arrow-small-up')) : null, h('span.rb-text', null, text)),
      h('span.rb-author', null, item.row.author),
      h('span.rb-date', { title: formatDateTime(item.row.authorDate) }, formatPrettyDateTime(item.row.authorDate)),
    );
    list.appendChild(el);
    if (editing === item.hash) list.appendChild(editorFor(item));
  }
  list.scrollTop = scroll;
  updateState();
}

function updateState(): void {
  const idx = selectedPlanIndices();
  const none = !idx.length || editing !== undefined;
  const multi = idx.length > 1;
  const canUnite = !none && uniteIndices(idx) !== undefined;
  toolbar.update('pick', { disabled: none });
  toolbar.update('edit', { disabled: none });
  toolbar.update('reword', { disabled: none || multi || plan[idx[0]]?.action === 'drop' });
  toolbar.update('squash', { disabled: !canUnite });
  toolbar.update('fixup', { disabled: !canUnite });
  toolbar.update('drop', { disabled: none });
  const disp = display();
  const dIdx = [...selected].map((h) => disp.findIndex((e) => e.hash === h)).filter((i) => i >= 0);
  toolbar.update('up', { disabled: none || !dIdx.length || Math.min(...dIdx) === 0 });
  toolbar.update('down', { disabled: none || !dIdx.length || Math.max(...dIdx) === disp.length - 1 });
  resetLink.hidden = !isModified();
  const err = headChanged ? 'Repository state was changed. Close the dialog and start the rebase again.' : validatePlan(plan);
  dlg.setError(err && err !== 'Nothing to rebase' ? err : undefined);
  dlg.setEnabled('start', !err && editing === undefined);
}

function isModified(): boolean {
  return plan.length !== original.length || plan.some((e, i) => e.hash !== original[i].hash || e.action !== 'pick' || e.newMessage !== undefined);
}

function selectedPlanIndices(): number[] {
  return plan.map((e, i) => (selected.has(e.hash) ? i : -1)).filter((i) => i >= 0);
}

// ---------- details ----------

async function showDetails(hash: string | undefined): Promise<void> {
  if (!hash) {
    detailsHash = undefined;
    files.setRoots([]);
    meta.replaceChildren(h('div.rb-empty', null, 'No commit selected'));
    return;
  }
  if (detailsHash === hash) return;
  detailsHash = hash;
  let p = cache.get(hash);
  if (!p) cache.set(hash, (p = rpc.call<RebaseDetails>('details', hash)));
  try {
    const d = await p;
    if (detailsHash !== hash) return;
    detailsFiles = d.files;
    files.setRoots(
      pathTreeToNodes(buildPathTree(d.files, { path: (f) => f.path, groupByDirectory: true, compact: true, idPrefix: `${hash}:` }), {
        file: (n) => ({ className: gitStatusClass(n.item.kind), data: n.item, tooltip: n.item.oldPath ? `${n.item.oldPath} → ${n.item.path}` : n.item.path }),
      }),
    );
    const author = `${d.author} <${d.authorEmail}>`;
    const committer = `${d.committer} <${d.committerEmail}>`;
    const kv: Node[] = [h('pre', null, d.message), h('div.rb-kv', null, h('b', null, d.hash.slice(0, 8)), ` ${author} on ${formatDateTime(d.authorDate)}`)];
    if (committer !== author || d.commitDate !== d.authorDate) kv.push(h('div.rb-kv', null, `committed by ${committer} on ${formatDateTime(d.commitDate)}`));
    if (!d.parents.length) kv.push(h('div.rb-kv', null, 'Initial commit'));
    meta.replaceChildren(...kv);
  } catch (e) {
    meta.replaceChildren(h('div.rb-empty', null, `Could not load changes of commit: ${(e as Error).message}`));
  }
}

// ---------- selection ----------

function selectOnly(hash: string, extend = false, toggle = false): void {
  const disp = display();
  if (extend && anchor) {
    const a = disp.findIndex((e) => e.hash === anchor);
    const b = disp.findIndex((e) => e.hash === hash);
    selected = new Set(disp.slice(Math.min(a, b), Math.max(a, b) + 1).map((e) => e.hash));
  } else if (toggle) {
    if (selected.has(hash) && selected.size > 1) selected.delete(hash);
    else selected.add(hash);
    anchor = hash;
  } else {
    selected = new Set([hash]);
    anchor = hash;
  }
  lead = hash;
  renderSelection();
  reveal(hash);
  void showDetails(lead);
}

function reveal(hash: string): void {
  const el = list.querySelector<HTMLElement>(`.rb-row[data-hash="${CSS.escape(hash)}"]`);
  el?.scrollIntoView({ block: 'nearest' });
}

list.addEventListener('mousedown', (e) => {
  const row = (e.target as HTMLElement).closest<HTMLElement>('.rb-row');
  if (!row || e.button !== 0) return;
  const hash = row.dataset.hash!;
  if (editing && editing !== hash) {
    if (!commitEditorIfUnchanged()) return;
  }
  if (selected.has(hash) && !e.shiftKey && !isCtrlCmd(e) && selected.size > 1) {
    // keep a multi-selection for dragging; collapse on mouseup without drag
    pendingCollapse = hash;
    return;
  }
  selectOnly(hash, e.shiftKey, isCtrlCmd(e));
});
let pendingCollapse: string | undefined;
list.addEventListener('mouseup', () => {
  if (pendingCollapse) selectOnly(pendingCollapse);
  pendingCollapse = undefined;
});
list.addEventListener('dblclick', (e) => {
  const row = (e.target as HTMLElement).closest<HTMLElement>('.rb-row');
  if (row) startReword(row.dataset.hash);
});
list.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  const row = (e.target as HTMLElement).closest<HTMLElement>('.rb-row');
  if (row && !selected.has(row.dataset.hash!)) selectOnly(row.dataset.hash!);
  showMenu(e.clientX, e.clientY);
});

function showMenu(x: number, y: number): void {
  if (!selected.size || editing) return;
  const idx = selectedPlanIndices();
  const multi = idx.length > 1;
  const canUnite = uniteIndices(idx) !== undefined;
  // IntelliJ's popup: Pick, Stop to Edit, Reword, Squash, Fixup, Drop | View Git Commands
  const items: MenuItem[] = [
    { label: 'Pick', icon: ICON.pick, shortcut: 'Alt+P', run: () => setAction('pick') },
    { label: 'Stop to Edit', icon: ICON.edit, shortcut: 'Alt+E', run: () => setAction('edit') },
    { label: 'Reword', shortcut: 'Alt+R', disabled: multi || plan[idx[0]]?.action === 'drop', run: () => startReword() },
    { label: 'Squash', shortcut: 'Alt+S', disabled: !canUnite, run: () => setAction('squash') },
    { label: 'Fixup', shortcut: 'Alt+F', disabled: !canUnite, run: () => setAction('fixup') },
    { label: 'Drop', shortcut: 'Alt+D', run: () => setAction('drop') },
    '-',
    { label: 'View Git Commands', run: () => void viewCommands() },
  ];
  showContextMenu(items, x, y);
}

list.addEventListener('keydown', (e) => {
  if (editing || (e.target as HTMLElement).tagName === 'TEXTAREA') return;
  const disp = display();
  const cur = disp.findIndex((x) => x.hash === lead);
  const go = (i: number) => {
    const t = disp[Math.max(0, Math.min(disp.length - 1, i))];
    if (t) selectOnly(t.hash, e.shiftKey);
  };
  const page = Math.max(1, Math.floor(list.clientHeight / 24) - 1);
  const k = e.key;
  let handled = true;
  if (e.altKey && (k === 'ArrowUp' || k === 'ArrowDown')) move(k === 'ArrowUp' ? -1 : 1);
  else if (k === 'ArrowUp') go(cur - 1);
  else if (k === 'ArrowDown') go(cur + 1);
  else if (k === 'Home') go(0);
  else if (k === 'End') go(disp.length - 1);
  else if (k === 'PageUp') go(cur - page);
  else if (k === 'PageDown') go(cur + page);
  else if (isCtrlCmd(e) && k.toLowerCase() === 'a') {
    selected = new Set(plan.map((x) => x.hash));
    renderSelection();
  } else if (k === 'Enter' || k === 'F2') startReword();
  else if (k === 'Delete' || (isMac && k === 'Backspace')) setAction('drop');
  else if ((k === 'F10' && e.shiftKey) || k === 'ContextMenu') {
    const r = list.querySelector<HTMLElement>('.rb-row.sel')?.getBoundingClientRect();
    showMenu(r ? r.left + 40 : 20, r ? r.bottom : 20);
  } else if (!isCtrlCmd(e) && !e.shiftKey && KEY[e.code]) {
    // e.code: Alt+letter produces other characters on macOS
    const a = KEY[e.code];
    if (a === 'reword') startReword();
    else setAction(a);
  } else handled = false;
  if (handled) {
    e.preventDefault();
    e.stopPropagation();
  }
});

// ---------- actions ----------

/**
 * Rows to unite for Squash/Fixup (IntelliJ getIndicesToUnite): a multi-selection as it is; a single row joins the
 * group of the nearest previous kept commit. Undefined when there is nothing to unite with.
 */
function uniteIndices(idx: number[]): number[] | undefined {
  if (idx.length > 1) return idx.some((i) => plan[i].action !== 'drop') ? idx : undefined;
  if (idx.length !== 1) return undefined;
  for (let k = idx[0] - 1; k >= 0; k--) {
    if (plan[k].action !== 'drop') return [headOfGroup(k), idx[0]];
  }
  return undefined;
}

function setAction(a: RebaseAction): void {
  if (editing) return;
  const idx = selectedPlanIndices();
  if (!idx.length) return;
  if (a === 'squash' || a === 'fixup') {
    const u = uniteIndices(idx);
    if (!u) return;
    let rootIndex: number;
    let newChildren: Item[];
    if (idx.length > 1) {
      const r = uniteRows(plan, u) as { rows: Item[]; indices: number[] };
      plan = r.rows.map((e, i) => (r.indices.slice(1).includes(i) ? { ...e, action: a, newMessage: undefined } : e));
      rootIndex = r.indices[0];
      newChildren = r.indices.slice(1).map((i) => plan[i]);
    } else {
      // the row stays where it is: it already follows its new root (only drops may be in between)
      plan = plan.map((e, i) => (i === idx[0] ? { ...e, action: a, newMessage: undefined } : e));
      rootIndex = u[0];
      newChildren = [plan[idx[0]]];
    }
    if (plan[rootIndex].action === 'drop') plan[rootIndex] = { ...plan[rootIndex], action: 'pick' };
    if (a === 'fixup') {
      render();
      return;
    }
    // squash = reword + fixup: the root gets the combined message and the inline editor opens (SquashAction)
    const root = plan[rootIndex];
    const rootMessage = root.newMessage ?? root.message;
    const messages = [rootMessage, ...newChildren.map((c) => c.message)];
    plan[rootIndex] = { ...root, newMessage: prettySquash(messages) };
    selected = new Set([root.hash]);
    lead = anchor = root.hash;
    render();
    startReword(root.hash);
    return;
  } else if (a === 'reword') {
    return startReword();
  } else {
    plan = plan.map((e, i) => {
      if (!idx.includes(i)) return e;
      const next: Item = { ...e, action: a };
      if (a === 'pick' || a === 'drop') next.newMessage = undefined;
      return next;
    });
  }
  render();
}

function move(delta: -1 | 1): void {
  if (editing) return;
  const disp = display();
  const dIdx = disp.map((e, i) => (selected.has(e.hash) ? i : -1)).filter((i) => i >= 0);
  const r = moveRows(disp, dIdx, delta);
  plan = r.rows;
  render();
  if (lead) reveal(lead);
}

function reset(): void {
  if (editing) return;
  plan = original.map((i) => ({ ...i }));
  selected = new Set([...selected].filter((h) => plan.some((e) => e.hash === h)));
  render();
}

// ---------- inline reword ----------

let editorArea: HTMLTextAreaElement | undefined;
let editorInitial = '';

function startReword(hash?: string): void {
  if (editing) return;
  const target = hash ?? (selected.size === 1 ? [...selected][0] : undefined);
  if (!target) return;
  const i = plan.findIndex((e) => e.hash === target);
  if (i < 0 || plan[i].action === 'drop') return;
  const head = headOfGroup(i);
  const item = plan[head];
  selected = new Set([item.hash]);
  lead = anchor = item.hash;
  editing = item.hash;
  const g = groups(plan).find((x) => x.head === head);
  editorInitial = item.newMessage ?? (g && groupMessage(plan, g)) ?? item.message;
  render();
  editorArea?.focus();
  void showDetails(item.hash);
}

function editorFor(item: Item): HTMLElement {
  const ta = h('textarea.jb-textarea', { value: editorInitial, spellcheck: true, rows: Math.min(12, Math.max(4, editorInitial.split('\n').length + 1)) });
  editorArea = ta;
  ta.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key === 'Enter' && isCtrlCmd(e)) {
      e.preventDefault();
      e.stopPropagation();
      applyReword(item.hash, ta.value);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      void cancelReword();
    }
  });
  return h('div.rb-editor', null, ta, h('div.rb-hint', null, `Press ${formatShortcut('CmdOrCtrl+Enter')} to apply changes`));
}

function applyReword(hash: string, text: string): void {
  if (!cleanMessage(text)) {
    dlg.setError('Commit message is empty');
    return;
  }
  const i = plan.findIndex((e) => e.hash === hash);
  if (i >= 0 && cleanMessage(text) !== cleanMessage(editorInitial)) {
    const e = plan[i];
    // the root of a squash group keeps its action and carries the group's message
    const squashGroup = groups(plan).find((g) => g.head === i)?.members.some((m) => plan[m].action === 'squash');
    plan[i] = { ...e, action: squashGroup ? e.action : 'reword', newMessage: text };
  }
  dlg.setError(undefined);
  closeEditor();
}

async function cancelReword(): Promise<void> {
  if (editorArea && cleanMessage(editorArea.value) !== cleanMessage(editorInitial)) {
    await nextTick();
    const ok = await confirmDialog({ title: 'Cancel Reword', message: 'Entered commit message will be lost', ok: 'Cancel Reword', cancel: 'Keep Editing' });
    if (!ok) {
      editorArea?.focus();
      return;
    }
  }
  closeEditor();
}

/** When another row is clicked while editing: applies nothing, closes the editor if nothing was typed. */
function commitEditorIfUnchanged(): boolean {
  if (editorArea && cleanMessage(editorArea.value) !== cleanMessage(editorInitial)) {
    void cancelReword();
    return false;
  }
  closeEditor();
  return true;
}

function closeEditor(): void {
  editing = undefined;
  editorArea = undefined;
  render();
  list.focus();
}

// ---------- drag & drop ----------

let dragging: string[] = [];
list.addEventListener('dragstart', (e) => {
  const row = (e.target as HTMLElement).closest<HTMLElement>('.rb-row');
  if (!row || editing) return e.preventDefault();
  pendingCollapse = undefined;
  const hash = row.dataset.hash!;
  if (!selected.has(hash)) selectOnly(hash);
  dragging = display().filter((x) => selected.has(x.hash)).map((x) => x.hash);
  e.dataTransfer?.setData('text/plain', dragging.join('\n'));
  if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
  requestAnimationFrame(() => list.querySelectorAll('.rb-row.sel').forEach((r) => r.classList.add('dragging')));
});
const clearMarks = () => list.querySelectorAll('.drop-before, .drop-after').forEach((r) => r.classList.remove('drop-before', 'drop-after'));
function dropTarget(e: DragEvent): number | undefined {
  const rows = [...list.querySelectorAll<HTMLElement>('.rb-row')];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i].getBoundingClientRect();
    if (e.clientY < r.top + r.height / 2) return i;
  }
  return rows.length;
}
list.addEventListener('dragover', (e) => {
  if (!dragging.length) return;
  e.preventDefault();
  clearMarks();
  const t = dropTarget(e);
  const rows = list.querySelectorAll<HTMLElement>('.rb-row');
  if (t === undefined) return;
  if (t < rows.length) rows[t].classList.add('drop-before');
  else rows[rows.length - 1]?.classList.add('drop-after');
});
list.addEventListener('dragleave', (e) => {
  if (!list.contains(e.relatedTarget as Node)) clearMarks();
});
list.addEventListener('drop', (e) => {
  e.preventDefault();
  clearMarks();
  const t = dropTarget(e);
  if (t === undefined || !dragging.length) return;
  const disp = display();
  const r = moveRowsTo(disp, dragging.map((hh) => disp.findIndex((x) => x.hash === hh)), t);
  plan = r.rows;
  dragging = [];
  render();
});
list.addEventListener('dragend', () => {
  dragging = [];
  clearMarks();
  list.querySelectorAll('.dragging').forEach((r) => r.classList.remove('dragging'));
});

// ---------- buttons ----------

function entries(): RebaseStartEntry[] {
  return plan.map((e) => ({ hash: e.hash, action: e.action, newMessage: e.newMessage }));
}

async function start(): Promise<void> {
  if (editing) return;
  const err = validatePlan(plan);
  if (err) return dlg.setError(err);
  dlg.setBusy(true, 'Starting rebase…');
  try {
    await rpc.call('start', entries());
  } catch (e) {
    dlg.setBusy(false);
    dlg.setError((e as Error).message);
  }
}

/** Lets the key/mouse event that triggered a modal finish first (else the modal's own Enter/Esc handling sees it). */
const nextTick = () => new Promise<void>((r) => setTimeout(r, 0));

async function cancel(): Promise<void> {
  if (isModified() || editing) {
    await nextTick();
    const r = await openModal({
      title: 'Cancel Rebase',
      width: 420,
      body: h('div.jb-dialog-message', null, 'Discard changes and cancel rebase?'),
      buttons: [
        { id: 'continue', label: 'Continue Rebasing', cancel: true },
        { id: 'discard', label: 'Discard', primary: true },
      ],
    }).result;
    if (r !== 'discard') return;
  }
  await rpc.call('cancel');
}

/** IntelliJ's "Git Commands" dialog: the generated todo as an Action / Hash / Subject table. */
async function viewCommands(): Promise<void> {
  await nextTick();
  const host = h('div.rb-cmds');
  openModal({
    title: 'Git Commands',
    width: 640,
    body: host,
    buttons: [{ id: 'ok', label: 'OK', primary: true, cancel: true }],
  });
  const table = new Table<{ action: string; hash: string; subject: string }>(host, {
    rowId: (r) => r.hash,
    header: true,
    columns: [
      { id: 'action', title: 'Action', width: 80, text: (r) => r.action },
      { id: 'hash', title: 'Hash', width: 90, text: (r) => r.hash },
      { id: 'subject', title: 'Subject', flex: true, minWidth: 200, text: (r) => r.subject },
    ],
  });
  table.setRows(describeTodo(plan));
}

rpc.on('headChanged', () => {
  headChanged = true;
  updateState();
});

render();
void showDetails(lead);
list.focus();
