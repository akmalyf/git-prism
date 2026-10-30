// Commit tool window page (PhpStorm "Commit" tool window): toolbar, changes tree with checkboxes (changelists or
// staging area), context menus and keyboard shortcuts, Rollback / changelist dialogs, and the commit area below.
import {
  emptyState,
  ensureStyles,
  h,
  highlightText,
  isCtrlCmd,
  isMac,
  progressLine,
  setFormatLocale,
  showContextMenu,
  showListPopup,
  Splitter,
  Toolbar,
  Tree,
  type MenuItem,
  type PopupEntry,
  type ToolbarItem,
} from '../shared/ui';
import { init, rpc, viewState } from '../shared/rpc';
import { validateCommit, validateStagedCommit, type ChangelistInfo, type CommitOptions, type CommitRequest, type Item, type ItemOp, type ViewModel, type ViewSettings } from '../../features/commit/protocol';
import css from './commit.css';
import { changelistDialog, confirmDeleteChangelists, rollbackDialog } from './dialogs';
import { buildTree, filesOf, filesOfNodes, type CNode, type NodeData } from './model';
import { CommitPanel } from './panel';

interface IgnoreTarget {
  label: string;
  file: string;
  dir: string;
  exists: boolean;
}

const boot = init<{ locale?: string }>();
if (boot.locale) setFormatLocale(boot.locale);
ensureStyles();
document.head.appendChild(h('style', null, css));

let vm: ViewModel = {
  loading: true,
  repos: [],
  lists: [],
  items: [],
  settings: { groupByDirectory: true, groupByModule: false, groupByRepository: true, showIgnored: false, doubleClick: 'diff', previewDiff: false, stagingArea: false, commitAll: true },
  options: { author: '', signOff: false, gpgSign: false, runHooks: true },
  stagingDraft: '',
};
let gotState = false;
let nodeOf = new Map<string, string>();
/** changelist id (or STAGING) whose draft the editor currently shows */
let draftTarget: string | undefined;
const STAGING = '\0staging';
let busy = false;
let pendingSelect: { keys: string[]; focusMessage?: boolean } | undefined;
/** events that arrived before the first state */
let pendingMessage: string | undefined;
let pendingRollback: string[] | undefined;
/**
 * Checkbox changes not yet acknowledged by the host (key → [included, version]). A state the host built before it
 * processed them may still arrive; these overrides keep the checkboxes as the user left them.
 */
const pendingIncl = new Map<string, [boolean, number]>();
let inclSeq = 0;

const staging = () => vm.settings.stagingArea;
const included = () => vm.items.filter((i) => (i.area === 'changes' || i.area === 'untracked') && i.included);
const keysOf = (items: readonly Item[]) => items.map((i) => i.key);

// ---------------------------------------------------------------- layout

const app = document.getElementById('app')!;
app.className = 'jb-app cv';
const progress = progressLine();
const emptyEl = h('div.cv-empty.jb-hidden');
const treePane = h('div.cv-tree-pane');

const tree = new Tree<NodeData>(null, {
  multiSelect: true,
  checkboxes: true,
  stateKey: 'commit.tree',
  defaultExpandDepth: Infinity,
  ariaLabel: 'Changes',
  renderLabel: (el, node, ctx) => {
    el.append(highlightText(node.label, ctx.matches));
    if (node.id === 'sec:conflict') {
      el.append(
        h('button.jb-link.cv-resolve', {
          type: 'button',
          onMousedown: (e: MouseEvent) => e.stopPropagation(),
          onClick: (e: MouseEvent) => {
            e.stopPropagation();
            resolveConflicts();
          },
        }, 'Resolve'),
      );
    }
  },
});
treePane.append(progress.element, tree.element, emptyEl);

const panel = new CommitPanel({
  primaryRepo: () => {
    const root = primaryRepoRoot();
    const r = vm.repos.find((x) => x.root === root);
    return r ? { root: r.root, empty: r.empty } : undefined;
  },
  commit: (push) => void commit(push),
  draftChanged: (text) => saveDraft(text),
  optionsChanged: (o: CommitOptions) => {
    vm.options = { ...o };
    void rpc.call('setOptions', o);
  },
});

const toolbar = new Toolbar(null, { items: toolbarItems(), className: 'cv-toolbar', ariaLabel: 'Commit toolbar' });
app.append(toolbar.element);
new Splitter(app, { orientation: 'vertical', first: treePane, second: panel.element, size: 200, fixed: 'second', min: 120, minOther: 60, stateKey: 'commit.split' });


function toolbarItems(): ToolbarItem[] {
  const items: ToolbarItem[] = [
    { id: 'refresh', icon: 'refresh', tooltip: 'Refresh', run: () => void refresh() },
    { id: 'rollback', icon: 'discard', tooltip: 'Rollback…', shortcut: 'CmdOrCtrl+Alt+Z', run: () => void openRollback() },
    { id: 'update', icon: 'repo-pull', tooltip: 'Update Project…', shortcut: 'CmdOrCtrl+T', run: () => void rpc.call('updateProject') },
  ];
  if (staging()) items.push({ id: 'stageTracked', icon: 'add', tooltip: 'Stage All Tracked', run: () => void rpc.call('stageAll', { tracked: true }) });
  else items.push({ id: 'shelve', icon: 'archive', tooltip: 'Shelve Changes…', run: () => shelve() });
  items.push(
    { id: 'stash', icon: 'git-stash', tooltip: 'Stash Changes…', run: () => void rpc.call('stash', { repo: primaryRepoRoot() }) },
    { id: 'view', icon: 'eye', tooltip: 'View Options', dropdown: () => viewOptionsMenu() },
    '-',
    { id: 'select', icon: 'target', tooltip: 'Select Opened File', run: () => void selectOpenedFile() },
    { id: 'expand', icon: 'expand-all', tooltip: 'Expand All', shortcut: 'CmdOrCtrl+=', run: () => tree.expandAll() },
    { id: 'collapse', icon: 'collapse-all', tooltip: 'Collapse All', shortcut: 'CmdOrCtrl+-', run: () => tree.collapseAll() },
  );
  return items;
}

function viewOptionsMenu(): MenuItem[] {
  const s = vm.settings;
  const set = <K extends keyof ViewSettings>(key: K, value: ViewSettings[K]) => () => void rpc.call('setSetting', { key, value });
  const items: MenuItem[] = [
    { header: 'Group By' },
    { label: 'Directory', checked: s.groupByDirectory, run: set('groupByDirectory', !s.groupByDirectory) },
    { label: 'Module', checked: s.groupByModule, run: set('groupByModule', !s.groupByModule) },
  ];
  // like IntelliJ, "Repository" grouping is only offered with several repositories
  if (vm.repos.length > 1) items.push({ label: 'Repository', checked: s.groupByRepository, run: set('groupByRepository', !s.groupByRepository) });
  items.push({ header: 'Show' }, { label: 'Ignored Files', checked: s.showIgnored, run: set('showIgnored', !s.showIgnored) });
  if (staging()) items.push('-', { label: 'Commit All when Nothing Is Staged', checked: s.commitAll, run: set('commitAll', !s.commitAll) });
  return items;
}

// ---------------------------------------------------------------- state

rpc.on<ViewModel>('state', (next) => applyState(next));
rpc.on<{ message: string }>('setMessage', ({ message }) => {
  if (!gotState) {
    pendingMessage = message;
    return;
  }
  if (panel.amend) void panel.setAmend(false, true);
  panel.setMessage(message, true);
  saveDraft(message);
});
rpc.on('focusMessage', () => panel.focus());
rpc.on<{ push: boolean }>('commit', ({ push }) => void commit(push));
rpc.on<{ keys: string[]; focusMessage?: boolean }>('select', (p) => {
  pendingSelect = p;
  applySelect();
});
rpc.on<{ keys: string[] }>('rollback', ({ keys }) => {
  if (gotState) void openRollback(keys);
  else pendingRollback = keys;
});

void rpc.call<ViewModel>('ready').then((first) => {
  if (!gotState) applyState(first);
});

function applyState(next: ViewModel): void {
  const modeChanged = next.settings.stagingArea !== vm.settings.stagingArea;
  const first = !gotState;
  vm = next;
  gotState = true;
  if (pendingIncl.size) for (const it of vm.items) {
    const o = pendingIncl.get(it.key);
    if (o) it.included = o[0];
  }
  const built = buildTree(vm, {
    stage: (n) => void op('stage', filesOf(n).filter((i) => i.area === 'unstaged' || i.area === 'untracked')),
    unstage: (n) => void op('unstage', filesOf(n).filter((i) => i.area === 'staged')),
  });
  nodeOf = built.nodeOf;
  tree.setRoots(built.roots, { resetChecks: true });
  if (first || modeChanged) toolbar.setItems(toolbarItems());
  const tracked = vm.items.some((i) => i.area !== 'untracked' && i.area !== 'ignored');
  toolbar.update('rollback', { disabled: !tracked });
  if (!staging()) toolbar.update('shelve', { disabled: !vm.items.some((i) => i.area === 'changes' || i.area === 'untracked') });
  if (first) panel.setOptions(vm.options);
  updateEmpty();
  updatePanel();
  syncDraft(first || modeChanged);
  if (pendingMessage !== undefined) {
    panel.setMessage(pendingMessage, true);
    saveDraft(pendingMessage);
    pendingMessage = undefined;
  }
  applySelect();
  if (pendingRollback) {
    const keys = pendingRollback;
    pendingRollback = undefined;
    void openRollback(keys);
  }
}

function applySelect(): void {
  if (!pendingSelect || !gotState) return;
  const ids = pendingSelect.keys.map((k) => nodeOf.get(k)).filter((x): x is string => !!x);
  if (!ids.length && vm.loading) return;
  const focusMessage = pendingSelect.focusMessage;
  pendingSelect = undefined;
  if (ids.length) {
    ids.forEach((id) => tree.reveal(id));
    tree.select(ids, { reveal: true, focus: !focusMessage });
  }
  if (focusMessage) panel.focus();
}

function updateEmpty(): void {
  const empty = !tree.getRoots().length;
  emptyEl.classList.toggle('jb-hidden', !empty);
  progress[vm.loading ? 'show' : 'hide']();
  if (!empty) return;
  let lines: Parameters<typeof emptyState>[0];
  if (vm.loading) lines = ['Loading changes…'];
  else if (!vm.repos.length) lines = ['No Git repository found in the workspace'];
  else if (staging()) lines = ['Nothing to commit, working tree is clean'];
  else lines = ['No changes'];
  emptyEl.replaceChildren(emptyState(lines));
}

function updatePanel(): void {
  const root = primaryRepoRoot();
  const repo = vm.repos.find((r) => r.root === root);
  panel.setAmendEnabled(!!repo && !repo.empty);
  if (staging()) {
    const staged = vm.items.some((i) => i.area === 'staged');
    const tracked = vm.items.some((i) => i.area === 'unstaged');
    panel.setCommitAll(vm.settings.commitAll && !staged && tracked);
  } else panel.setCommitAll(false);
}

function primaryRepoRoot(): string | undefined {
  const pool = staging() ? vm.items.filter((i) => i.area === 'staged') : included();
  if (pool[0]) return pool[0].repo;
  const lead = tree.getLead();
  if (lead?.data?.t === 'file') return lead.data.item.repo;
  return vm.repos.find((r) => !r.empty)?.root ?? vm.repos[0]?.root;
}

/** Changelist holding the commit message: the list of the included changes, else the active one. */
function targetList(): string | undefined {
  const lists = new Set(included().filter((i) => i.area === 'changes').map((i) => i.list));
  if (lists.size === 1) return [...lists][0];
  return vm.lists.find((l) => l.active)?.id;
}

function syncDraft(force: boolean): void {
  if (panel.amend && !force) return;
  const t = staging() ? STAGING : targetList();
  if (t === draftTarget && !force) return;
  panel.flushDraft();
  draftTarget = t;
  const text = t === STAGING ? vm.stagingDraft : (vm.lists.find((l) => l.id === t)?.comment ?? '');
  if (panel.amend) return;
  panel.setMessage(text);
}

function saveDraft(text: string): void {
  if (draftTarget === STAGING) {
    vm.stagingDraft = text;
    void rpc.call('setDraft', { text });
  } else if (draftTarget) {
    const l = vm.lists.find((x) => x.id === draftTarget);
    if (l) l.comment = text;
    void rpc.call('setDraft', { list: draftTarget, text });
  }
}

async function refresh(): Promise<void> {
  progress.show();
  try {
    await rpc.call('refresh');
  } finally {
    if (!vm.loading) progress.hide();
  }
}

// ---------------------------------------------------------------- tree events

tree.onDidChangeChecked(({ nodes }) => {
  const on: string[] = [];
  const off: string[] = [];
  for (const n of nodes) {
    if (n.data?.t !== 'file') continue;
    n.data.item.included = !!n.checked;
    (n.checked ? on : off).push(n.data.item.key);
  }
  const send = (keys: string[], value: boolean) => {
    if (!keys.length) return;
    const v = ++inclSeq;
    for (const k of keys) pendingIncl.set(k, [value, v]);
    const done = () => {
      for (const k of keys) if (pendingIncl.get(k)?.[1] === v) pendingIncl.delete(k);
    };
    rpc.call('setIncluded', { keys, included: value }).then(done, done);
  };
  send(on, true);
  send(off, false);
  panel.clearError();
  updatePanel();
  syncDraft(false);
});

let previewTimer: number | undefined;
tree.onDidChangeSelection((nodes) => {
  if (!vm.settings.previewDiff) return;
  clearTimeout(previewTimer);
  if (nodes.length !== 1 || nodes[0].data?.t !== 'file') return;
  previewTimer = window.setTimeout(() => showDiff(false), 150);
});

tree.onDidActivate(({ node }) => {
  if (node.data?.t !== 'file') return;
  const it = node.data.item;
  if (it.area === 'conflict') void op('merge', [it]);
  else if (vm.settings.doubleClick === 'source' && it.kind !== 'D') void rpc.call('open', { keys: [it.key] });
  else showDiff(false);
});

tree.onContextMenu(({ nodes, x, y }) => void contextMenu(nodes, x, y));

tree.element.addEventListener('keydown', (e) => {
  if (e.defaultPrevented) return;
  const mod = isCtrlCmd(e);
  const k = e.key.toLowerCase();
  const sel = () => filesOfNodes(tree.getSelection());
  let handled = true;
  if (mod && !e.altKey && !e.shiftKey && k === 'd') showDiff(false);
  else if (e.key === 'F4' && !mod) void rpc.call('open', { keys: keysOf(sel()) });
  else if (mod && e.altKey && (k === 'z' || e.code === 'KeyZ')) void openRollback();
  else if (mod && e.altKey && (k === 'a' || e.code === 'KeyA')) {
    const files = sel().filter((i) => i.area === 'untracked' || i.area === 'unstaged');
    if (files.length) void op(staging() ? 'stage' : 'add', files);
  } else if (e.key === 'F6' && !mod && !staging()) void moveToChangelist(sel().filter((i) => i.area === 'changes'));
  else if (e.key === 'Delete' || (isMac && e.key === 'Backspace' && e.metaKey)) {
    const files = sel();
    if (files.length) void op('delete', files);
  } else if (mod && e.key === 'Enter') void commit(e.altKey);
  else handled = false;
  if (handled) {
    e.preventDefault();
    e.stopPropagation();
  }
});

// View-wide shortcuts advertised by the toolbar / buttons: Update Project… (Cmd/Ctrl+T), Rollback… (Cmd/Ctrl+Alt+Z)
// and Commit and Push… (Cmd/Ctrl+Alt+K; the message editor handles it itself). The global keybindings of these
// commands exclude the focused Commit view, so they don't run twice.
document.addEventListener('keydown', (e) => {
  if (e.defaultPrevented || !isCtrlCmd(e) || e.shiftKey || document.querySelector('.jb-modal-overlay, .jb-menu, .jb-popup')) return;
  const code = e.code;
  if (!e.altKey && code === 'KeyT') void rpc.call('updateProject');
  else if (e.altKey && code === 'KeyZ') void openRollback();
  else if (e.altKey && code === 'KeyK') void commit(true);
  else return;
  e.preventDefault();
  e.stopPropagation();
});

// ---------------------------------------------------------------- actions

function op(name: ItemOp, items: readonly Item[]): Promise<unknown> {
  if (!items.length) return Promise.resolve();
  return rpc.call('op', { op: name, keys: keysOf(items) });
}

/** Show Diff: the selected files, or (one selected) every change of its section so Previous/Next File works. */
function showDiff(_focus: boolean): void {
  const sel = tree.getSelection();
  const files = filesOfNodes(sel);
  if (!files.length) return;
  if (files.length === 1 && sel.length === 1) {
    let top: CNode = sel[0];
    for (let p = tree.getParent(top.id); p; p = tree.getParent(top.id)) top = p;
    const all = filesOf(top);
    const index = Math.max(0, all.findIndex((i) => i.key === files[0].key));
    void rpc.call('showDiff', { keys: keysOf(all), index });
  } else void rpc.call('showDiff', { keys: keysOf(files), index: 0 });
}

function resolveConflicts(): void {
  const repos = new Set(vm.items.filter((i) => i.area === 'conflict').map((i) => i.repo));
  void rpc.call('resolveConflicts', { repo: repos.size === 1 ? [...repos][0] : undefined });
}

async function selectOpenedFile(): Promise<void> {
  const f = await rpc.call<{ repo: string; path: string } | undefined>('activeFile');
  if (!f) return;
  const it = vm.items.find((i) => i.repo === f.repo && i.path === f.path && i.area !== 'ignored') ?? vm.items.find((i) => i.repo === f.repo && i.path === f.path);
  const id = it && nodeOf.get(it.key);
  if (!id) return;
  tree.reveal(id);
  tree.select([id], { reveal: true, focus: true });
}

function selectionOrIncluded(): Item[] {
  const sel = filesOfNodes(tree.getSelection());
  return sel.length ? sel : included();
}

function shelve(): void {
  const items = selectionOrIncluded().filter((i) => i.area === 'changes' || i.area === 'untracked');
  void op('shelve', items.length ? items : vm.items.filter((i) => i.area === 'changes'));
}

async function openRollback(keys?: string[]): Promise<void> {
  const areas = staging() ? ['staged', 'unstaged', 'conflict'] : ['changes', 'conflict'];
  const candidates = vm.items.filter((i) => areas.includes(i.area));
  if (!candidates.length) return;
  let checked: Set<string>;
  if (keys) checked = new Set(keys);
  else {
    const selNodes = tree.getSelection();
    const sel = filesOfNodes(selNodes).filter((i) => areas.includes(i.area));
    if (sel.length) checked = new Set(keysOf(sel));
    else if (!staging()) {
      const active = vm.lists.find((l) => l.active)?.id;
      checked = new Set(keysOf(candidates.filter((i) => i.list === active || i.area === 'conflict')));
    } else checked = new Set(keysOf(candidates));
  }
  const res = await rollbackDialog(candidates, checked, vm.repos, viewState.get('rollback.deleteAdded', false));
  if (!res) return;
  viewState.set('rollback.deleteAdded', res.deleteAdded);
  await rpc.call('rollback', res);
}

async function newChangelist(move?: Item[]): Promise<void> {
  const r = await changelistDialog(vm.lists);
  if (!r) return;
  await rpc.call('newChangelist', { ...r, move: move ? keysOf(move) : undefined });
}

async function editChangelist(l: ChangelistInfo): Promise<void> {
  const r = await changelistDialog(vm.lists, l);
  if (!r) return;
  await rpc.call('editChangelist', { id: l.id, ...r });
}

async function deleteChangelists(lists: ChangelistInfo[]): Promise<void> {
  const nonEmpty = lists.some((l) => vm.items.some((i) => i.list === l.id));
  if (nonEmpty && !(await confirmDeleteChangelists(lists))) return;
  await rpc.call('removeChangelists', { ids: lists.map((l) => l.id) });
}

async function moveToChangelist(items: Item[], at?: { x: number; y: number }): Promise<void> {
  if (!items.length) return;
  const current = new Set(items.map((i) => i.list));
  const entries: PopupEntry<string>[] = vm.lists
    .filter((l) => !(current.size === 1 && current.has(l.id)))
    .map((l) => ({ value: l.id, label: l.name, icon: l.active ? 'check' : undefined, description: l.active ? 'active' : undefined }));
  if (entries.length) entries.push('-');
  entries.push({ value: '\0new', label: 'New Changelist…', icon: 'add' });
  const lead = document.querySelector('.jb-tree-row.jb-lead') ?? tree.element;
  const picked = await showListPopup<string>(at ?? lead, { title: 'Move to Another Changelist', items: entries, search: vm.lists.length > 10, width: 300 });
  if (!picked?.length) return;
  if (picked[0] === '\0new') await newChangelist(items);
  else await rpc.call('moveToChangelist', { keys: keysOf(items), list: picked[0] });
}

async function commitFiles(items: Item[]): Promise<void> {
  if (!items.length) return;
  if (!staging()) await rpc.call('includeOnly', { keys: keysOf(items) });
  panel.focus();
}

async function contextMenu(nodes: CNode[], x: number, y: number): Promise<void> {
  const files = filesOfNodes(nodes);
  const tracked = files.filter((i) => i.area === 'changes');
  const unversioned = files.filter((i) => i.area === 'untracked');
  const conflicts = files.filter((i) => i.area === 'conflict');
  const staged = files.filter((i) => i.area === 'staged');
  const unstaged = files.filter((i) => i.area === 'unstaged');
  const lists = nodes.filter((n) => n.data?.t === 'list').map((n) => (n.data as { list: ChangelistInfo }).list);
  const listOfSel = lists.length === 1 ? lists[0] : undefined;
  const repos = new Set(files.map((i) => i.repo));
  const ignoreTargets = unversioned.length && repos.size === 1 ? await rpc.call<IgnoreTarget[]>('ignoreTargets', { keys: keysOf(unversioned) }) : [];
  const fileNames = (n: number) => (n === 1 ? 'Commit File…' : 'Commit Files…');
  const items: MenuItem[] = [];
  const sep = () => {
    if (items.length && items[items.length - 1] !== '-') items.push('-');
  };
  const addIgnore = () => {
    if (!ignoreTargets.length) return;
    items.push({
      label: 'Add to .gitignore',
      icon: 'circle-slash',
      submenu: ignoreTargets.map((t) => ({ label: t.label, description: t.exists ? undefined : 'new', run: () => void rpc.call('addToIgnore', { keys: keysOf(unversioned), target: t }) })),
    });
  };
  if (conflicts.length) {
    items.push(
      { label: 'Merge…', icon: 'git-merge', run: () => void op('merge', conflicts) },
      { label: 'Accept Theirs', run: () => void op('acceptTheirs', conflicts) },
      { label: 'Accept Yours', run: () => void op('acceptYours', conflicts) },
      '-',
    );
  }
  const diffable = files.filter((i) => i.area !== 'ignored');
  if (!staging()) {
    if (tracked.length || unversioned.length) items.push({ label: fileNames(tracked.length + unversioned.length), icon: 'git-commit', run: () => void commitFiles([...tracked, ...unversioned]) });
    if (tracked.length || conflicts.length) items.push({ label: 'Rollback…', icon: 'discard', shortcut: 'CmdOrCtrl+Alt+Z', run: () => void openRollback(keysOf([...tracked, ...conflicts])) });
    if (tracked.length) items.push({ label: 'Move to Another Changelist…', shortcut: 'F6', run: () => void moveToChangelist(tracked, { x, y }) });
    if (diffable.length) items.push({ label: 'Show Diff', icon: 'diff', shortcut: 'CmdOrCtrl+D', run: () => showDiff(true) });
    if (files.length) items.push({ label: 'Jump to Source', icon: 'go-to-file', shortcut: 'F4', run: () => void rpc.call('open', { keys: keysOf(files) }) });
    sep();
    if (files.some((i) => i.kind !== 'D')) items.push({ label: 'Delete', icon: 'trash', shortcut: isMac ? 'Cmd+Backspace' : 'Delete', run: () => void op('delete', files) });
    if (unversioned.length) items.push({ label: 'Add to VCS', icon: 'add', shortcut: 'CmdOrCtrl+Alt+A', run: () => void op('add', unversioned) });
    addIgnore();
    sep();
    items.push({ label: 'New Changelist…', icon: 'add', run: () => void newChangelist() });
    if (lists.length && vm.lists.length > 1) items.push({ label: 'Delete Changelist', icon: 'remove', run: () => void deleteChangelists(lists) });
    if (listOfSel && !listOfSel.active) items.push({ label: 'Set Active Changelist', icon: 'check-all', run: () => void rpc.call('setActiveChangelist', { id: listOfSel.id }) });
    if (listOfSel) items.push({ label: 'Edit Changelist…', icon: 'edit', run: () => void editChangelist(listOfSel) });
    if (tracked.length || unversioned.length) {
      items.push(
        { label: 'Create Patch…', run: () => void op('createPatch', [...tracked, ...unversioned]) },
        { label: 'Copy as Patch to Clipboard', run: () => void op('copyPatch', [...tracked, ...unversioned]) },
        { label: 'Shelve Changes…', icon: 'archive', run: () => void op('shelve', [...tracked, ...unversioned]) },
        { label: 'Stash Changes…', icon: 'git-stash', run: () => void op('stash', [...tracked, ...unversioned]) },
      );
    }
    sep();
    items.push({ label: 'Refresh', icon: 'refresh', run: () => void refresh() });
  } else {
    const stageable = [...unstaged, ...unversioned];
    if (stageable.length) items.push({ label: 'Stage', icon: 'add', shortcut: 'CmdOrCtrl+Alt+A', run: () => void op('stage', stageable) });
    if (unversioned.length) items.push({ label: 'Stage Without Content', run: () => void op('addNoContent', unversioned) });
    if (staged.length) items.push({ label: 'Unstage', icon: 'remove', run: () => void op('unstage', staged) });
    if (staged.length || unstaged.length) items.push({ label: 'Stash Files', icon: 'git-stash', run: () => void op('stash', [...staged, ...unstaged]) });
    if (staged.length || unstaged.length || conflicts.length) items.push({ label: 'Rollback…', icon: 'discard', shortcut: 'CmdOrCtrl+Alt+Z', run: () => void openRollback(keysOf([...staged, ...unstaged, ...conflicts])) });
    if (files.some((i) => i.kind !== 'D')) items.push({ label: 'Delete', icon: 'trash', shortcut: isMac ? 'Cmd+Backspace' : 'Delete', run: () => void op('delete', files) });
    addIgnore();
    sep();
    if (diffable.length) items.push({ label: 'Show Diff', icon: 'diff', shortcut: 'CmdOrCtrl+D', run: () => showDiff(true) });
    // Git.Stage.ThreeSideDiff, then Git.Stage.Index.File.Menu (staged) / Git.Stage.Local.File.Menu (unstaged)
    const inIndex = [...staged.filter((i) => i.kind !== 'D'), ...unstaged];
    if (staged.length || unstaged.length) items.push({ label: 'Compare HEAD, Staged and Local Versions', run: () => void op('threeWay', [...staged, ...unstaged]) });
    if (files.length) items.push({ label: 'Jump to Source', icon: 'go-to-file', shortcut: 'F4', run: () => void rpc.call('open', { keys: keysOf(files) }) });
    if (inIndex.length || staged.length) {
      sep();
      if (inIndex.length === 1) items.push({ label: 'Show Staged Version', run: () => void op('showStaged', inIndex) });
      const local = staged.filter((i) => i.kind !== 'D');
      if (local.length === 1 && !unstaged.some((i) => i.kind === 'D' && i.path === local[0].path)) items.push({ label: 'Show Local Version', run: () => void op('showLocal', local) });
      if (unstaged.length) items.push({ label: 'Compare with Staged Version', run: () => void op('compareLocalStaged', unstaged) });
      if (staged.length) {
        items.push(
          { label: 'Compare with HEAD Version', run: () => void op('compareStagedHead', staged) },
          { label: 'Compare with Local Version', run: () => void op('compareStagedLocal', staged) },
        );
      }
      sep();
    }
    if (staged.length || unstaged.length || unversioned.length) {
      items.push(
        { label: 'Create Patch…', run: () => void op('createPatch', [...staged, ...unstaged, ...unversioned]) },
        { label: 'Copy as Patch to Clipboard', run: () => void op('copyPatch', [...staged, ...unstaged, ...unversioned]) },
      );
    }
    const sections = nodes.filter((n) => n.data?.t === 'section').map((n) => (n.data as { area: string }).area);
    if (sections.length) {
      sep();
      if (sections.includes('unstaged') || sections.includes('untracked')) items.push({ label: 'Stage All', run: () => void rpc.call('stageAll', { tracked: false }) });
      if (sections.includes('unstaged')) items.push({ label: 'Stage All Tracked', run: () => void rpc.call('stageAll', { tracked: true }) });
      if (sections.includes('staged')) items.push({ label: 'Unstage All', run: () => void rpc.call('unstageAll', {}) });
    }
  }
  const historyTarget = files.length === 1 ? files[0] : undefined;
  if (historyTarget && historyTarget.area !== 'untracked' && historyTarget.area !== 'ignored') {
    sep();
    if (staging()) items.push({ label: 'Show History', icon: 'history', run: () => void op('showHistory', [historyTarget]) });
    else {
      items.push({
        label: 'Git',
        submenu: [
          { label: 'Show History', icon: 'history', run: () => void op('showHistory', [historyTarget]) },
          { label: 'Annotate', disabled: historyTarget.kind === 'A' || historyTarget.kind === 'D', run: () => void op('annotate', [historyTarget]) },
        ],
      });
    }
  }
  while (items[items.length - 1] === '-') items.pop();
  if (items.length) showContextMenu(items, x, y);
}

// ---------------------------------------------------------------- commit

async function commit(push: boolean): Promise<void> {
  if (busy) return;
  const message = panel.message;
  const amend = panel.amend;
  if (!staging()) {
    const err = validateCommit({ message, hasChanges: included().length > 0, amend });
    if (err) return panel.showError(err);
  } else {
    const hasStaged = vm.items.some((i) => i.area === 'staged') || (vm.settings.commitAll && vm.items.some((i) => i.area === 'unstaged'));
    const err = validateStagedCommit({ message, hasStaged, amend });
    if (err) return panel.showError(err);
  }
  panel.flushDraft();
  busy = true;
  panel.setBusy(true);
  progress.show();
  const req: CommitRequest = {
    message,
    amend,
    amendTarget: amend ? panel.amendTarget?.hash : undefined,
    amendRepo: amend ? (panel.amendTarget?.repo ?? primaryRepoRoot()) : undefined,
    push,
    keys: staging() ? [] : keysOf(included()),
    list: staging() ? undefined : draftTarget,
    options: panel.commitOptions,
  };
  try {
    const res = await rpc.call<{ ok: boolean; error?: string }>('commit', req);
    if (res.ok) {
      panel.reset();
      if (draftTarget === STAGING) vm.stagingDraft = '';
      else {
        const l = vm.lists.find((x) => x.id === draftTarget);
        if (l) l.comment = '';
      }
      panel.setOptions({ ...panel.commitOptions, author: '' });
    } else if (res.error) panel.showError(res.error);
  } catch (e) {
    panel.showError(e instanceof Error ? e.message : String(e));
  } finally {
    busy = false;
    panel.setBusy(false);
    progress.hide();
  }
}
