// Git Log webview (bundle 'log'): PhpStorm's Git tool window "Log" tab — branches pane | commit table with the
// filter bar | changed files + commit details, optional diff preview (right/bottom); all splits persisted. Talks to
// src/features/log/controller.ts (see PROTOCOL.md). Also used for "Show Git Log" and "History: <file>" tabs.
import type { CommitId, CommitOp, GoToResult, HistoryAction, HistoryFileInfo, LogColumn, LogFilters, LogInit, LogRow, LogSettingKey, LogSettings, LogState, RefItem } from '../../features/log/protocol';
import { init, rpc, viewState } from '../shared/rpc';
import {
  ensureStyles,
  h,
  icon,
  isCtrlCmd,
  progressLine,
  promptDialog,
  showContextMenu,
  Splitter,
  Toolbar,
  type EmptyLine,
  type MenuItem,
  type ToolbarItem,
} from '../shared/ui';
import { BranchesPanel, branchActions } from './branches';
import { ChangesPanel } from './changes';
import { buildCommitMenu, type CommitAction, type CommitMenuEntry, type MenuCommit } from './commitmenu';
import { CommitTable } from './committable';
import { DetailsPane } from './details';
import { FilterBar } from './filterbar';
import { buildFileHistoryMenu, fileHistoryToolbar, type FileHistoryMenuEntry } from './historymenu';
import css from './log.css';
import { LogModel } from './model';
import { DiffPreview } from './preview';

ensureStyles();
document.head.appendChild(h('style', null, css));

const boot = init<LogInit>() ?? { mode: 'log', title: 'Log', hideBranches: false, editorTab: false };
const history = boot.mode === 'history';
const model = new LogModel();

// ---------------------------------------------------------------- actions

const setFilters = (f: LogFilters) => void rpc.call('setFilters', f);
const setSetting = (key: LogSettingKey, value: unknown) => void rpc.call('setSetting', { key, value });
const setOption = (o: { showChangesToParents?: boolean; showOnlyAffectedChanges?: boolean }) => void rpc.call('setOptions', o);

let picked = new Set<string>();
let highlightNotPicked = viewState.get('log.highlightNotPicked', false);

// ---------------------------------------------------------------- components

const progress = progressLine();
const banner = h('div.lg-banner.jb-hidden');
const filterBar = new FilterBar({ state: () => model.state, refs: () => model.refs, setFilters, historyPaths: boot.historyPaths });
const changes = new ChangesPanel({ state: () => model.state, history, setOption, setSetting: (k, v) => setSetting(k, v) });
const details = new DetailsPane({ goTo: (t) => void goTo(t) });
const preview = new DiffPreview();
const table = new CommitTable(
  model,
  {
    isPicked: (r) => picked.size > 0 && picked.has(`${r.root}|${r.hash}`),
    showDiff: () => (history ? runHistoryAction('showDiff') : void changes.showDiffForCommit()),
    contextMenu: (x, y) => (history ? historyContextMenu(x, y) : commitContextMenu(x, y)),
  },
  (w) => viewState.set('log.columnWidths', w),
  viewState.get<Partial<Record<LogColumn, number>>>('log.columnWidths', {}),
);
const branches = boot.hideBranches
  ? undefined
  : new BranchesPanel({
      refs: () => model.refs,
      branchFilter: () => model.state.filters.branches,
      setBranchFilter: (b) => setFilters({ ...model.state.filters, branches: b?.length ? b : undefined }),
      navigate: (ref, root) => void goTo(ref, false, root),
      hide: () => setSetting('showBranches', false),
    });

// ---------------------------------------------------------------- toolbars

const sortToolbar = new Toolbar(filterBar.sortSlot, { items: [], overflow: false, ariaLabel: 'Graph options' });
const rightToolbar = new Toolbar(filterBar.rightSlot, { items: [], overflow: false, ariaLabel: 'Log toolbar' });

function check(label: string, key: LogSettingKey): MenuItem {
  const s = model.settings;
  return { label, checked: !!s[key], run: () => setSetting(key, !s[key]) };
}

function viewOptions(): MenuItem[] {
  const s = model.settings;
  const cols = s.columns;
  const toggleCol = (c: LogColumn) => () => setSetting('columns', cols.includes(c) ? cols.filter((x) => x !== c) : [...cols, c]);
  const singleBranch = model.state.filters.branches?.length === 1 && model.state.filters.branches[0] !== 'HEAD';
  const items: MenuItem[] = [{ header: 'Show' }];
  if (model.state.roots.length > 1) items.push({ label: 'Root Names', checked: cols.includes('root'), run: toggleCol('root') });
  items.push(
    check('Compact References View', 'compactReferences'),
    check('Tag Names', 'showTagNames'),
    check('Long Edges', 'showLongEdges'),
    check('Commit Timestamp', 'preferCommitDate'),
    check('References on the Left', 'referencesOnLeft'),
    {
      label: 'Columns',
      submenu: () => [
        { label: 'Author', checked: cols.includes('author'), run: toggleCol('author') },
        { label: 'Date', checked: cols.includes('date'), run: toggleCol('date') },
        { label: 'Hash', checked: cols.includes('hash'), run: toggleCol('hash') },
      ],
    },
    '-',
    { header: 'Highlight' },
    check('My Commits', 'highlightMyCommits'),
    check('Merge Commits', 'highlightMergeCommits'),
    check('Current Branch', 'highlightCurrentBranch'),
    {
      label: 'Not Cherry-Picked Commits',
      checked: highlightNotPicked,
      description: singleBranch ? undefined : '(filter by one branch)',
      run: () => {
        highlightNotPicked = !highlightNotPicked;
        viewState.set('log.highlightNotPicked', highlightNotPicked);
        void updatePicked();
      },
    },
    { header: 'Layout' },
    check('Show Details', 'showDetails'),
    check('Show Diff Preview', 'showDiffPreview'),
    {
      label: 'Diff Preview Location',
      disabled: !s.showDiffPreview,
      submenu: () => [
        { label: 'Bottom', radio: true, checked: s.diffPreviewLocation === 'bottom', run: () => setSetting('diffPreviewLocation', 'bottom') },
        { label: 'Right', radio: true, checked: s.diffPreviewLocation === 'right', run: () => setSetting('diffPreviewLocation', 'right') },
      ],
    },
  );
  if (!boot.hideBranches) items.push(check('Branches', 'showBranches'));
  items.push('-', { label: 'Open New Git Log Editor Tab', icon: 'add', run: () => void rpc.call('openInEditorTab') }, { label: 'Show Git Console', run: () => void rpc.call('showConsole') });
  return items;
}

/** Vcs.FileHistory.PresentationSettings: Commit Timestamp, Columns, layout. */
function historyViewOptions(): MenuItem[] {
  const s = model.settings;
  const cols = s.columns;
  const toggleCol = (c: LogColumn) => () => setSetting('columns', cols.includes(c) ? cols.filter((x) => x !== c) : [...cols, c]);
  return [
    { header: 'Show' },
    check('Commit Timestamp', 'preferCommitDate'),
    {
      label: 'Columns',
      submenu: () => [
        { label: 'Author', checked: cols.includes('author'), run: toggleCol('author') },
        { label: 'Date', checked: cols.includes('date'), run: toggleCol('date') },
        { label: 'Hash', checked: cols.includes('hash'), run: toggleCol('hash') },
      ],
    },
    { header: 'Layout' },
    check('Show Details', 'showDetails'),
    check('Show Diff Preview', 'showDiffPreview'),
    {
      label: 'Diff Preview Location',
      disabled: !s.showDiffPreview,
      submenu: () => [
        { label: 'Bottom', radio: true, checked: s.diffPreviewLocation === 'bottom', run: () => setSetting('diffPreviewLocation', 'bottom') },
        { label: 'Right', radio: true, checked: s.diffPreviewLocation === 'right', run: () => setSetting('diffPreviewLocation', 'right') },
      ],
    },
  ];
}

/** Vcs.FileHistory.Toolbar + Vcs.FileHistory.Toolbar.RightCorner. */
function updateHistoryToolbar(): void {
  const t = fileHistoryToolbar(menuCommits(table.selectedRows()));
  rightToolbar.setItems([
    { id: 'refresh', icon: 'refresh', tooltip: 'Refresh', shortcut: 'CmdOrCtrl+R', run: () => void rpc.call('refresh') },
    { id: 'diff', icon: 'diff', tooltip: t.showDiff.label, shortcut: 'CmdOrCtrl+D', disabled: !t.showDiff.enabled, run: () => runHistoryAction('showDiff') },
    { id: 'affected', icon: 'list-unordered', tooltip: 'Show All Affected Files', disabled: !t.showAllAffected, run: () => runHistoryAction('showAllAffected') },
    '-',
    { id: 'view', icon: 'eye', tooltip: 'View Options', dropdown: historyViewOptions },
    '-',
    { id: 'selectInLog', icon: 'source-control', tooltip: 'Show in Git Log', disabled: !t.selectInLog, run: () => runHistoryAction('selectInLog') },
  ]);
}

function updateToolbars(): void {
  if (history) return updateHistoryToolbar();
  const s = model.settings;
  sortToolbar.setItems([
    {
      id: 'sort',
      icon: s.sortType === 'date' ? 'list-flat' : 'type-hierarchy-sub',
      tooltip: 'Graph Options',
      dropdown: () => [
        { header: 'Sort' },
        { label: 'Topologically', radio: true, checked: s.sortType === 'topological', description: '', run: () => setSetting('sortType', 'topological') },
        { label: 'By Commit Date', radio: true, checked: s.sortType === 'date', run: () => setSetting('sortType', 'date') },
        { header: 'Options' },
        { label: 'First Parent', checked: s.firstParent, run: () => setSetting('firstParent', !s.firstParent) },
      ],
    },
  ]);
  const sel = table.selectedRows();
  const canPick = sel.length > 0 && new Set(sel.map((r) => r.root)).size === 1 && !sel.every((r) => r.onCurrentBranch);
  const items: ToolbarItem[] = [
    { id: 'cherry', icon: 'git-stash-apply', tooltip: 'Cherry-Pick', disabled: !canPick, run: () => runCommitOp('cherryPick') },
    { id: 'refresh', icon: 'refresh', tooltip: 'Refresh', shortcut: 'CmdOrCtrl+R', run: () => void rpc.call('refresh') },
    { id: 'view', icon: 'eye', tooltip: 'View Options', dropdown: viewOptions },
    { id: 'goto', icon: 'search', tooltip: 'Go To Hash/Branch/Tag', run: () => void askGoTo() },
  ];
  rightToolbar.setItems(items);
}

// ---------------------------------------------------------------- layout

const island = (cls: string, ...children: HTMLElement[]) => h(`div.jb-island.lg-island.${cls}`, null, ...children);
const center = island('lg-center', progress.element, filterBar.element, banner, table.element);
const changesIsland = island('lg-changes-island', changes.element);
const detailsIsland = island('lg-details-island', details.element);
const rightPreviewHost = island('lg-preview-island');
const bottomPreviewHost = island('lg-preview-island');

const detailsSplit = new Splitter(null, { orientation: 'vertical', first: changesIsland, second: detailsIsland, fixed: 'second', size: 220, min: 60, minOther: 80, stateKey: 'log.split.details', collapsible: true });
const rightSplit = new Splitter(null, { first: detailsSplit.element, second: rightPreviewHost, fixed: 'second', size: 520, min: 200, minOther: 200, stateKey: 'log.split.preview', collapsible: true });
const restSplit = new Splitter(null, { first: center, second: rightSplit.element, fixed: 'second', size: 380, min: 200, minOther: 320, stateKey: 'log.split.right' });
const strip = h('button.lg-branches-strip.jb-hidden', { type: 'button', title: 'Branches', onClick: () => setSetting('showBranches', true) }, h('span', null, 'Branches'));
const rest = h('div.lg-rest', null, strip, restSplit.element);
const branchesIsland = island('lg-branches-island', ...(branches ? [branches.element] : []));
const branchSplit = new Splitter(null, { first: branchesIsland, second: rest, fixed: 'first', size: 250, min: 150, minOther: 420, stateKey: 'log.split.branches', collapsible: true });
const outer = new Splitter(null, { orientation: 'vertical', first: branchSplit.element, second: bottomPreviewHost, fixed: 'second', size: 300, min: 120, minOther: 200, stateKey: 'log.split.bottom', collapsible: true });
for (const s of [detailsSplit, rightSplit, restSplit, branchSplit, outer]) s.element.classList.add('jb-islands');
document.getElementById('app')!.appendChild(h('div.jb-app.lg-app', { class: { 'lg-editor-tab': boot.editorTab } }, outer.element));
for (const s of [rightSplit, outer, detailsSplit]) s.onDidResize(() => preview.layout());

function applyLayout(): void {
  const s = model.settings;
  const showBranches = !boot.hideBranches && s.showBranches;
  branchSplit.setCollapsed(!showBranches);
  strip.classList.toggle('jb-hidden', boot.hideBranches || s.showBranches);
  detailsSplit.setCollapsed(!s.showDetails);
  const right = s.showDiffPreview && s.diffPreviewLocation === 'right';
  const bottom = s.showDiffPreview && s.diffPreviewLocation === 'bottom';
  const host = right ? rightPreviewHost : bottom ? bottomPreviewHost : undefined;
  if (host && preview.element.parentElement !== host) host.appendChild(preview.element);
  // the right preview shares the right column with the changes: give it room when it appears
  if (right && rightSplit.isCollapsed() && restSplit.getSize() < 640) restSplit.setSize(Math.min(Math.max(640, window.innerWidth * 0.5), 1000));
  rightSplit.setCollapsed(!right);
  outer.setCollapsed(!bottom);
  preview.setActive(!!host);
  requestAnimationFrame(() => preview.layout());
}

// ---------------------------------------------------------------- selection → changes / details

let selTimer: ReturnType<typeof setTimeout> | undefined;
let selKey = '';
table.onDidChangeSelection(() => {
  updateToolbars();
  clearTimeout(selTimer);
  selTimer = setTimeout(loadSelection, 60);
});

function loadSelection(force = false): void {
  const rows = table.selectedRows();
  const ids = rows.map((r) => ({ root: model.rootPath(r), hash: r.hash }));
  const key = ids.map((i) => `${i.root}|${i.hash}`).join('\n');
  if (key === selKey && !force) return;
  selKey = key;
  void changes.load(ids);
  if (model.settings.showDetails) void details.show(rows, (r) => model.rootPath(r));
}

changes.onDidSelectFile((f) => void preview.show(f));

// ---------------------------------------------------------------- go to

function showBanner(text: string, link?: { text: string; run(): void }): void {
  banner.replaceChildren(h('span', null, text));
  if (link) banner.append(h('button.jb-link', { type: 'button', onClick: () => {
    hideBanner();
    link.run();
  } }, link.text));
  banner.append(h('button.jb-icon-btn.lg-banner-close', { type: 'button', title: 'Close', onClick: hideBanner }, icon('close')));
  banner.classList.remove('jb-hidden');
  clearTimeout(bannerTimer);
  bannerTimer = setTimeout(hideBanner, 8000);
}
let bannerTimer: ReturnType<typeof setTimeout> | undefined;
function hideBanner(): void {
  banner.classList.add('jb-hidden');
}

async function goTo(text: string, focus = true, root?: string): Promise<void> {
  let res: GoToResult;
  try {
    res = await rpc.call<GoToResult>('goTo', { text, root });
  } catch (e) {
    showBanner(e instanceof Error ? e.message : String(e));
    return;
  }
  if (res.row >= 0) {
    await model.load(res.row, res.row + 1);
    table.selectRow(res.row, { center: true, focus });
    return;
  }
  if (res.message && /doesn't match the filters/.test(res.message)) {
    showBanner(res.message, { text: 'View and reset filters', run: () => void rpc.call('setFilters', {}).then(() => goTo(text, focus, root)) });
  } else showBanner(res.message ?? `Commit or reference '${text}' not found`);
}

async function askGoTo(): Promise<void> {
  const v = await promptDialog({ title: 'Go To Hash/Branch/Tag', label: 'Enter hash or branch/tag name:', placeholder: 'Hash, branch or tag', width: 400 });
  if (v?.trim()) await goTo(v.trim());
}

// ---------------------------------------------------------------- commit context menu

function commitIds(): CommitId[] {
  return table.selectedIds();
}

function runCommitOp(op: CommitOp): void {
  const commits = commitIds();
  if (commits.length) void rpc.call('commitOp', { op, commits });
}

function runAction(id: CommitAction): void {
  const ids = commitIds();
  switch (id) {
    case 'copyHash':
      return table.copyHashes();
    case 'compareVersions':
      if (ids.length === 2) void rpc.call('compareVersions', { commits: ids });
      return;
    case 'compareWithLocal':
      if (ids[0]) void rpc.call('compareWithLocal', ids[0]);
      return;
    case 'goToChild':
      return table.goToChild();
    case 'goToParent':
      return table.goToParent();
    default:
      return runCommitOp(id);
  }
}

function refItemOf(rootIndex: number, name: string, kind: 'local' | 'remote'): RefItem {
  const info = model.refs.find((r) => r.root === model.state.roots[rootIndex]?.root);
  const list = kind === 'local' ? info?.local : info?.remote;
  return list?.find((x) => x.name === name) ?? { name, full: name, hash: '' };
}

function menuCommits(rows: LogRow[]): MenuCommit[] {
  return rows.map((r: LogRow) => ({
    root: r.root,
    hash: r.hash,
    parents: r.parents,
    head: r.head,
    onCurrentBranch: r.onCurrentBranch,
    childRows: r.childRows,
    parentRows: r.parentRows,
    refs: r.refs,
  }));
}

const menuRoots = () => model.state.roots.map((r) => ({ detached: r.detached, branch: r.branch, operation: r.operation }));

function runHistoryAction(action: HistoryAction): void {
  const commits = commitIds();
  if (commits.length) void rpc.call('historyAction', { action, commits });
}

// The history row menu needs the file in the selected revision (renames, deletion) for Get / Show File at Revision /
// Annotate, but a native context menu must be built synchronously inside the right-click: the info is prefetched on
// selection change; while it is unknown those actions stay enabled (the host re-checks and warns).
const historyInfos = new Map<string, HistoryFileInfo>();
let historyDir: boolean | undefined;
const historyKey = (c: CommitId) => `${c.root}|${c.hash}`;

function prefetchHistoryInfo(): void {
  const ids = commitIds();
  if (ids.length !== 1 || historyInfos.has(historyKey(ids[0]))) return;
  const id = ids[0];
  void rpc.call<HistoryFileInfo>('historyInfo', id).then((info) => {
    if (historyInfos.size > 200) historyInfos.clear();
    historyInfos.set(historyKey(id), info);
    historyDir = info.dir;
  }, () => {});
}
if (history) table.onDidChangeSelection(prefetchHistoryInfo);

/** Vcs.FileHistory.ContextMenu of a "History: <file>" tab. */
function historyContextMenu(x: number, y: number): void {
  const rows = table.selectedRows();
  if (!rows.length) return;
  const ids = commitIds();
  let info: HistoryFileInfo | undefined;
  if (ids.length === 1) {
    info = historyInfos.get(historyKey(ids[0]));
    if (!info) {
      prefetchHistoryInfo();
      info = { root: ids[0].root, hash: ids[0].hash, dir: historyDir ?? false, path: historyDir ? undefined : '?', deleted: false, changed: true };
    }
  }
  const entries = buildFileHistoryMenu(menuCommits(rows), menuRoots(), info);
  const items: MenuItem[] = entries.map((e: FileHistoryMenuEntry): MenuItem => {
    if (e === '-') return '-';
    const run = () => {
      switch (e.id) {
        case 'copyHash':
          return table.copyHashes();
        case 'createPatch':
        case 'cherryPick':
        case 'revert':
        case 'fixup':
        case 'squashInto':
        case 'newTag':
          return runCommitOp(e.id);
        default:
          return runHistoryAction(e.id);
      }
    };
    // "Show Diff" reads "Compare" for two revisions: a separate native item
    const id = e.id === 'showDiff' && e.label === 'Compare' ? 'compare' : e.id;
    return { id, label: e.label, shortcut: e.shortcut, disabled: e.disabled, run };
  });
  showContextMenu(items, x, y, { section: 'history' });
}

function commitContextMenu(x: number, y: number): void {
  const rows = table.selectedRows();
  if (!rows.length) return;
  const rootIndex = rows[0].root;
  const root = model.state.roots[rootIndex]?.root ?? '';
  const entries = buildCommitMenu(menuCommits(rows), menuRoots());
  // "Branch 'x'" submenus (one per branch at the commit) can't be static native items: a single "Branch Actions…"
  // item opens them in a popup at the click point
  const branchRefs = entries.flatMap((e) => (typeof e === 'object' && 'branch' in e ? [e.branch] : []));
  const branchMenu = (b: (typeof branchRefs)[number]): MenuItem[] => {
    const kind = b.kind === 'remote' ? 'remote' : 'local';
    return branchActions(kind, b.name, [{ root, item: refItemOf(rootIndex, b.name, kind) }], model.refs);
  };
  const items: MenuItem[] = [];
  for (const e of entries) {
    if (e === '-') items.push('-');
    else if ('branch' in e) {
      if (e.branch !== branchRefs[0]) continue;
      items.push({
        id: 'branchActions',
        label: 'Branch Actions…',
        icon: 'git-branch',
        run: () =>
          void showContextMenu(
            branchRefs.length === 1
              ? [{ header: `Branch '${branchRefs[0].name}'` }, ...branchMenu(branchRefs[0])]
              : branchRefs.map((b): MenuItem => ({ label: `Branch '${b.name}'`, icon: 'git-branch', submenu: () => branchMenu(b) })),
            x,
            y,
            { selectFirst: true },
          ),
      });
    } else if (e.checkoutBranches?.length) {
      const branches = e.checkoutBranches;
      items.push({
        id: 'checkout',
        label: e.label,
        submenu: [
          {
            id: 'branch',
            label: 'Branch…',
            run: () =>
              void showContextMenu(
                branches.map((b): MenuItem => ({ label: b.name, icon: 'git-branch', run: () => void rpc.call('refOp', { op: 'checkout', root, ref: b.name }) })),
                x,
                y,
                { selectFirst: true },
              ),
          },
          { id: 'revision', label: e.revisionLabel ?? 'Checkout Revision', run: () => runAction('checkoutRevision') },
        ],
      });
    } else items.push({ id: e.id, label: e.label, shortcut: e.shortcut, disabled: e.disabled, run: () => runAction(e.id) });
  }
  showContextMenu(items, x, y, { section: 'commits' });
}

// ---------------------------------------------------------------- highlighters

async function updatePicked(): Promise<void> {
  const f = model.state.filters.branches;
  const next = new Set<string>();
  if (highlightNotPicked && f?.length === 1 && f[0] !== 'HEAD') {
    const branch = f[0];
    await Promise.all(
      model.state.roots.map(async (r) => {
        if (!model.state.visibleRoots.includes(r.root) || r.branch === branch) return;
        const hashes = await rpc.call<string[]>('cherryPicked', { root: r.root, branch }).catch(() => [] as string[]);
        for (const hsh of hashes) next.add(`${r.index}|${hsh}`);
      }),
    );
  }
  picked = next;
  table.table.refresh();
}

// ---------------------------------------------------------------- state

function emptyText(s: LogState): EmptyLine[] | string | undefined {
  if (s.error) return ['Error loading commits', s.error];
  if (s.rowCount) return undefined;
  if (s.loading) return 'Loading commits…';
  if (s.filtered) return ['No commits matching filters', [{ text: 'Reset filters', run: () => setFilters({}) }]];
  return ['No changes committed.', [{ text: 'Commit local changes', run: () => void rpc.call('commitLocalChanges') }]];
}

let first = true;
let settingsShown: LogSettings | undefined;

model.onDidChangeState(({ rebuilt, previous }) => {
  const s = model.state;
  if (s.loading) progress.show();
  else while (progress.visible) progress.hide();
  filterBar.update();
  table.setEmptyText(emptyText(s));
  const prevSettings = settingsShown;
  settingsShown = s.settings;
  const rootsChanged = !previous || previous.roots.length !== s.roots.length;
  if (!prevSettings || prevSettings !== s.settings) {
    table.updateSettings(prevSettings, rootsChanged);
    applyLayout();
    if (prevSettings && !prevSettings.showDetails && s.settings.showDetails) loadSelection(true);
  }
  updateToolbars();
  changes.refreshToolbar();
  if (previous && (previous.options.showChangesToParents !== s.options.showChangesToParents || previous.options.showOnlyAffectedChanges !== s.options.showOnlyAffectedChanges)) {
    changes.reload();
  }
  if (rebuilt) {
    void table.rebuilt().then(() => {
      // IntelliJ selects the top commit when the log opens
      if (first && model.slots.length && !table.table.getSelectedIds().length) void model.load(0, 1).then(() => table.selectRow(0));
      if (model.slots.length) first = false;
    });
    if (highlightNotPicked) void updatePicked();
  }
});

model.onDidChangeRefs(() => branches?.render());

rpc.on<{ row: number; hash: string; root: string }>('select', (p) => {
  const apply = () => {
    if (p.row < model.slots.length) {
      void model.load(p.row, p.row + 1);
      table.selectRow(p.row, { center: true, focus: true });
      first = false;
      return true;
    }
    return false;
  };
  if (!apply()) {
    const sub = model.onDidChangeState(() => {
      if (apply()) sub.dispose();
    });
  }
});

rpc.on('focusTextFilter', () => {
  if (document.activeElement === filterBar.text.input) table.focus();
  else filterBar.focusText();
});

// ---------------------------------------------------------------- keyboard

window.addEventListener('keydown', (e) => {
  if (isCtrlCmd(e) && !e.shiftKey && (e.key === 'r' || e.key === 'R')) {
    e.preventDefault();
    void rpc.call('refresh');
  } else if (e.key === 'F5') {
    e.preventDefault();
    void rpc.call('refresh');
  } else if (isCtrlCmd(e) && !e.shiftKey && (e.key === 'f' || e.key === 'F')) {
    e.preventDefault();
    filterBar.focusText();
  } else if (e.key === 'Escape' && document.activeElement === filterBar.text.input && !filterBar.text.value) {
    table.focus();
  }
});
filterBar.text.input.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    table.focus();
  }
});

void model.start().then(() => {
  if (!model.state.rowCount && !model.state.loading) table.setEmptyText(emptyText(model.state));
  table.focus();
});
