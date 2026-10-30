// Branch compare webview ("Comparing <current> with <ref>"): Log tab with the commits that exist only in one of the
// two branches (swappable lists) plus changes/details of the selected commit, and a Files tab with the difference
// between <ref> and the current working tree.
import type { Commit } from '../../core/types';
import type { CommitDetails, CompareInit, CompareLogData } from '../../features/compare/protocol';
import { init, rpc, viewState } from '../shared/rpc';
import { emptyState, ensureStyles, formatPrettyDateTime, h, link, Splitter, Table, Tabs } from '../shared/ui';
import { commitDetails } from '../changes/details';
import { ChangesView, injectCompareCss } from '../changes/view';

ensureStyles();
injectCompareCss(`
.cb-lists { display: flex; flex-direction: column; min-height: 0; height: 100%; }
.cb-list { display: flex; flex-direction: column; min-height: 0; height: 100%; }
.cb-list .cb-table { flex: 1 1 auto; min-height: 0; }
.cb-toolbar { flex: none; display: flex; align-items: center; gap: 6px; padding: 2px 6px; }
.cb-files-header { flex: none; display: flex; align-items: center; gap: 8px; padding: 6px 10px; white-space: nowrap; overflow: hidden; }
.cb-files-header .t { overflow: hidden; text-overflow: ellipsis; }
.cb-pane { display: flex; flex-direction: column; min-height: 0; height: 100%; }
.cb-pane > .jb-tabs { flex: 1 1 auto; }
`);

const data = init<CompareInit>();
let current = data.current;
const ref = data.ref;
let swapped = viewState.get('swapped', false);
let filesSwapped = viewState.get('filesSwapped', false);
let selected: { hash: string; parent: string } | undefined;
let log: CompareLogData = { head: [], base: [] };

const app = document.getElementById('app')!;
const errorEl = h('div.cmp-error.jb-hidden');
const showError = (e: unknown) => {
  errorEl.textContent = e instanceof Error ? e.message : String(e);
  errorEl.classList.remove('jb-hidden');
};

// ---------------------------------------------------------------- Log tab

function commitTable(stateKey: string): Table<Commit> {
  return new Table<Commit>(null, {
    rowId: (c) => c.hash,
    stateKey,
    header: true,
    multiSelect: false,
    className: 'cb-table',
    columns: [
      { id: 'subject', title: 'Subject', flex: true, minWidth: 160, hideable: false, text: (c) => c.subject },
      { id: 'author', title: 'Author', width: 140, text: (c) => c.author },
      { id: 'date', title: 'Date', width: 140, text: (c) => formatPrettyDateTime(c.commitDate) },
      { id: 'hash', title: 'Hash', width: 90, hidden: true, text: (c) => c.hash.slice(0, 8) },
    ],
    rowClass: (c) => (c.parents.length > 1 ? 'jb-dim' : undefined),
    tooltip: (c) => `${c.hash.slice(0, 8)} ${c.subject}\n${c.author} <${c.authorEmail}>`,
    speedSearch: (c) => `${c.subject} ${c.author} ${c.hash}`,
    emptyText: 'Loading…',
  });
}

const tableA = commitTable('compare.a');
const tableB = commitTable('compare.b');
const titleA = h('div.cmp-section-title');
const titleB = h('div.cmp-section-title');
const listA = h('div.cb-list', null, titleA, tableA.element);
const listB = h('div.cb-list', null, titleB, tableB.element);
const lists = new Splitter(null, { orientation: 'vertical', first: listA, second: listB, size: 0.5, proportional: true, min: 60, minOther: 60, stateKey: 'compare.lists' });

const swapBtn = link('Swap branches', () => {
  swapped = !swapped;
  viewState.set('swapped', swapped);
  renderLists();
});
const logLeft = h('div.cb-pane.jb-island', null, h('div.cb-toolbar', null, swapBtn), lists.element);

const details = h('div.cmp-details');
const commitChanges = new ChangesView(null, {
  stateKey: 'compare.commit',
  source: () => (selected ? { from: selected.parent, to: selected.hash } : undefined),
  emptyText: 'Select a commit to see its changes',
  onError: showError,
});
const changesPane = h('div.cb-pane', null, commitChanges.element);
const detailsPane = h('div.cb-pane', null, details);
const right = new Splitter(null, { orientation: 'vertical', first: changesPane, second: detailsPane, size: 160, fixed: 'second', min: 60, minOther: 80, stateKey: 'compare.details' });
const rightIsland = h('div.cb-pane.jb-island', null, right.element);
const logSplit = new Splitter(null, { first: logLeft, second: rightIsland, size: 0.6, proportional: true, min: 200, minOther: 200, stateKey: 'compare.log' });
logSplit.element.classList.add('jb-islands');

const explanation = (a: string, b: string) => `Commits that exist in ${a} but don't exist in ${b} (git log ${b}..${a}):`;

function renderLists(): void {
  // default: commits of <ref> missing in <current> on top
  const top = swapped ? { rows: log.base, a: current, b: ref } : { rows: log.head, a: ref, b: current };
  const bottom = swapped ? { rows: log.head, a: ref, b: current } : { rows: log.base, a: current, b: ref };
  titleA.textContent = explanation(top.a, top.b);
  titleB.textContent = explanation(bottom.a, bottom.b);
  tableA.setEmptyText(`${top.b} contains all commits from ${top.a}`);
  tableB.setEmptyText(`${bottom.b} contains all commits from ${bottom.a}`);
  tableA.setRows(top.rows, { keepSelection: true });
  tableB.setRows(bottom.rows, { keepSelection: true });
}

async function loadLog(): Promise<void> {
  try {
    current = await rpc.call<string>('compare.current');
    log = await rpc.call<CompareLogData>('compare.log');
    errorEl.classList.add('jb-hidden');
  } catch (e) {
    log = { head: [], base: [] };
    showError(e);
  }
  renderLists();
  renderFilesHeader();
  const keep = selected && [...log.head, ...log.base].some((c) => c.hash === selected!.hash);
  if (!keep) {
    const first = tableA.getRows()[0] ?? tableB.getRows()[0];
    if (first) (tableA.getRows()[0] ? tableA : tableB).select([first.hash], { reveal: true });
    else select(undefined);
  }
}

let detailSeq = 0;
async function select(c: Commit | undefined): Promise<void> {
  const seq = ++detailSeq;
  if (!c) {
    selected = undefined;
    details.replaceChildren(emptyState('No commit selected'));
    commitChanges.load();
    return;
  }
  try {
    const d = await rpc.call<CommitDetails>('compare.commit', { hash: c.hash });
    if (seq !== detailSeq) return;
    selected = { hash: c.hash, parent: d.parent };
    details.replaceChildren(
      commitDetails(d.commit, d.branches, {
        copyHash: (hash) => rpc.call('compare.copyHash', { hash }),
        showInLog: (hash) => rpc.call('compare.showInLog', { hash }),
      }),
    );
    commitChanges.load();
  } catch (e) {
    if (seq === detailSeq) showError(e);
  }
}

for (const [t, other] of [[tableA, tableB], [tableB, tableA]] as const) {
  t.onDidChangeSelection((rows) => {
    if (!rows.length) return;
    other.clearSelection();
    select(rows[0]);
  });
  t.onDidActivate(({ row }) => rpc.call('compare.showInLog', { hash: row.hash }));
}

// ---------------------------------------------------------------- Files tab

const filesTitle = h('span.t');
const filesSwap = link('Swap branches', () => {
  filesSwapped = !filesSwapped;
  viewState.set('filesSwapped', filesSwapped);
  renderFilesHeader();
  filesView.load();
});
const filesHeader = h('div.cb-files-header', null, filesTitle, filesSwap);
const filesView = new ChangesView(null, {
  stateKey: 'compare.files',
  source: () => ({ from: ref, swapped: filesSwapped }),
  emptyText: 'No differences',
  onError: showError,
});
const filesPane = h('div.cb-pane.jb-island', null, filesHeader, filesView.element);

function renderFilesHeader(): void {
  filesTitle.textContent = filesSwapped
    ? `Difference between current working tree on ${current} and files in ${ref}:`
    : `Difference between files in ${ref} and current working tree on ${current}:`;
}

// ---------------------------------------------------------------- layout

const logPane = h('div.cb-pane', null, logSplit.element);
const tabs = new Tabs(null, {
  tabs: [
    { id: 'log', label: 'Log', content: logPane },
    { id: 'files', label: 'Files', content: filesPane },
  ],
  active: viewState.get('tab', 'log'),
});
tabs.onDidChange((id) => viewState.set('tab', id));
app.appendChild(h('div.cmp-app', null, errorEl, h('div.cb-pane', null, tabs.element)));

renderFilesHeader();
loadLog();
filesView.load();
rpc.on('refresh', () => {
  loadLog();
  filesView.load();
});
